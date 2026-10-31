import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferTaskTier,
  TechReviewFlowStore,
  DispatchTaskRequestSchema,
} from '../../src/core/collaboration.js';
import {
  L0_META_AXIOMS,
  getL1ExperienceRouter,
  buildBotPrompt,
} from '../../src/core/bot-registry.js';
import { ExperienceCandidateStore } from '../../src/core/experience-settlement.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('Ticket 01: Task Tier Inference and Schema Acceptance', () => {
  assert.equal(inferTaskTier('修复按钮文案拼写错误', '修改 index.html 中 typo'), 'S');
  assert.equal(inferTaskTier('重构多智能体协作总线与流水线架构', '升级 MAS 状态机并新增协议'), 'L');
  assert.equal(inferTaskTier('实现用户登录接口', '增加 oauth 回调处理'), 'M');

  const parsed = DispatchTaskRequestSchema.parse({
    targetBotId: 'developer',
    objective: '修复文案',
    instruction: '修改为正确字样',
    tier: 'S',
  });
  assert.equal(parsed.tier, 'S');
});

test('Ticket 02: TechReviewFlow lifecycle and convergence', () => {
  const store = new TechReviewFlowStore();
  const flow = store.create({
    taskId: 'task-101',
    title: '方案技术审查',
    summary: '审查概要',
    productBotId: 'product',
    devBotId: 'developer',
    maxRounds: 3,
    ownerOpenId: 'ou_xxx',
    workspaceDir: '/tmp',
  });

  assert.equal(flow.status, 'pending');
  assert.equal(flow.round, 1);

  // Round 1 feedback (not approved)
  const afterR1 = store.recordFeedback(flow.token, '接口缺少幂等性字段', false);
  assert.equal(afterR1?.round, 2);
  assert.equal(afterR1?.status, 'pending');

  // Round 2 approved
  const afterR2 = store.recordFeedback(flow.token, '修改后符合要求，批准', true);
  assert.equal(afterR2?.status, 'approved');
});

test('Ticket 03: Cognitive Loop L0 Axioms & L1 JIT Router', () => {
  // L0 核心公理表存在且紧凑
  assert.ok(L0_META_AXIOMS.includes('M10 约束换自主 & 决策充分性'));
  assert.ok(L0_META_AXIOMS.includes('M1 四层治理架构'));

  // L1 动态路由根据触发词精准命中
  const cardRouter = getL1ExperienceRouter('请生成一张飞书卡片 card schema');
  assert.ok(cardRouter.includes('Feishu Card 2.0'));

  const winRouter = getL1ExperienceRouter('在 Windows 下通过 spawn 执行命令');
  assert.ok(winRouter.includes('Windows Subprocess'));

  // buildBotPrompt 包含 L0 公理和 L1 路由
  const prompt = buildBotPrompt(
    {
      role: '开发工程师',
      skills: ['implement-ticket'],
      systemPrompt: '负责代码实现',
    },
    '请修复 Windows 下 spawn 参数转义问题',
  );

  assert.ok(prompt.includes(L0_META_AXIOMS));
  assert.ok(prompt.includes('Windows Subprocess'));
});

test('Ticket 04: Experience Candidate Store records hits and exports to DC article', async () => {
  const tempFile = join(tmpdir(), `test-exp-${randomUUID()}.json`);
  const dcInboxDir = join(tmpdir(), `test-dc-inbox-${randomUUID()}`);
  const store = new ExperienceCandidateStore(tempFile);

  const hit1 = await store.recordHit({
    id: 'exp-1',
    workspaceKey: 'harness-os',
    pattern: 'Feishu Card 2.0 Tag Restriction',
    description: '卡片 input 不能使用 textarea',
  });
  assert.equal(hit1.hitCount, 1);
  assert.equal(hit1.status, 'candidate');

  await store.recordHit({
    id: 'exp-1',
    workspaceKey: 'harness-os',
    pattern: 'Feishu Card 2.0 Tag Restriction',
    description: '卡片 input 不能使用 textarea',
  });
  const hit3 = await store.recordHit({
    id: 'exp-1',
    workspaceKey: 'harness-os',
    pattern: 'Feishu Card 2.0 Tag Restriction',
    description: '卡片 input 不能使用 textarea',
  });

  assert.equal(hit3.hitCount, 3);
  assert.equal(hit3.status, 'nominated');

  const articlePath = await store.exportToDcArticle('exp-1', dcInboxDir);
  assert.ok(articlePath.endsWith('.md'));
});
