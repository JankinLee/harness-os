import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
  type LockWaitingInfo,
  WorkspaceLockManager,
} from '../../src/core/workspace-lock-manager.js';

test('WorkspaceLockManager acquires and releases exclusively', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo');

  const executionOrder: string[] = [];

  // Holder 1 acquires
  const release1 = await manager.acquire(wsPath, 'holder-1', 1000);
  assert.equal(manager.isLocked(wsPath), true);
  assert.equal(manager.getHolder(wsPath), 'holder-1');

  // Holder 2 tries to acquire in parallel
  const promise2 = manager.acquire(wsPath, 'holder-2', 2000).then((release2) => {
    executionOrder.push('holder-2-start');
    release2();
    executionOrder.push('holder-2-end');
  });

  executionOrder.push('holder-1-work');
  release1();
  executionOrder.push('holder-1-end');

  await promise2;

  assert.deepEqual(executionOrder, [
    'holder-1-work',
    'holder-1-end',
    'holder-2-start',
    'holder-2-end',
  ]);
  assert.equal(manager.isLocked(wsPath), false);
});

test('WorkspaceLockManager times out when lock not released in time', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-timeout');

  const release1 = await manager.acquire(wsPath, 'collab:developer:09d97652', 1000);

  await assert.rejects(
    async () => {
      await manager.acquire(wsPath, 'session:01234567', 50); // 50ms 超时
    },
    {
      message: /获取工作区写锁超时 \(50ms\): .* 当前被 collab:developer:09d97652 持有/,
    },
  );

  release1();
});

test('WorkspaceLockManager runWithLock ensures finally release on error', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-fail');

  await assert.rejects(async () => {
    await manager.runWithLock(wsPath, 'holder-error', async () => {
      throw new Error('Something crashed during writing');
    });
  });

  // Lock must be atomically released
  assert.equal(manager.isLocked(wsPath), false);
});

test('WorkspaceLockManager defaults to 300s (300,000ms) lock timeout', () => {
  assert.equal(DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS, 300_000);
});

test('WorkspaceLockManager onWaiting callback reports correct queue position and holderId', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-queue');

  const waitingEvents: LockWaitingInfo[] = [];

  // Holder 1 acquires (collab)
  const release1 = await manager.acquire(wsPath, 'collab:developer:09d97652', 5000);
  assert.equal(manager.isLocked(wsPath), true);
  assert.equal(manager.getHolder(wsPath), 'collab:developer:09d97652');

  // Waiter 1 arrives (session A)
  const promiseWaiter1 = manager.acquire(
    wsPath,
    'session:a1b2c3d4',
    5000,
    (info) => {
      waitingEvents.push(info);
    },
  );

  // Waiter 2 arrives (session B)
  const promiseWaiter2 = manager.acquire(
    wsPath,
    'session:e5f6g7h8',
    5000,
    (info) => {
      waitingEvents.push(info);
    },
  );

  assert.equal(waitingEvents.length, 2);
  assert.equal(waitingEvents[0].holderId, 'collab:developer:09d97652');
  assert.equal(waitingEvents[0].queuePosition, 1);
  assert.equal(waitingEvents[0].timeoutMs, 5000);

  assert.equal(waitingEvents[1].holderId, 'collab:developer:09d97652');
  assert.equal(waitingEvents[1].queuePosition, 2);
  assert.equal(waitingEvents[1].timeoutMs, 5000);

  // Release Holder 1 -> Waiter 1 should obtain lock, Waiter 2 queue position updates
  release1();
  const releaseWaiter1 = await promiseWaiter1;
  assert.equal(manager.getHolder(wsPath), 'session:a1b2c3d4');

  // Waiter 2 should have received an update notification that it's now at position 1, held by session:a1b2c3d4
  assert.equal(waitingEvents.length, 3);
  assert.equal(waitingEvents[2].holderId, 'session:a1b2c3d4');
  assert.equal(waitingEvents[2].queuePosition, 1);
  assert.equal(waitingEvents[2].timeoutMs, 5000);

  // Release Waiter 1 -> Waiter 2 should obtain lock
  releaseWaiter1();
  const releaseWaiter2 = await promiseWaiter2;
  assert.equal(manager.getHolder(wsPath), 'session:e5f6g7h8');

  // Release Waiter 2 -> Lock becomes idle
  releaseWaiter2();
  assert.equal(manager.isLocked(wsPath), false);
});

