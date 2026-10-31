import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueueWaitingCard } from '../../src/im/card.js';

test('P0-2: buildQueueWaitingCard renders rich semantic info and action buttons', () => {
  const card = buildQueueWaitingCard({
    holderId: 'collab:developer:09d97652',
    holderContext: {
      id: 'collab:developer:09d97652',
      botId: 'developer',
      botRole: '开发工程师',
      taskSubject: '执行全流程端到端集成测试与构建',
      startedAt: Date.now() - 45_000,
      lastActivityAt: Date.now() - 3_000,
    },
    queuePosition: 1,
    timeoutMs: 300_000,
    elapsedMs: 45_000,
    isHolderActive: true,
    renewCount: 0,
    mode: 'write',
    sessionId: 'sess-12345678',
    workspacePath: '/mock/workspace',
    canSpawnWorktree: true,
  });

  assert.equal(card.schema, '2.0');
  const header = card.header as any;
  assert.equal(header.template, 'blue');
  assert.equal(header.title.content, '排队等待工作区');
  assert.match(header.subtitle.content, /developer \(开发工程师\)/);

  const body = card.body as any;
  const markdownElem = body.elements[0];
  assert.equal(markdownElem.tag, 'markdown');
  assert.match(markdownElem.content, /developer \(开发工程师\)/);
  assert.match(markdownElem.content, /执行全流程端到端集成测试与构建/);
  assert.match(markdownElem.content, /🟢 \*\*活跃中\*\*/);
  assert.match(markdownElem.content, /队列第 \*\*1\*\* 位/);

  // Check action buttons when canSpawnWorktree is explicitly enabled
  const buttons = body.elements.filter((e: any) => e.tag === 'button');
  assert.equal(buttons.length, 4);
  const buttonLabels = buttons.map((b: any) => b.text.content);
  assert.ok(buttonLabels.includes('继续等待 (+5m)'));
  assert.ok(buttonLabels.includes('转为只读探查'));
  assert.ok(buttonLabels.includes('派生 Worktree 隔离执行'));
  assert.ok(buttonLabels.includes('取消本次排队'));

  // 默认情况下不主动暴露不可靠的 worktree 隔离按钮，保全宿主依赖稳定
  const defaultCard = buildQueueWaitingCard({
    holderId: 'collab:developer:09d97652',
    queuePosition: 1,
    timeoutMs: 300_000,
    sessionId: 'sess-12345678',
    mode: 'write',
  });
  const defaultButtons = (defaultCard.body as any).elements.filter((e: any) => e.tag === 'button');
  assert.equal(defaultButtons.length, 3);
  assert.ok(!defaultButtons.map((b: any) => b.text.content).includes('派生 Worktree 隔离执行'));
});

test('P0-2: buildQueueWaitingCard renders silent warning when holder inactive', () => {
  const card = buildQueueWaitingCard({
    holderId: 'session:stale-holder',
    queuePosition: 2,
    timeoutMs: 300_000,
    elapsedMs: 120_000,
    isHolderActive: false,
    renewCount: 1,
    sessionId: 'sess-waiter',
  });

  const header = card.header as any;
  assert.equal(header.template, 'yellow');
  assert.match(header.subtitle.content, /疑似静默无心跳/);

  const body = card.body as any;
  const markdownElem = body.elements[0];
  assert.match(markdownElem.content, /🟡 \*\*疑似静默\*\*/);
  assert.match(markdownElem.content, /前方 1 个任务等待中/);
  assert.match(markdownElem.content, /已触发 1 次自适应阶梯续期/);
});
