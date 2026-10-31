import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  ADAPTIVE_CHECK_WINDOW_MS,
  ADAPTIVE_EXTENSION_MS,
  DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
  HEARTBEAT_ACTIVE_THRESHOLD_MS,
  type LockHolderContext,
  type LockWaitingDetailedInfo,
  MAX_AUTO_RENEW_COUNT,
  WorkspaceLockManager,
} from '../../src/core/workspace-lock-manager.js';

test('P0-1: WorkspaceLockManager stores LockHolderContext and reports detailed onWaiting info', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-semantic');

  const holder1: LockHolderContext = {
    id: 'collab:developer:09d97652',
    botId: 'developer',
    botRole: '开发工程师',
    taskSubject: '全流程自动化构建与深水区 E2E 测试',
    chatId: 'oc_123456',
    threadId: 'omt_abcdef',
    startedAt: Date.now() - 5000,
    lastActivityAt: Date.now(),
  };

  const release1 = await manager.acquire(wsPath, holder1, 5000);
  assert.equal(manager.isLocked(wsPath), true);
  assert.equal(manager.getHolder(wsPath), holder1.id);
  const currentCtx = manager.getHolderContext(wsPath);
  assert.equal(currentCtx?.id, holder1.id);
  assert.equal(currentCtx?.botRole, '开发工程师');
  assert.equal(currentCtx?.taskSubject, '全流程自动化构建与深水区 E2E 测试');

  const waitingEvents: LockWaitingDetailedInfo[] = [];

  const holder2: LockHolderContext = {
    id: 'collab:product:kurapika-1',
    botId: 'product',
    botRole: '产品经理',
    taskSubject: '更新方案',
  };

  const promiseWaiter = manager.acquire(wsPath, holder2, 5000, (info) => {
    waitingEvents.push(info);
  });

  assert.equal(waitingEvents.length, 1);
  const info = waitingEvents[0];
  assert.equal(info.holderId, holder1.id);
  assert.equal(info.queuePosition, 1);
  assert.equal(info.holderContext?.botRole, '开发工程师');
  assert.equal(info.holderContext?.taskSubject, '全流程自动化构建与深水区 E2E 测试');
  assert.equal(info.isHolderActive, true);
  assert.equal(info.mode, 'write');

  // Test touch heartbeat
  const touchSuccess = manager.touch(wsPath, holder1.id);
  assert.equal(touchSuccess, true);
  assert.ok((manager.getHolderContext(wsPath)?.lastActivityAt ?? 0) >= Date.now() - 100);

  const touchWrong = manager.touch(wsPath, 'non-existent');
  assert.equal(touchWrong, false);

  release1();
  const release2 = await promiseWaiter;
  assert.equal(manager.getHolder(wsPath), holder2.id);
  release2();
  assert.equal(manager.isLocked(wsPath), false);
});

test('P1-1: Read-Write Lock allows concurrent readers and blocks writers', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-rw');

  const reader1: LockHolderContext = { id: 'reader-1', mode: 'read' };
  const reader2: LockHolderContext = { id: 'reader-2', mode: 'read' };
  const writer1: LockHolderContext = { id: 'writer-1', mode: 'write' };

  // Reader 1 and Reader 2 acquire concurrently
  const releaseR1 = await manager.acquireRead(wsPath, reader1, 5000);
  const releaseR2 = await manager.acquireRead(wsPath, reader2, 5000);

  assert.equal(manager.isLocked(wsPath), true);

  const order: string[] = [];

  // Writer attempts to acquire and must wait for both readers to finish
  const writerPromise = manager.acquireWrite(wsPath, writer1, 5000).then((releaseW) => {
    order.push('writer-acquired');
    releaseW();
    order.push('writer-released');
  });

  order.push('readers-holding');
  releaseR1();
  order.push('reader1-released');
  releaseR2();
  order.push('reader2-released');

  await writerPromise;

  assert.deepEqual(order, [
    'readers-holding',
    'reader1-released',
    'reader2-released',
    'writer-acquired',
    'writer-released',
  ]);
  assert.equal(manager.isLocked(wsPath), false);
});

test('P1-1: Read-Write Lock write-priority anti-starvation prevents new readers from overtaking waiting writer', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-anti-starvation');

  const reader1: LockHolderContext = { id: 'reader-1', mode: 'read' };
  const writer1: LockHolderContext = { id: 'writer-1', mode: 'write' };
  const reader2: LockHolderContext = { id: 'reader-2', mode: 'read' };

  const releaseR1 = await manager.acquireRead(wsPath, reader1, 5000);

  const order: string[] = [];

  // Writer 1 arrives and waits for Reader 1
  const writerPromise = manager.acquireWrite(wsPath, writer1, 5000).then((releaseW) => {
    order.push('writer1-start');
    releaseW();
    order.push('writer1-end');
  });

  // Reader 2 arrives while Writer 1 is waiting.
  // Because Writer 1 is in queue (write-priority), Reader 2 must NOT bypass Writer 1.
  const reader2Promise = manager.acquireRead(wsPath, reader2, 5000).then((releaseR2) => {
    order.push('reader2-start');
    releaseR2();
    order.push('reader2-end');
  });

  releaseR1();

  await Promise.all([writerPromise, reader2Promise]);

  // writer1 must execute BEFORE reader2
  assert.deepEqual(order, [
    'writer1-start',
    'writer1-end',
    'reader2-start',
    'reader2-end',
  ]);
});

test('P0-3: Manual extension and switchWaiterToRead', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-extend');

  const writer1: LockHolderContext = { id: 'writer-1', mode: 'write' };
  const writer2: LockHolderContext = { id: 'writer-2', mode: 'write' };

  const releaseW1 = await manager.acquire(wsPath, writer1, 5000);

  let latestWaitingInfo: LockWaitingDetailedInfo | undefined;
  const promiseW2 = manager.acquire(wsPath, writer2, 5000, (info) => {
    latestWaitingInfo = info;
  });

  assert.equal(latestWaitingInfo?.timeoutMs, 5000);

  // User clicks "extend wait" (+300s)
  const extended = manager.extendWaitTimeout(wsPath, writer2.id, 300_000);
  assert.equal(extended, true);
  assert.equal(latestWaitingInfo?.timeoutMs, 305_000);
  assert.equal(latestWaitingInfo?.renewCount, 1);

  releaseW1();
  const releaseW2 = await promiseW2;
  releaseW2();
});