test('WorkspaceLockManager abort signal cancels waiting in queue', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-abort');

  const release1 = await manager.acquire(wsPath, 'collab:developer:09d97652', 5000);

  const controller = new AbortController();
  const abortPromise = manager.acquire(
    wsPath,
    'session:user-abort',
    5000,
    undefined,
    controller.signal,
  );

  // User cancels while waiting in queue
  controller.abort();

  await assert.rejects(abortPromise, {
    message: /Task aborted/,
  });

  // Release holder 1 -> lock is idle and queue is clean
  release1();
  assert.equal(manager.isLocked(wsPath), false);
});

test('WorkspaceLockManager runWithLock supports custom timeout and onWaiting callback', async () => {
  const manager = new WorkspaceLockManager();
  const wsPath = resolve('/mock/repo-run-with-lock');

  let waitingCalled = false;
  const release1 = await manager.acquire(wsPath, 'holder-primary', 2000);

  const taskPromise = manager.runWithLock(
    wsPath,
    'holder-secondary',
    async () => 'finished-secondary',
    2000,
    (info) => {
      waitingCalled = true;
      assert.equal(info.holderId, 'holder-primary');
      assert.equal(info.queuePosition, 1);
    },
  );

  assert.equal(waitingCalled, true);
  release1();

  const result = await taskPromise;
  assert.equal(result, 'finished-secondary');
  assert.equal(manager.isLocked(wsPath), false);
});

test('executeCli integrates semantic holderId and waiting callback', async () => {
  const { executeCli } = await import('../../src/app/cli-execution.js');
  const lockManager = WorkspaceLockManager.getInstance();
  const wsPath = process.cwd();

  // Pre-acquire lock with long-running collab task
  const releaseCollab = await lockManager.acquire(
    wsPath,
    'collab:developer:09d97652',
    5000,
  );

  const mockAdapter: CliAdapter = {
    id: 'claude',
    displayName: 'Mock Claude',
    command: process.execPath,
    buildArgs: () => ['-e', 'process.stdout.write("hello\\n")'],
    buildResumeArgs: () => ['-e', 'process.stdout.write("hello\\n")'],
    parseEvents: () => [
      {
        type: 'result',
        answer: 'ok',
        sessionId: 'sess-mock',
      },
    ],
  };

  const waitingEvents: LockWaitingInfo[] = [];
  let lockAcquiredCalled = false;
  const abortController = new AbortController();

  // Execute CLI in background waiting for the lock
  const execPromise = executeCli(
    mockAdapter,
    'hello',
    wsPath,
    'sess-12345678',
    abortController.signal,
    [],
    () => {},
    { HARNESS_OS_BOT_ID: 'developer' },
    {
      holderId: 'session:sess1234',
      onWaiting: (info) => {
        waitingEvents.push(info);
      },
      onLockAcquired: () => {
        lockAcquiredCalled = true;
      },
    },
  );

  // Should have triggered onWaiting
  assert.equal(waitingEvents.length, 1);
  assert.equal(waitingEvents[0].holderId, 'collab:developer:09d97652');
  assert.equal(waitingEvents[0].queuePosition, 1);
  assert.equal(waitingEvents[0].timeoutMs, DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS);
  assert.equal(lockAcquiredCalled, false);

  // Release the collab lock
  releaseCollab();

  // Execution should complete
  await execPromise;
  assert.equal(lockAcquiredCalled, true);
  assert.equal(lockManager.isLocked(wsPath), false);
});


