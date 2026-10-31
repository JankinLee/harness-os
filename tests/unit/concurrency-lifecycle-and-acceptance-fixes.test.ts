import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductSpecFlowStore, documentToken } from '../../src/core/product-spec.js';
import { handOffToTechReview } from '../../src/app/product-spec-routing.js';
import { GitWorktreeManager } from '../../src/core/git-worktree-manager.js';
import { reconcileDocumentSubscription } from '../../src/app/lifecycle-runner.js';
import { detectApprovedSpec } from '../../src/core/collaboration.js';
import type { AppRuntime } from '../../src/app/runtime.js';

test('生命周期门禁：方案进入研发(in_development)或交付(delivered)后，绝不再触发 Phase 3 对抗审查', async () => {
  const specStore = new ProductSpecFlowStore();
  const flow = specStore.create({
    taskId: 'topic-delivered-acceptance',
    botId: 'product',
    sessionId: 'sess-1',
    ownerOpenId: 'ou_owner',
    originalMessageId: 'om_orig',
    request: {
      title: '已开发完成特性',
      summary: '验收阶段方案',
      deliveryMode: 'local',
      specPath: '.scratch/spec.md',
    },
  });

  // 模拟被批准进入研发阶段并完成交付
  specStore.approve(flow.token);
  specStore.transitionLifecycle(flow.token, 'approved'); // 跃迁至 in_development
  specStore.transitionLifecycle(flow.token, 'dev_delivered'); // 跃迁至 delivered

  const mockRuntime = {
    techReviewFlows: {
      findPendingByTaskId: () => undefined,
      create: () => ({ token: 'review-1' }),
    },
    botRuntimes: new Map([
      ['developer', { identity: { name: '开发工程师' } }],
    ]),
  } as unknown as AppRuntime;

  // 1. 在 delivered 阶段调用 handOffToTechReview 必须返回 undefined（不触发对抗审查）
  const handoffDelivered = await handOffToTechReview({
    runtime: mockRuntime,
    config: { id: 'product', role: '产品经理' } as any,
    bot: {} as any,
    replyToMessageId: 'msg-1',
    tierContext: { tier: 'M' } as any,
    specFlow: flow,
    workspaceDir: '/workspace',
  });
  assert.equal(handoffDelivered, undefined, '已交付阶段方案严禁触发 Phase 3 技术对抗审查');

  // 2. 在 in_development 阶段调用同样必须返回 undefined
  const devFlow = specStore.create({
    taskId: 'topic-in-dev',
    botId: 'product',
    sessionId: 'sess-2',
    ownerOpenId: 'ou_owner',
    originalMessageId: 'om_orig_2',
    request: {
      title: '研发中特性',
      summary: '进行中方案',
      deliveryMode: 'local',
    },
  });
  specStore.approve(devFlow.token);
  specStore.transitionLifecycle(devFlow.token, 'approved'); // lifecycle 跃迁为 in_development
  const handoffInDev = await handOffToTechReview({
    runtime: mockRuntime,
    config: { id: 'product', role: '产品经理' } as any,
    bot: {} as any,
    replyToMessageId: 'msg-2',
    tierContext: { tier: 'M' } as any,
    specFlow: devFlow,
    workspaceDir: '/workspace',
  });
  assert.equal(handoffInDev, undefined, '处于研发中阶段方案严禁触发 Phase 3 技术对抗审查');
});

