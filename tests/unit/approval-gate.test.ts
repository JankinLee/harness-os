import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalFlowStore } from '../../src/core/approval.js';
import { buildApprovalCard } from '../../src/im/card.js';

test('buildApprovalCard only renders approve and reject buttons without scope white-list', () => {
  const store = new ApprovalFlowStore();
  const flow = store.create({
    taskId: 'task-1',
    botId: 'developer',
    sessionId: 'session-1',
    ownerOpenId: 'u1',
    originalMessageId: 'm1',
    replyInThread: true,
    request: {
      operation: 'rm -rf /production/data',
      detail: 'Clear data folder',
      impact: 'Permanent data loss',
      rollback: 'None',
    },
  });

  const card = buildApprovalCard(flow);
  const cardJsonStr = JSON.stringify(card);

  // 绝不能含有 approve_scope 或 签署白名单 交互
  assert.equal(cardJsonStr.includes('approve_scope'), false);
  assert.equal(cardJsonStr.includes('签署白名单'), false);
  assert.equal(cardJsonStr.includes('会话级免审'), false);

  // 必须含有单次放行与拒绝按钮
  assert.equal(cardJsonStr.includes('approve'), true);
  assert.equal(cardJsonStr.includes('reject'), true);
  assert.equal(cardJsonStr.includes('单次执行'), true);
});

test('ApprovalFlowStore enforces 300s timeout Fail-Safe and every high-risk action requires approval', () => {
  const store = new ApprovalFlowStore();

  // Call 1
  const flow1 = store.create({
    taskId: 'task-1',
    botId: 'developer',
    sessionId: 'session-1',
    ownerOpenId: 'u1',
    originalMessageId: 'm1',
    replyInThread: true,
    request: {
      operation: 'systemctl stop prod-service',
      detail: 'Stop service',
      impact: 'Downtime',
      rollback: 'systemctl start',
    },
  });

  assert.equal(flow1.status, 'pending');
  const now = Date.now();
  const expiry = new Date(flow1.expiresAt).getTime();
  const diffSec = Math.round((expiry - now) / 1000);
  assert.equal(diffSec >= 298 && diffSec <= 302, true);

  // Flow 1 is resolved (approved once)
  store.resolve(flow1.token, 'approved');
  assert.equal(store.get(flow1.token)?.status, 'approved');

  // Call 2 (Subsequent high-risk action in the SAME session must ALSO create an independent pending approval)
  const flow2 = store.create({
    taskId: 'task-1',
    botId: 'developer',
    sessionId: 'session-1',
    ownerOpenId: 'u1',
    originalMessageId: 'm2',
    replyInThread: true,
    request: {
      operation: 'drop database test_db',
      detail: 'Drop db',
      impact: 'Loss of db',
      rollback: 'Backup restore',
    },
  });

  // Must be independent pending gate, NOT automatically bypassed
  assert.notEqual(flow1.token, flow2.token);
  assert.equal(flow2.status, 'pending');

  // Fail-Safe on timeout
  const expired = store.expire(flow2.token);
  assert.equal(expired?.status, 'expired');
  assert.equal(store.get(flow2.token)?.status, 'expired');
});
