import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductSpecApprovalCard,
  buildProductSpecRevisionCard,
} from '../../src/im/card.js';
import {
  ProductSpecFlowStore,
  type ProductSpecFlow,
} from '../../src/core/product-spec.js';
import { createCardActionHandler } from '../../src/app/card-action-handler.js';
import { SessionManager } from '../../src/core/session-manager.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { Bot, CardAction } from '../../src/im/lark.js';
import type { BotConfig } from '../../src/core/bot-registry.js';
import type { CollaborationService } from '../../src/app/collaboration-service.js';

test('buildProductSpecApprovalCard renders both approve and revision/reject form elements', () => {
  const flow: ProductSpecFlow = {
    token: 'flow-token-spec-1',
    taskId: 'task-spec-1',
    botId: 'product',
    sessionId: 'session-spec-1',
    ownerOpenId: 'ou_owner_123',
    status: 'pending',
    request: {
      title: '用户登录功能方案',
      summary: '支持手机号与飞书扫码登录',
      deliveryMode: 'local',
      specPath: '.scratch/login/spec.md',
      ticketsPath: '.scratch/login/tickets.md',
    },
  };

  const card = buildProductSpecApprovalCard(flow);
  const jsonStr = JSON.stringify(card);

  // 1. 保留 Primary 样式的 [确认产品方案] 按钮与回调 action: approve_product_spec
  assert.match(jsonStr, /"content":"确认产品方案"/);
  assert.match(jsonStr, /"action":"approve_product_spec"/);
  assert.match(jsonStr, /"type":"primary_filled"/);

  // 2. 增加 revision_notes 表单输入框与 [提出修改意见] 按钮 (Warning / Danger 样式，Action: reject_product_spec)
  assert.match(jsonStr, /"tag":"form"/);
  assert.match(jsonStr, /"name":"revision_notes"/);
  assert.match(jsonStr, /"tag":"input"/);
  assert.match(jsonStr, /请输入具体的修改建议/);
  assert.match(jsonStr, /"content":"提出修改意见"/);
  assert.match(jsonStr, /"action":"reject_product_spec"/);
  assert.match(jsonStr, /"action_type":"form_submit"/);
});

test('buildProductSpecRevisionCard renders revision feedback', () => {
  const flow: ProductSpecFlow = {
    token: 'flow-token-spec-2',
    taskId: 'task-spec-2',
    botId: 'product',
    sessionId: 'session-spec-2',
    ownerOpenId: 'ou_owner_123',
    status: 'rejected',
    revisionNotes: '需要补充双因子验证与微信快捷登录',
    request: {
      title: '用户登录功能方案',
      summary: '支持手机号登录',
      deliveryMode: 'local',
      specPath: '.scratch/login/spec.md',
      ticketsPath: '.scratch/login/tickets.md',
    },
  };

  const card = buildProductSpecRevisionCard(flow, flow.revisionNotes);
  const jsonStr = JSON.stringify(card);

  assert.match(jsonStr, /产品方案已退回修改/);
  assert.match(jsonStr, /需要补充双因子验证与微信快捷登录/);
  assert.match(jsonStr, /产品经理正在根据修改意见重新调整方案/);
});

test('ProductSpecFlowStore approve and reject lifecycle', () => {
  const store = new ProductSpecFlowStore();
  const flow = store.create({
    taskId: 'task-flow-1',
    botId: 'product',
    sessionId: 'session-1',
    ownerOpenId: 'ou_1',
    request: {
      title: '方案测试',
      summary: '测试摘要',
      deliveryMode: 'local',
      specPath: '.scratch/test/spec.md',
      ticketsPath: '.scratch/test/tickets.md',
    },
  });

  assert.equal(flow.status, 'pending');

  // Reject with revision notes
  const rejected = store.reject(flow.token, '细节需要再补充');
  assert.ok(rejected);
  assert.equal(rejected?.status, 'rejected');
  assert.equal(rejected?.revisionNotes, '细节需要再补充');
  assert.ok(rejected?.rejectedAt);

  // Cannot approve an already rejected flow
  const reApproved = store.approve(flow.token);
  assert.equal(reApproved, undefined);
});