test('方案流生命周期感知：同话题泛查询优先命中 in_development 活跃方案，防止跨迭代命中旧交付方案', () => {
  const store = new ProductSpecFlowStore();

  // 方案 A：上一次迭代的方案，已批准且已交付 (delivered)
  const flowA = store.create({
    taskId: 'topic-same',
    botId: 'product',
    sessionId: 'sess-old',
    ownerOpenId: 'ou_owner',
    originalMessageId: 'om_task_a',
    request: {
      title: '旧特性 A (已结项交付)',
      summary: '版本 1.0',
      deliveryMode: 'local',
    },
  });
  store.approve(flowA.token);
  store.transitionLifecycle(flowA.token, 'approved'); // lifecycle -> in_development
  store.transitionLifecycle(flowA.token, 'dev_delivered'); // lifecycle -> delivered

  // 方案 B：本次迭代的新方案，已批准且正在实施中 (in_development)
  const flowB = store.create({
    taskId: 'topic-same',
    botId: 'product',
    sessionId: 'sess-new',
    ownerOpenId: 'ou_owner',
    originalMessageId: 'om_task_b',
    request: {
      title: '新特性 B (当前实施中)',
      summary: '版本 2.0',
      deliveryMode: 'local',
    },
  });
  store.approve(flowB.token);
  store.transitionLifecycle(flowB.token, 'approved'); // lifecycle -> in_development

  // 当调用方未传明确 originMessageId 时（如泛指的「验收最新确认的方案」）：
  // 必须优先命中处于 in_development 活跃实施状态的 flowB，而不是历史已交付的 flowA
  const latest = store.findLatestByTaskId('topic-same', {});
  assert.equal(latest?.token, flowB.token, '同话题泛查询必须优先返回 in_development 活跃方案');
  assert.equal(latest?.request.title, '新特性 B (当前实施中)');
});