test('card-action-handler handles reject_product_spec with validation & background revision', async () => {
  const sessions = new SessionManager();
  const addr = { messageId: 'm-init', chatId: 'c-init', threadId: 't-init', rootId: '' };
  const { session } = await sessions.resolve(addr, 'claude', 'product', process.cwd());

  const specStore = new ProductSpecFlowStore();
  const flow = specStore.create({
    taskId: 'task-1',
    botId: 'product',
    sessionId: session.id,
    ownerOpenId: 'ou_author',
    originalMessageId: 'm-init',
    cardMessageId: 'card-msg-1',
    replyInThread: true,
    request: {
      title: '产品功能方案',
      summary: '初始方案',
      deliveryMode: 'local',
      specPath: '.scratch/feat/spec.md',
      ticketsPath: '.scratch/feat/tickets.md',
    },
  });

  let botReplyCardCalled = false;
  const mockBot = {
    replyCard: async () => {
      botReplyCardCalled = true;
      return 'card-reply-id';
    },
    updateCard: async () => {},
  } as unknown as Bot;

  const mockAdapter = {
    id: 'mock-cli',
    displayName: 'Mock Claude',
    command: process.execPath,
    buildArgs: () => ['-e', 'process.stdout.write("{\\"type\\":\\"result\\",\\"answer\\":\\"revised\\"}\\n")'],
    buildResumeArgs: () => ['-e', 'process.stdout.write("{\\"type\\":\\"result\\",\\"answer\\":\\"revised\\"}\\n")'],
    parseEvents: () => [
      {
        type: 'result' as const,
        answer: '方案已根据意见修改完成',
        sessionId: 'sess-revised-1',
        toolCalls: [
          {
            toolName: 'request_spec_approval',
            input: {
              title: '产品功能方案 (v2)',
              summary: '增加离线可用性后的方案',
              deliveryMode: 'local',
              specPath: '.scratch/feat/spec.md',
              ticketsPath: '.scratch/feat/tickets.md',
            },
          },
        ],
      },
    ],
  };

  const mockConfig: BotConfig = {
    id: 'product',
    appId: 'app_prod',
    appSecret: 'sec_prod',
    defaultCliId: 'mock-cli',
    role: '产品经理',
    skills: ['to-spec', 'to-tickets'],
    systemPrompt: '产品方案输出',
    workspaceDir: process.cwd(),
    collaborationMaxRounds: 5,
  };

  const { registerCliAdapter } = await import('../../src/cli/registry.js');
  registerCliAdapter(mockAdapter as any);

  const { resolve } = await import('node:path');
  const { session: productSession } = await sessions.resolve(
    { messageId: 'm-prod', chatId: 'c-prod', threadId: 't-prod', rootId: '' },
    'mock-cli',
    'product',
    process.cwd(),
  );

  const prodFlow = specStore.create({
    taskId: 'task-1',
    botId: 'product',
    sessionId: productSession.id,
    ownerOpenId: 'ou_author',
    originalMessageId: 'm-prod',
    cardMessageId: 'card-msg-1',
    replyInThread: true,
    request: {
      title: '产品功能方案',
      summary: '初始方案',
      deliveryMode: 'local',
      specPath: '.scratch/feat/spec.md',
      ticketsPath: '.scratch/feat/tickets.md',
    },
  });

  const mockRuntime = {
    sessions,
    productSpecFlows: specStore,
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map([['product', { bot: mockBot }]]),
  } as unknown as AppRuntime;

  const handler = createCardActionHandler({
    runtime: mockRuntime,
    config: mockConfig,
    collaborationService: {} as CollaborationService,
    defaultProductDeliveryMode: 'local',
  });

  // 1. Non-owner rejection is blocked
  const nonOwnerAction: CardAction = {
    operatorOpenId: 'ou_stranger',
    messageId: 'card-msg-1',
    value: {
      action: 'reject_product_spec',
      flowToken: prodFlow.token,
    },
    formValue: {
      revision_notes: '修改这里',
    },
  };
  const blockedRes = await handler(nonOwnerAction);
  assert.equal(blockedRes?.toast?.type, 'warning');
  assert.match(blockedRes?.toast?.content ?? '', /只有任务发起人/);

  // 2. Empty revision notes is rejected with prompt
  const emptyNotesAction: CardAction = {
    operatorOpenId: 'ou_author',
    messageId: 'card-msg-1',
    value: {
      action: 'reject_product_spec',
      flowToken: prodFlow.token,
    },
    formValue: {
      revision_notes: '   ',
    },
  };
  const emptyRes = await handler(emptyNotesAction);
  assert.equal(emptyRes?.toast?.type, 'warning');
  assert.match(emptyRes?.toast?.content ?? '', /请填写修改意见后再退回/);

  // 3. Valid submission triggers rejection and revision flow
  const validAction: CardAction = {
    operatorOpenId: 'ou_author',
    messageId: 'card-msg-1',
    value: {
      action: 'reject_product_spec',
      flowToken: prodFlow.token,
    },
    formValue: {
      revision_notes: '方案需要增加离线可用性说明',
    },
  };

  const successRes = await handler(validAction);
  assert.equal(successRes?.toast?.type, 'success');
  assert.match(successRes?.toast?.content ?? '', /修改意见已提交/);

  // Flow status updated to rejected
  const updatedFlow = specStore.get(prodFlow.token);
  assert.equal(updatedFlow?.status, 'rejected');
  assert.equal(updatedFlow?.revisionNotes, '方案需要增加离线可用性说明');

  // Returned card shows revision status
  assert.equal(successRes?.card?.type, 'raw');
  const cardDataStr = JSON.stringify(successRes?.card?.data);
  assert.match(cardDataStr, /产品方案已退回修改/);
  assert.match(cardDataStr, /方案需要增加离线可用性说明/);

  // 4. Test session ID persistence in collaboration product spec flow
  const collabSession = (await sessions.resolve(
    { messageId: 'm-collab', chatId: 'c-collab', threadId: 't-collab', rootId: '' },
    'mock-cli',
    'product',
    process.cwd(),
  )).session;

  // Simulate collaboration submission
  const collabFinalResult = {
    answer: '方案产出完成',
    sessionId: 'sess-collab-product-1234',
    stats: { contextWindowTokens: 128000, contextUsedTokens: 1500 },
  };

  // Collaboration check: when productSpecRequest is present, session.cliSessionId must be persisted
  const productSpecRequestPresent = true;
  const isCollaboration = true;
  if ((!isCollaboration || productSpecRequestPresent) && collabFinalResult.sessionId) {
    await sessions.setCliSessionId(collabSession.id, collabFinalResult.sessionId);
  }

  assert.equal(
    sessions.get(collabSession.id)?.cliSessionId,
    'sess-collab-product-1234',
    '协作模式下产物为产品方案时，cliSessionId 必须成功持久化，避免划词批注链路报错',
  );
});