test('Worktree 安全清理：解除符号链接绝不递归删除源目录内容', async () => {
  const tempBase = mkdtempSync(join(tmpdir(), 'harness-os-wt-test-'));
  try {
    const sourceRepo = join(tempBase, 'repo');
    const sourceNodeModules = join(sourceRepo, 'node_modules');
    const typeDefDir = join(sourceNodeModules, '@types', 'node');
    mkdirSync(typeDefDir, { recursive: true });
    writeFileSync(join(typeDefDir, 'index.d.ts'), 'declare module "node:crypto";');

    const worktreeDir = join(tempBase, 'worktree');
    mkdirSync(worktreeDir, { recursive: true });
    const targetNodeModules = join(worktreeDir, 'node_modules');

    // 创建测试 symlink/junction
    const { symlinkSync } = await import('node:fs');
    if (process.platform === 'win32') {
      symlinkSync(sourceNodeModules, targetNodeModules, 'junction');
    } else {
      symlinkSync(sourceNodeModules, targetNodeModules, 'dir');
    }

    assert.ok(existsSync(targetNodeModules), '挂载符号链接成功');

    // 调用 GitWorktreeManager.removeWorktree 进行清理
    const manager = GitWorktreeManager.getInstance();
    await manager.removeWorktree(sourceRepo, worktreeDir, false);

    // 关键断言：源仓库的 node_modules/@types/node/index.d.ts 必须完好无损！
    assert.ok(
      existsSync(join(typeDefDir, 'index.d.ts')),
      '安全清理后宿主源仓库依赖必须完好，严禁被递归穿透删除',
    );

    // 进阶断言：测试 sweepStaleWorktrees 同样安全解绑 node_modules（防范同类缺陷只修一半）
    const staleDir = join(sourceRepo, '.claude', 'worktrees', 'feature.stale.123');
    mkdirSync(staleDir, { recursive: true });
    const staleNodeModules = join(staleDir, 'node_modules');
    if (process.platform === 'win32') {
      symlinkSync(sourceNodeModules, staleNodeModules, 'junction');
    } else {
      symlinkSync(sourceNodeModules, staleNodeModules, 'dir');
    }
    assert.ok(existsSync(staleNodeModules), '挂载 stale 符号链接成功');

    await manager.sweepStaleWorktrees(sourceRepo);
    assert.ok(
      existsSync(join(typeDefDir, 'index.d.ts')),
      '巡检清理 .stale 目录后宿主源仓库依赖依然完好无损',
    );
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
});

test('Wiki & 云文档评论全生命周期路由与订阅防退订验证', async () => {
  // 1. documentToken 统一权威真源：同时支持 docx 与 wiki 格式
  assert.equal(
    documentToken('https://example.feishu.cn/docx/FAKE_DOC_TOKEN_1'),
    'FAKE_DOC_TOKEN_1',
  );
  assert.equal(
    documentToken('https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_1'),
    'FAKE_WIKI_TOKEN_1',
    'Wiki 知识库 URL 必须能被 documentToken 准确提取 node_token',
  );

  // 2. findCommentRoutableByDocument 覆盖 in_development 与 wiki 文档
  const store = new ProductSpecFlowStore();
  const wikiFlow = store.create({
    taskId: 'topic-wiki-comment',
    botId: 'product',
    sessionId: 'sess-wiki',
    ownerOpenId: 'ou_owner',
    request: {
      deliveryMode: 'lark-doc',
      documentUrl: 'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_1',
      title: 'Wiki 方案',
      summary: '现场 Wiki 文档方案',
    },
  });

  // A. 方案初稿待确认期 (pending)：评论必须能正常路由承接
  const routablePending = store.findCommentRoutableByDocument('product', 'FAKE_WIKI_TOKEN_1');
  assert.equal(routablePending?.token, wikiFlow.token, '初稿编制期 Wiki 方案必须能路由评论');

  // B. 方案已批准进入研发期 (in_development)：评论全周期承接，由下游 prompt 引导基线锁定答疑
  store.approve(wikiFlow.token);
  store.transitionLifecycle(wikiFlow.token, 'approved'); // lifecycle -> in_development
  const routableInDev = store.findCommentRoutableByDocument('product', 'FAKE_WIKI_TOKEN_1');
  assert.equal(routableInDev?.token, wikiFlow.token, '研发实施期 (in_development) 必须正常承接评论');

  // C. 方案已交付观察期 (delivered)：允许缺陷回流，持续保持就绪
  store.transitionLifecycle(wikiFlow.token, 'dev_delivered'); // lifecycle -> delivered
  const routableDelivered = store.findCommentRoutableByDocument('product', 'FAKE_WIKI_TOKEN_1');
  assert.equal(routableDelivered?.token, wikiFlow.token, '交付观察期 (delivered) 保持评论路由以支持缺陷回流');

  // 3. reconcileDocumentSubscription：所有活跃方案保持订阅，退订严格锚定在归档释放监听时
  let subscribed = false;
  let unsubscribed = false;
  const mockBotRuntime = {
    config: { id: 'product', skills: ['lark-drive'] },
    bot: {
      subscribeToDocumentComments: async () => {
        subscribed = true;
      },
      unsubscribeFromDocumentComments: async () => {
        unsubscribed = true;
      },
    },
  };
  const mockRuntime = {
    productSpecFlows: store,
    botRuntimes: new Map([['product', mockBotRuntime]]),
  } as unknown as AppRuntime;

  await reconcileDocumentSubscription(mockRuntime, 'product');
  assert.equal(subscribed, true, '只要存在活跃方案，必须保持订阅就绪');
  assert.equal(unsubscribed, false, '活跃方案未归档前绝不得误退订');

  // 负向对账：人类点击【立即归档并释放监听】或超时归档后，重新对账必须正确触发退订 (unsubscribed === true)
  store.archive(wikiFlow.token, 'manual_archive');
  await reconcileDocumentSubscription(mockRuntime, 'product');
  assert.equal(unsubscribed, true, '全部方案归档结项后，必须及时物理退订评论监听');
  assert.equal(
    store.findCommentRoutableByDocument('product', 'FAKE_WIKI_TOKEN_1'),
    undefined,
    '已归档方案绝不得再路由任何评论',
  );

  // 4. detectApprovedSpec 支持 Wiki URL
  assert.equal(
    detectApprovedSpec({
      objective: '研发实施任务',
      instruction: '方案已确认，请根据 https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_1 开展实现',
    }),
    true,
    'detectApprovedSpec 必须将 Wiki URL 识别为合法的已确认方案指针',
  );
});
