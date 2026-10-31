import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_CONTROL_TOOLS } from '../../src/cli/app-tools.js';
import { runCli } from '../../src/cli/runner.js';
import type { CliAdapter, CliEvent } from '../../src/cli/types.js';
import { readTerminalToolRejected } from '../../src/cli/failure-metadata.js';
import { checkToolRbac } from '../../src/mcp/app-tools-server.js';
import {
  LarkProductSpecRequestSchema,
  inspectProductSpecRequest,
} from '../../src/core/product-spec.js';
import {
  buildProductSpecApprovalCard,
  buildDeliveryReviewCard,
} from '../../src/im/card.js';
import {
  ensureProductSpecSubmission,
} from '../../src/app/product-spec-submission.js';
import {
  buildCollaborationPrompt,
  collaborationOrigin,
  inferTaskTier,
  MAX_TASK_ESCALATIONS,
  maxTaskTier,
  SeamProbeEngine,
  TechReviewFlowStore,
  TECH_REVIEW_IDLE_TTL_MS,
  EscalationRequestSchema,
  findEscalationRequest,
  SubmitTechReviewRequestSchema,
  findTechReviewSubmission,
  RelayRequestSchema,
  findRelayRequest,
  assembleContextCapsule,
  estimateCapsuleLength,
  detectApprovedSpec,
  checkRelayGuardrails,
  CAPSULE_CHAR_BUDGET,
} from '../../src/core/collaboration.js';
import {
  L0_META_AXIOMS,
  getL1ExperienceRouter,
  buildBotPrompt,
} from '../../src/core/bot-registry.js';
import { ExperienceCandidateStore } from '../../src/core/experience-settlement.js';
import {
  inspectToolExecution,
  protectedConfigLabel,
} from '../../src/core/high-risk-guard.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('TERMINAL_CONTROL_TOOLS includes all control flow tools', () => {
  assert.ok(TERMINAL_CONTROL_TOOLS.includes('request_approval'));
  assert.ok(TERMINAL_CONTROL_TOOLS.includes('request_spec_approval'));
  assert.ok(TERMINAL_CONTROL_TOOLS.includes('request_clarification'));
  assert.ok(TERMINAL_CONTROL_TOOLS.includes('dispatch_task'));
});

test('runCli stops immediately upon receiving terminal control tool call and returns all toolCalls', async () => {
  const singleLineScript = 'console.log(JSON.stringify({ type: "tool_call", toolUseId: "call_1", toolName: "request_spec_approval", input: { deliveryMode: "local", specPath: ".scratch/f/spec.md", ticketsPath: ".scratch/f/tickets.md", title: "Test Spec", summary: "Summary" } })); setTimeout(() => {}, 5000);';

  const customAdapter: CliAdapter = {
    id: 'claude',
    command: process.execPath,
    displayName: 'Mock Claude',
    buildArgs: () => ['-e', singleLineScript],
    buildResumeArgs: () => ['-e', singleLineScript],
    parseEvents: (line: string): CliEvent[] => {
      try {
        const parsed = JSON.parse(line);
        return [parsed];
      } catch {
        return [];
      }
    },
  };

  const result = await runCli({
    adapter: customAdapter,
    prompt: 'test',
    cwd: process.cwd(),
    env: { HARNESS_OS_BOT_ID: 'developer' },
    stopToolNames: [...TERMINAL_CONTROL_TOOLS],
  });

  assert.ok(result.toolCalls);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].toolName, 'request_spec_approval');
});

test('runCli falls back gracefully when child process exits without explicit result event but has recorded toolCalls', async () => {
  const singleLineScript = 'console.log(JSON.stringify({ type: "tool_call", toolUseId: "call_2", toolName: "Read", input: { file_path: "foo.ts" } })); console.log(JSON.stringify({ type: "tool_end", toolUseId: "call_2", failed: false }));';

  const customAdapter: CliAdapter = {
    id: 'claude',
    command: process.execPath,
    displayName: 'Mock Claude',
    buildArgs: () => ['-e', singleLineScript],
    buildResumeArgs: () => ['-e', singleLineScript],
    parseEvents: (line: string): CliEvent[] => {
      try {
        const parsed = JSON.parse(line);
        return [parsed];
      } catch {
        return [];
      }
    },
  };

  const result = await runCli({
    adapter: customAdapter,
    prompt: 'test',
    cwd: process.cwd(),
    env: { HARNESS_OS_BOT_ID: 'developer' },
  });

  assert.ok(result.toolCalls);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].toolName, 'Read');
});

test('checkToolRbac blocks ceo-assistant from direct clarification and gives dispatch guidance', () => {
  const rbac = checkToolRbac('ceo-assistant', 'request_clarification');
  assert.equal(rbac.allowed, false);
  assert.match(rbac.reason ?? '', /RBAC 权限拦截.*product/);
  assert.match(rbac.reason ?? '', /dispatch_task/);
});

test('LarkProductSpecRequestSchema accepts documentUrl without title or summary', () => {
  const parsed = LarkProductSpecRequestSchema.safeParse({
    deliveryMode: 'lark-doc',
    documentUrl: 'https://example.feishu.cn/docx/FAKE_DOC_TOKEN_2',
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.deliveryMode, 'lark-doc');
    assert.equal(parsed.data.documentUrl, 'https://example.feishu.cn/docx/FAKE_DOC_TOKEN_2');
    assert.equal(parsed.data.title, undefined);
  }
});

test('LarkProductSpecRequestSchema accepts wiki documentUrl and rejects non-docx/non-wiki URLs', () => {
  const wikiParsed = LarkProductSpecRequestSchema.safeParse({
    deliveryMode: 'lark-doc',
    documentUrl: 'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_2',
  });
  assert.equal(wikiParsed.success, true);
  if (wikiParsed.success) {
    assert.equal(wikiParsed.data.deliveryMode, 'lark-doc');
    assert.equal(
      wikiParsed.data.documentUrl,
      'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_2',
    );
  }

  const sheetParsed = LarkProductSpecRequestSchema.safeParse({
    deliveryMode: 'lark-doc',
    documentUrl: 'https://example.feishu.cn/sheets/shtcn123456',
  });
  assert.equal(sheetParsed.success, false);
});

test('inspectProductSpecRequest extracts validation error on malformed call', () => {
  const result = inspectProductSpecRequest([
    {
      toolName: 'request_spec_approval',
      input: { deliveryMode: 'local' },
    },
  ]);
  assert.equal(result.hasCall, true);
  assert.equal(result.request, undefined);
  assert.ok(result.lastError);
  assert.match(result.lastError ?? '', /title/);
});

test('buildArbitrationCard and buildProductSpecApprovalCard comply with Feishu Card Schema 2.0 (no textarea)', () => {
  const specCard = buildProductSpecApprovalCard({
    token: 'flow-token-test',
    taskId: 'task-test',
    botId: 'product',
    sessionId: 'session-test',
    ownerOpenId: 'ou_123',
    status: 'pending',
    request: {
      deliveryMode: 'local',
      title: '测试方案',
      summary: '测试摘要',
      specPath: '.scratch/test/spec.md',
      ticketsPath: '.scratch/test/tickets.md',
    },
  });
  const specCardJson = JSON.stringify(specCard);
  assert.doesNotMatch(specCardJson, /"tag":"textarea"/);
  assert.match(specCardJson, /"tag":"input"/);
});

test('Ticket 01: 探讨态放行 - 即使 Prompt 包含强方案关键词，未调用提审工具时不触发重试直接放行', async () => {
  let retryCalled = false;
  // 探讨态：Prompt 包含「编制方案并提审」等高危方案词汇，但模型仅输出纯文本分析，未调用 request_spec_approval
  const explorationSubmission = await ensureProductSpecSubmission({
    result: { answer: '这是关于架构可行性的深度分析报告。' },
    defaultDeliveryMode: 'lark-doc',
    promptText: '请编制示例TS内核产品规格方案(PRD)并提审',
    retry: async () => {
      retryCalled = true;
      throw new Error('探讨态不应触发重试');
    },
  });
  assert.equal(retryCalled, false);
  assert.equal(explorationSubmission.request, undefined);
  assert.equal(
    explorationSubmission.result.answer,
    '这是关于架构可行性的深度分析报告。',
  );
});

test('Ticket 02: 协作转发放行 - 方案类任务中调用 relay_to_peer 时直接放行，不被提审状态机拦截', async () => {
  let retryCalled = false;
  const relayToolCalls = [
    {
      toolName: 'relay_to_peer',
      input: {
        targetBotId: 'developer',
        instruction: '请对方案接口契约做穿刺审查',
        expectedOutput: '技术审查结论',
      },
    },
  ];
  const relaySubmission = await ensureProductSpecSubmission({
    result: {
      answer: '已完成初步调研，现将工件转交给开发工程师继续穿刺。',
      toolCalls: relayToolCalls,
    },
    defaultDeliveryMode: 'lark-doc',
    promptText: '请进行方案调研与PRD编制',
    retry: async () => {
      retryCalled = true;
      throw new Error('协作转发不应触发提审重试');
    },
  });
  assert.equal(retryCalled, false);
  assert.equal(relaySubmission.request, undefined);
  assert.equal(relaySubmission.result.toolCalls?.length, 1);
  const relayReq = findRelayRequest(relaySubmission.result.toolCalls);
  assert.ok(relayReq);
  assert.equal(relayReq.targetBotId, 'developer');
  assert.equal(relayReq.instruction, '请对方案接口契约做穿刺审查');
});

test('Ticket 01 & 03: 参数纠错保障 - request_spec_approval 参数非法时触发针对性重试纠错引导，修正后成功提审', async () => {
  let retryCount = 0;
  let receivedRetryPrompt = '';
  const invalidCall = [
    {
      toolName: 'request_spec_approval',
      input: { deliveryMode: 'local' }, // 缺少 title / summary / specPath / ticketsPath
    },
  ];
  const validCall = [
    {
      toolName: 'request_spec_approval',
      input: {
        deliveryMode: 'local',
        title: '测试方案',
        summary: '方案摘要',
        specPath: '.scratch/test/spec.md',
        ticketsPath: '.scratch/test/tickets.md',
      },
    },
  ];

  const submission = await ensureProductSpecSubmission({
    result: { answer: '方案已生成', toolCalls: invalidCall },
    defaultDeliveryMode: 'local',
    promptText: '方案编制',
    retry: async (retryPrompt) => {
      retryCount++;
      receivedRetryPrompt = retryPrompt;
      return { answer: '已修正参数重新提交', toolCalls: validCall };
    },
  });

  assert.equal(retryCount, 1);
  assert.match(receivedRetryPrompt, /request_spec_approval/);
  assert.match(receivedRetryPrompt, /上一轮调用 request_spec_approval 参数校验失败/);
  assert.ok(submission.request);
  assert.equal(submission.request.title, '测试方案');
  assert.equal(submission.result.answer, '已修正参数重新提交');
});

test('Ticket 01 & 03: 参数纠错保障 - request_spec_approval 重试后仍非法时带标记抛出', async () => {
  const invalidCall = [
    {
      toolName: 'request_spec_approval',
      input: { deliveryMode: 'local' },
    },
  ];

  await assert.rejects(
    async () => {
      await ensureProductSpecSubmission({
        result: { answer: '方案已生成', toolCalls: invalidCall },
        defaultDeliveryMode: 'local',
        promptText: '方案编制',
        retry: async () => ({
          answer: '重试仍缺少参数',
          toolCalls: invalidCall,
        }),
      });
    },
    (err: any) => {
      assert.match(err.message, /产品方案提审参数校验失败/);
      assert.equal(readTerminalToolRejected(err), 'request_spec_approval');
      return true;
    },
  );
});

test('Ticket 01: 参数纠错保障 - 重试被禁用时安全返回原结果，不升级为整轮硬失败', async () => {
  const invalidCall = [
    {
      toolName: 'request_spec_approval',
      input: { deliveryMode: 'local' },
    },
  ];
  const originalResult = { answer: '调研正文内容', toolCalls: invalidCall };

  // 模拟 recon 轮次或 retryDisabled 时返回原结果对象
  const submission = await ensureProductSpecSubmission({
    result: originalResult,
    defaultDeliveryMode: 'local',
    promptText: '只读调研',
    retry: async () => originalResult,
  });

  assert.equal(submission.result, originalResult);
  assert.equal(submission.request, undefined);
});

test('Ticket 03 & 04: buildDeliveryReviewCard and ContextCapsule collaboration prompt', () => {
  const deliveryCard = buildDeliveryReviewCard({
    flow: {
      token: 'flow-deliv-1',
      taskId: 'task-1',
      botId: 'product',
      sessionId: 'sess-1',
      ownerOpenId: 'ou_123',
      status: 'approved',
      request: {
        deliveryMode: 'lark-doc',
        documentUrl: 'https://example.feishu.cn/docx/test1234',
        title: '产品交付方案',
      },
    },
    devSummary: '完成代码重构与单测',
    testPassed: true,
  });
  const delivJson = JSON.stringify(deliveryCard);
  assert.match(delivJson, /研发实施已完成 · 业务验收/);
  assert.match(delivJson, /确认业务验收 \(进入观察期\)/);
  assert.match(delivJson, /立即归档并释放监听/);

  // ContextCapsule 注入测试
  const prompt = buildCollaborationPrompt({
    dispatchId: 'disp-123456',
    taskId: 'task-capsule',
    ownerOpenId: 'ou_123',
    fromBotId: 'ceo-assistant',
    toBotId: 'developer',
    reportToBotId: 'ceo-assistant',
    objective: '实现上下文胶囊协议',
    instruction: '按契约编码',
    round: 1,
    maxRounds: 3,
    workspaceDir: process.cwd(),
    capsule: {
      sourceTaskId: 'task-capsule',
      fromWorkspace: 'harness-os',
      toWorkspace: 'example-project',
      objective: '跨仓推演',
      constraints: ['不得破坏单一事实源', '去物理盘符'],
      distilledDecisionsSummary: '已确认四阶段生命周期方案',
      approvedSpecPointer: 'https://example.feishu.cn/docx/FAKE_DOC_TOKEN_3',
      timestamp: Date.now(),
    },
  });
  assert.match(prompt, /【无状态上下文胶囊 \(ContextCapsule\)】/);
  assert.match(prompt, /去物理盘符/);
  assert.match(prompt, /https:\/\/example\.feishu\.cn\/docx\/FAKE_DOC_TOKEN_3/);
});

test('Ticket 01 & 02: inferTaskTier, SeamProbeEngine and TechReviewFlow lifecycle', () => {
  // S 级轻量任务识别
  assert.equal(inferTaskTier('修复单测报错', '运行 pnpm test 修复 broken 单测'), 'S');
  assert.equal(inferTaskTier('文案微调', '修改首页按钮文字'), 'S');

  // L 级重量任务识别
  assert.equal(inferTaskTier('重构协同总线架构', '实施分级流水线与状态机'), 'L');
  assert.equal(inferTaskTier('系统级认知中枢演进', '对接 DC 与元知知识中枢'), 'L');

  // M 级标准任务识别
  assert.equal(inferTaskTier('新增用户导出功能', '支持导出为 CSV 格式'), 'M');

  // SeamProbeEngine 物理探针：以「声明的物理产物面」为判定单元，无法靠形容词绕过
  const probeBoundary = SeamProbeEngine.calibrateTier({
    declaredTier: 'S',
    objective: '微调文案',
    instruction: '同步更新 CLAUDE.md 与 package.json 中的说明',
  });
  assert.equal(probeBoundary.calibratedTier, 'L');
  assert.equal(probeBoundary.escalated, true);
  assert.ok(probeBoundary.probedPaths.includes('CLAUDE.md'));

  // 假阴性防穿透：声明为“微调”S 级，但物理产物面跨越 4 个文件 → 强制升级 M 级
  const probeBlastRadius = SeamProbeEngine.calibrateTier({
    declaredTier: 'S',
    objective: '微调一下',
    instruction:
      '顺手改 src/core/collaboration.ts、src/index.ts、src/im/card.ts、src/app/runtime.ts',
  });
  assert.equal(probeBlastRadius.calibratedTier, 'M');
  assert.equal(probeBlastRadius.escalated, true);
  assert.equal(probeBlastRadius.probedPaths.length, 4);

  // 真·轻量无害校验：单文件局部修补不触发升级
  const probeHarmless = SeamProbeEngine.calibrateTier({
    declaredTier: 'S',
    objective: '修复单测报错',
    instruction: '修正 tests/unit/session.test.ts 中的断言',
  });
  assert.equal(probeHarmless.calibratedTier, 'S');
  assert.equal(probeHarmless.escalated, false);

  // 物理破坏性操作探针：无论声明为何强制 L 级
  const probeDestructive = SeamProbeEngine.calibrateTier({
    declaredTier: 'S',
    objective: '释放端口',
    instruction: '执行 pm2 restart harness-os',
  });
  assert.equal(probeDestructive.calibratedTier, 'L');
  assert.equal(probeDestructive.escalated, true);

  // TechReviewFlow 状态流转与对抗收敛
  const store = new TechReviewFlowStore();
  const flow = store.create({
    taskId: 'task-review-1',
    title: '协同总线方案',
    summary: '自适应分级方案',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_123',
    workspaceDir: process.cwd(),
    maxRounds: 3,
  });
  assert.equal(flow.status, 'pending');
  assert.equal(flow.round, 1);
  assert.equal(store.findPendingByTaskId('task-review-1')?.token, flow.token);
  assert.equal(store.findPendingByTaskId('task-none'), undefined);

  // Dev 反馈技术对抗意见（第 1 轮）
  const updated1 = store.recordFeedback(flow.token, '缺少单测接缝与回滚策略', false);
  assert.equal(updated1?.round, 2);
  assert.equal(updated1?.status, 'pending');

  // Dev 再次反馈对抗意见（第 2 轮）
  const updated2 = store.recordFeedback(flow.token, '接口字段定义存在冲突', false);
  assert.equal(updated2?.round, 3);
  assert.equal(updated2?.status, 'pending');

  // Dev 达成共识并通过（第 3 轮）
  const approved = store.recordFeedback(flow.token, '方案穿刺通过，接口定义已清晰', true);
  assert.equal(approved?.status, 'approved');
  assert.ok(approved?.resolvedAt);
});

test('回归：SeamProbeEngine 不得因词元截断/斜杠短语产生假阴性或假阳性', () => {
  // 回归 1：package.json / tsconfig.json 曾被扩展名候选顺序截断为 .js，导致冻结边界规则永远失配
  assert.deepEqual(SeamProbeEngine.extractFilePaths('更新 package.json 里的依赖版本'), [
    'package.json',
  ]);
  assert.equal(
    SeamProbeEngine.calibrateTier({
      declaredTier: 'S',
      objective: '微调',
      instruction: '更新 package.json 里的依赖版本',
    }).calibratedTier,
    'L',
  );
  assert.equal(
    SeamProbeEngine.calibrateTier({
      declaredTier: 'S',
      objective: '微调',
      instruction: '调整 tsconfig.json 的编译配置',
    }).escalated,
    true,
  );

  // 回归 2：裸 .env 曾被漏检
  assert.equal(
    SeamProbeEngine.calibrateTier({
      declaredTier: 'S',
      objective: '补充变量',
      instruction: '在 .env 中新增一个开关',
    }).calibratedTier,
    'L',
  );

  // 回归 3：CI/CD、N/A、24/7、S/M/L 等斜杠短语曾被误判为爆炸半径，把文案修补强行拖入完整流水线
  for (const phrase of ['修复 CI/CD 里的 lint 报错', '处理 N/A 分支的显示', '24/7 常驻检查', '按 S/M/L 分级']) {
    const result = SeamProbeEngine.calibrateTier({
      declaredTier: 'S',
      objective: '修复文案',
      instruction: phrase,
    });
    assert.equal(result.probedPaths.length, 0, `斜杠短语不应被当作产物路径: ${phrase}`);
    assert.equal(result.calibratedTier, 'S', `文案修补不应被降级阻断: ${phrase}`);
  }

  // 回归 4：破坏性操作变体必须命中（曾被精确拼写绕过）
  for (const command of ['rm -r -f .scratch', 'git push -f origin master', 'kill -9 1234']) {
    const result = SeamProbeEngine.calibrateTier({
      declaredTier: 'S',
      objective: '清理',
      instruction: command,
    });
    assert.equal(result.calibratedTier, 'L', `破坏性指令必须强制 L 级: ${command}`);
  }
});

test('回归：TechReviewFlow 复用审查流时必须刷新产物指针且保留轮次上限', () => {
  const store = new TechReviewFlowStore();
  const flow = store.create({
    taskId: 'task-rebind',
    specFlowToken: 'spec-v1',
    specPath: '.scratch/a/spec.md',
    title: '方案 v1',
    summary: '摘要 v1',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_1',
    workspaceDir: process.cwd(),
    maxRounds: 3,
  });

  // 修订轮次：交付方式由 local 切换为 lark-doc，指针必须整体替换而非残留旧路径
  const rebound = store.bindSpecFlow(flow.token, {
    specFlowToken: 'spec-v2',
    title: '方案 v2',
    summary: '摘要 v2',
    specDocumentUrl: 'https://example.feishu.cn/docx/rebind123',
  });
  assert.equal(rebound?.specFlowToken, 'spec-v2');
  assert.equal(rebound?.specPath, undefined, '切换为云文档后不得残留本地路径指针');
  assert.equal(rebound?.specDocumentUrl, 'https://example.feishu.cn/docx/rebind123');
  assert.equal(rebound?.title, '方案 v2');

  // 轮次上限不得因重新绑定而重置
  store.recordFeedback(flow.token, '第 1 轮对抗意见', false);
  store.recordFeedback(flow.token, '第 2 轮对抗意见', false);
  assert.equal(store.get(flow.token)?.round, 3);
  store.recordFeedback(flow.token, '第 3 轮对抗意见', false);
  assert.equal(store.get(flow.token)?.status, 'arbitration_needed');
  assert.equal(store.findPendingByTaskId('task-rebind'), undefined);

  // 已终结的审查流不接受新裁决（迟到的重复裁决不得重新唤起已收敛流程）
  assert.equal(store.recordFeedback(flow.token, '迟到的裁决', true), undefined);
});

test('回归：审查流孤儿回收与上下文刷新（话题级 taskId 不得继承陈旧预算/工作区）', () => {
  const store = new TechReviewFlowStore();
  const flow = store.create({
    taskId: 'topic-hash-shared',
    specFlowToken: 'spec-old',
    title: '上一个任务的方案',
    summary: '旧摘要',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_old',
    workspaceDir: '/old/workspace',
    maxRounds: 3,
  });

  // 复用前先把轮次推进到 3，模拟上一个任务已消耗完收敛预算
  store.recordFeedback(flow.token, '旧任务对抗意见 1', false);
  store.recordFeedback(flow.token, '旧任务对抗意见 2', false);
  assert.equal(store.get(flow.token)?.round, 3);

  // 未超时：同一任务链的修订轮次必须继续复用（3 轮上限不被重置）
  assert.equal(store.findPendingByTaskId('topic-hash-shared')?.token, flow.token);

  // 关键回归：创建很久但仍有活动往返的同一任务，绝不能被当作孤儿回收，
  // 否则正常修订会被重置轮次预算，收敛上限沦为永动机。
  const longRunning = store.create({
    taskId: 'topic-slow',
    specFlowToken: 'spec-slow',
    title: '慢速往返方案',
    summary: '摘要',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_1',
    workspaceDir: '/ws',
    maxRounds: 3,
  });
  longRunning.createdAt = Date.now() - TECH_REVIEW_IDLE_TTL_MS * 4;
  store.recordFeedback(longRunning.token, '第 1 轮对抗意见', false);
  assert.equal(
    store.findPendingByTaskId('topic-slow')?.token,
    longRunning.token,
    '长时间跨度的同一任务修订不得被误回收（必须按闲置而非创建时长判定）',
  );
  assert.equal(store.get(longRunning.token)?.round, 2, '轮次预算必须继续累积');

  // 真·闲置：孤儿审查流必须被回收，否则同一话题的下个新任务会继承其陈旧轮次预算
  flow.updatedAt = Date.now() - TECH_REVIEW_IDLE_TTL_MS - 1;
  assert.equal(store.findPendingByTaskId('topic-hash-shared'), undefined);
  assert.equal(store.get(flow.token), undefined, '孤儿流应被物理回收');

  // 物理凭据判定：同话题但原始人类消息不同 → 确认为不同任务，必须回收而非继承轮次预算
  const credentialFlow = store.create({
    taskId: 'topic-with-credential',
    originMessageId: 'om_task_a',
    specFlowToken: 'spec-a',
    title: '任务 A 方案',
    summary: '摘要 A',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_1',
    workspaceDir: '/ws',
    maxRounds: 3,
  });
  // 同一任务的修订轮次：凭据一致 → 复用，轮次预算保留
  assert.equal(
    store.findPendingByTaskId('topic-with-credential', {
      originMessageId: 'om_task_a',
    })?.token,
    credentialFlow.token,
  );
  // 同话题的新任务：凭据不一致 → 回收，新任务从完整预算起步
  assert.equal(
    store.findPendingByTaskId('topic-with-credential', {
      originMessageId: 'om_task_b',
    }),
    undefined,
  );
  assert.equal(store.get(credentialFlow.token), undefined, '异任务流应被物理回收');

  // 重新绑定必须刷新归属与工作区，避免 Dev 被指向上一个任务的工作目录
  const fresh = store.create({
    taskId: 'topic-hash-shared',
    specFlowToken: 'spec-new',
    title: '新任务方案',
    summary: '新摘要',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_old',
    workspaceDir: '/old/workspace',
    maxRounds: 3,
  });
  const rebound = store.bindSpecFlow(fresh.token, {
    specFlowToken: 'spec-newer',
    title: '新任务方案 v2',
    summary: '新摘要 v2',
    specPath: '.scratch/new/spec.md',
    ownerOpenId: 'ou_new',
    ownerUnionId: 'un_new',
    workspaceDir: '/new/workspace',
  });
  assert.equal(rebound?.ownerOpenId, 'ou_new');
  assert.equal(rebound?.ownerUnionId, 'un_new');
  assert.equal(rebound?.workspaceDir, '/new/workspace');
  assert.equal(rebound?.round, 1, '重建的审查流轮次预算必须完整');
});

test('回归：任务链溯源必须携带分级与升级预算', () => {
  const origin = collaborationOrigin({
    dispatchId: 'd1',
    taskId: 't1',
    ownerOpenId: 'ou_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'product',
    reportToBotId: 'ceo-assistant',
    objective: '目标',
    instruction: '指令',
    tier: 'L',
    escalations: 1,
    originMessageId: 'om_human_original',
    round: 2,
    maxRounds: 3,
    workspaceDir: '/ws',
  });
  assert.equal(origin.tier, 'L');
  assert.equal(origin.escalations, 1);
  // 凭据必须随溯源继承：escalation 召回 / 通用续派会产生新的投递消息 id，
  // 若在链路各跳重新落成本跳入站 id，同一任务的重新提交会被误判为「同话题的另一个任务」
  assert.equal(origin.originMessageId, 'om_human_original');
  assert.equal(MAX_TASK_ESCALATIONS, 2);
});

test('批次一：协作转发 schema 不得提供改写授权边界的字段', () => {
  // 转发只能补充 instruction / 期望产出 / 决策摘要；不得改目标、不得换工作区、不得改分级
  const parsed = RelayRequestSchema.parse({
    targetBotId: 'developer',
    instruction: '请对方案接口契约做穿刺审查',
    expectedOutput: '技术审查结论',
    distilledDecisionsSummary: '已确认采用事件驱动',
  });
  assert.equal(parsed.targetBotId, 'developer');
  // schema 层面即拒绝越权字段（strict 由 parse 的未知键剔除体现，故断言其不存在）
  assert.equal(
    (parsed as Record<string, unknown>).objective,
    undefined,
    '转发不得携带 objective —— 目标必须沿原链继承',
  );
  assert.equal(
    (parsed as Record<string, unknown>).targetWorkspace,
    undefined,
    '转发不得更换工作区',
  );

  assert.equal(
    findRelayRequest([
      { toolName: 'Read', input: { file_path: 'a.ts' } },
      { toolName: 'relay_to_peer', input: { targetBotId: 'product', instruction: 'x' } },
    ])?.targetBotId,
    'product',
  );
  assert.equal(findRelayRequest([{ toolName: 'Read', input: {} }]), undefined);
  // 非法 targetBotId 必须被拒
  assert.equal(
    findRelayRequest([
      { toolName: 'relay_to_peer', input: { targetBotId: 'Bad_ID', instruction: 'x' } },
    ]),
    undefined,
  );
});

test('批次二：ContextCapsule 确定性装配与体积上限', () => {
  const capsule = assembleContextCapsule({
    sourceTaskId: 'task-1',
    fromWorkspace: 'example-project',
    toWorkspace: 'harness-os',
    objective: '实现上下文胶囊协议',
    tier: 'L',
    approvedSpecPointer: 'https://example.feishu.cn/docx/FAKE_DOC_TOKEN_3',
    distilledDecisionsSummary: '已确认四阶段生命周期方案',
  });
  assert.equal(capsule.sourceTaskId, 'task-1');
  assert.equal(capsule.fromWorkspace, 'example-project');
  assert.equal(capsule.toWorkspace, 'harness-os');
  assert.equal(capsule.approvedSpecPointer, 'https://example.feishu.cn/docx/FAKE_DOC_TOKEN_3');
  // 分级必须作为刚性约束注入，且明确不可降级
  assert.ok(capsule.constraints.some((c) => /L 级/.test(c) && /不得自行降级/.test(c)));

  // 超预算时必须截断摘要而非丢弃结构化字段
  const huge = assembleContextCapsule({
    sourceTaskId: 'task-2',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '目标',
    tier: 'M',
    distilledDecisionsSummary: '决'.repeat(5_000),
  });
  const totalLength =
    huge.objective.length +
    huge.distilledDecisionsSummary.length +
    huge.constraints.join('').length;
  assert.ok(
    totalLength <= CAPSULE_CHAR_BUDGET,
    `胶囊必须受 ${CAPSULE_CHAR_BUDGET} 字符预算约束，实际 ${totalLength}`,
  );
  assert.ok(huge.distilledDecisionsSummary.includes('已按胶囊预算截断'));
});

test('协作转发护栏：每条护栏都必须真正拒绝（曾因"只设标志不终止"导致全部失效）', () => {
  const chain = {
    reportToBotId: 'ceo-assistant',
    round: 1,
    maxRounds: 16,
    tier: 'M' as const,
    objective: '实现某功能',
  };
  const base = {
    selfBotId: 'product',
    targetBotId: 'developer',
    targetRegistered: true,
    chain,
    instruction: '请实现',
  };

  // 不在链中
  assert.match(
    checkRelayGuardrails({ ...base, chain: undefined }) ?? '',
    /不在任何协作链中/,
  );
  // 目标未注册
  assert.match(
    checkRelayGuardrails({ ...base, targetRegistered: false }) ?? '',
    /未注册或未启用/,
  );
  // 转发给自己
  assert.match(
    checkRelayGuardrails({ ...base, targetBotId: 'product' }) ?? '',
    /当前 bot 自身/,
  );
  // 转发给回传对象（语义上是回传，且会诱发虚假完成）
  assert.match(
    checkRelayGuardrails({ ...base, targetBotId: 'ceo-assistant' }) ?? '',
    /回传对象/,
  );
  // 轮次上限
  assert.match(
    checkRelayGuardrails({
      ...base,
      chain: { ...chain, round: 16, maxRounds: 16 },
    }) ?? '',
    /已达轮次上限/,
  );
  // M/L 门禁：未声明分级按 M 兜底，且无已确认方案指针 → 拒绝
  assert.match(checkRelayGuardrails(base) ?? '', /人类终审前不可直接转交/);
  assert.match(
    checkRelayGuardrails({ ...base, chain: { ...chain, tier: undefined } }) ?? '',
    /人类终审前不可直接转交/,
  );
  // S 级链路可转发给 developer
  assert.equal(
    checkRelayGuardrails({ ...base, chain: { ...chain, tier: 'S' } }),
    undefined,
  );
  // 携带已确认方案指针的 M/L 链路可转发
  assert.equal(
    checkRelayGuardrails({
      ...base,
      instruction: '按已确认方案实现，Spec：.scratch/f/spec.md',
    }),
    undefined,
  );
});

test('回归：胶囊必须在任意输入下受预算约束（不得只截摘要而放过超长 objective）', () => {
  // 审查发现：仅截断摘要时，超长 objective 会让胶囊完全突破上限
  const hugeObjective = assembleContextCapsule({
    sourceTaskId: 't',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '目'.repeat(5_000),
    tier: 'L',
    distilledDecisionsSummary: '摘'.repeat(5_000),
  });
  assert.ok(
    estimateCapsuleLength(hugeObjective) <= CAPSULE_CHAR_BUDGET,
    `超长 objective 必须被截断，实际 ${estimateCapsuleLength(hugeObjective)}`,
  );

  // 超长 constraints 同样必须受约束
  const hugeConstraints = assembleContextCapsule({
    sourceTaskId: 't',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '目标',
    constraints: Array.from({ length: 40 }, (_, i) => `约束${i}`.repeat(100)),
  });
  assert.ok(
    estimateCapsuleLength(hugeConstraints) <= CAPSULE_CHAR_BUDGET,
    `超长 constraints 必须被截断，实际 ${estimateCapsuleLength(hugeConstraints)}`,
  );

  // 截断后缀不得导致溢出（原实现多出 11 字符）
  const boundary = assembleContextCapsule({
    sourceTaskId: 't',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: 'x'.repeat(CAPSULE_CHAR_BUDGET),
  });
  assert.ok(estimateCapsuleLength(boundary) <= CAPSULE_CHAR_BUDGET);

  // 总线绝不自行编造摘要：未提供时必须为空
  const noSummary = assembleContextCapsule({
    sourceTaskId: 't',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '目标',
  });
  assert.equal(noSummary.distilledDecisionsSummary, '');
});

test('回归：派发与转发必须共用同一已确认方案判定（防转发成为侧门）', () => {
  // 仅写「方案」二字自证 → 不通过
  assert.equal(
    detectApprovedSpec({ objective: '实现已确认方案', instruction: '交给 developer' }),
    false,
  );
  // 批准语义 + 具体产物指针 → 通过
  assert.equal(
    detectApprovedSpec({
      objective: '实现已确认的产品方案',
      instruction: '详见 https://example.feishu.cn/docx/AbCd1234',
    }),
    true,
  );
  assert.equal(
    detectApprovedSpec({
      objective: '实现已批准方案',
      instruction: 'Spec：.scratch/feature/spec.md',
    }),
    true,
  );
  // 系统在人类批准后写入的链路目标属权威标记
  assert.equal(
    detectApprovedSpec({
      objective: 'whatever',
      instruction: 'whatever',
      chainObjective: '产品方案已确认：某方案',
    }),
    true,
  );
});

test('批次二：协作提示词必须注入轮次与分级（Agent 自我收敛的前提）', () => {
  const prompt = buildCollaborationPrompt({
    dispatchId: 'd-1',
    taskId: 't-1',
    ownerOpenId: 'ou_1',
    fromBotId: 'product',
    toBotId: 'developer',
    reportToBotId: 'ceo-assistant',
    objective: '方案技术审查',
    instruction: '请穿刺接口契约',
    tier: 'L',
    escalations: 1,
    round: 2,
    maxRounds: 3,
    workspaceDir: '/ws',
  });
  assert.match(prompt, /【协作链路状态】/);
  // 双计数必须**分别**呈现：链跳数管「还能走几跳」，辩证轮数管「还能吵几轮」。
  // 合并成一个数字正是历史上语义塌缩的根源，故此处分别断言。
  assert.match(prompt, /链路跳数：第 2 \/ 3 跳/);
  assert.match(prompt, /辩证轮数：第 1 \/ 3 轮/);
  assert.match(prompt, /任务分级：L 级/);
  assert.match(prompt, /已发生动态升级次数：1 \/ 2/);
  // 必须告知转发的存在与边界，否则链内往复无从发生
  assert.match(prompt, /relay_to_peer/);

  // 末轮必须显式要求收敛，且不再提示转发
  const lastRound = buildCollaborationPrompt({
    dispatchId: 'd-2',
    taskId: 't-1',
    ownerOpenId: 'ou_1',
    fromBotId: 'developer',
    toBotId: 'product',
    reportToBotId: 'ceo-assistant',
    objective: '方案技术审查',
    instruction: '请修订',
    tier: 'L',
    round: 3,
    maxRounds: 3,
    workspaceDir: '/ws',
  });
  assert.match(lastRound, /本轮已是最后一跳/);
  assert.doesNotMatch(lastRound, /可调用 relay_to_peer/);

  // 语义分离：链跳触顶是「熔断终止」，不得被表述成进入仲裁；
  // 辩证触顶才是「进入仲裁」。二者混淆会让 16 跳的发散网退化成 3 轮的辩证界。
  assert.match(lastRound, /触顶将熔断终止整条链/);
  assert.match(lastRound, /触顶将进入仲裁/);
});

test('生产配置硬保护：.env / bots.json / config/*.json 禁止无感知改动', () => {
  // 受保护路径识别
  assert.ok(protectedConfigLabel('.env'));
  assert.ok(protectedConfigLabel('F:\\Project\\harness-os\\.env.local'));
  assert.ok(protectedConfigLabel('config/bots.json'));
  assert.ok(protectedConfigLabel('config/bots.example.json'));
  assert.ok(protectedConfigLabel('config/other.json'));
  assert.equal(protectedConfigLabel('src/core/collaboration.ts'), undefined);

  // 写工具硬拦截
  for (const tool of ['Write', 'Edit']) {
    const blocked = inspectToolExecution(tool, { file_path: 'config/bots.json' });
    assert.equal(blocked.blocked, true, `${tool} 必须被拦截`);
    assert.equal(blocked.matchedPattern, 'PROTECTED_CONFIG_FILE');
    const envBlocked = inspectToolExecution(tool, { file_path: '.env' });
    assert.equal(envBlocked.blocked, true);
  }
  assert.equal(
    inspectToolExecution('NotebookEdit', { notebook_path: 'config/bots.json' })
      .blocked,
    true,
  );
  // 普通源码文件不受影响
  assert.equal(
    inspectToolExecution('Write', { file_path: 'src/app/runtime.ts' }).blocked,
    false,
  );

  // Shell 侧写操作：安全属性是「必须被拦截」，拦截规则可能来自配置保护或通用破坏性命令防御
  for (const command of [
    'echo "{}" > config/bots.json',
    'echo x >> .env',
    'mv config/bots.json /tmp/x',
    'sed -i "s/a/b/" config/bots.json',
    'cp /tmp/evil.json config/bots.json',
    'truncate -s 0 config/bots.json',
  ]) {
    assert.equal(
      inspectToolExecution('Bash', { command }).blocked,
      true,
      `必须拦截: ${command}`,
    );
  }
  // 下列命令仅由「配置保护」这一条规则兜底，必须准确归因，证明确实生效而非被通用规则顺带拦下
  for (const command of [
    'echo "{}" > config/bots.json',
    'mv config/bots.json /tmp/x',
    'sed -i "s/a/b/" config/bots.json',
    'cp /tmp/evil.json config/bots.json',
  ]) {
    assert.equal(
      inspectToolExecution('Bash', { command }).matchedPattern,
      'PROTECTED_CONFIG_SHELL_WRITE',
      `必须由配置保护规则拦截: ${command}`,
    );
  }
  // rm 类由通用破坏性命令防御先行拦截，同样属于「被拦下」，无需归因到配置规则
  assert.equal(
    inspectToolExecution('Bash', { command: 'rm -f config/bots.json' }).blocked,
    true,
  );

  // 只读访问绝不能被误伤，否则会造成审批疲劳
  for (const command of [
    'cat config/bots.json',
    'grep -n collaborationMaxRounds config/bots.json',
    'git diff config/bots.json',
    'ls -la config/',
  ]) {
    assert.equal(
      inspectToolExecution('Bash', { command }).blocked,
      false,
      `只读命令不得被拦截: ${command}`,
    );
  }
});

test('回归：分级在协作链路中单调不降（探针与显式声明均不得降级）', () => {
  // 新任务：无继承等级，采用声明值
  assert.equal(maxTaskTier('S', undefined), 'S');
  assert.equal(maxTaskTier(undefined, 'M'), 'M');
  // 链路已定级 L，某跳显式声明 S → 不得降回 S，否则可绕过 Phase 3
  assert.equal(maxTaskTier('S', 'L'), 'L');
  assert.equal(maxTaskTier('M', 'L'), 'L');
  assert.equal(maxTaskTier('L', 'M'), 'L');
  assert.equal(maxTaskTier('S', 'M'), 'M');

  // 端到端：继承 L 的任务在声明 S 后，探针校准结果必须仍为 L 级
  const inherited = maxTaskTier('S', 'L');
  const calibrated = SeamProbeEngine.calibrateTier({
    declaredTier: inherited,
    objective: '修复文案',
    instruction: '调整提示语',
  });
  assert.equal(calibrated.calibratedTier, 'L');
});

test('回归：召回重入必须继承原任务凭据，不得重置技术审查轮次预算', () => {
  const store = new TechReviewFlowStore();
  const flow = store.create({
    taskId: 'topic-recall',
    originMessageId: 'om_human_original',
    specFlowToken: 'spec-1',
    title: '方案',
    summary: '摘要',
    productBotId: 'product',
    devBotId: 'developer',
    ownerOpenId: 'ou_1',
    workspaceDir: '/ws',
    maxRounds: 3,
  });
  store.recordFeedback(flow.token, '第 1 轮对抗意见', false);
  assert.equal(store.get(flow.token)?.round, 2);

  // 召回后重新提交：凭据继承自原任务 → 复用同一审查流，轮次预算 continue 累积
  const afterRecall = store.findPendingByTaskId('topic-recall', {
    originMessageId: 'om_human_original',
  });
  assert.equal(afterRecall?.token, flow.token);
  assert.equal(afterRecall?.round, 2);
});

test('Ticket 01 动态自愈升级 + Ticket 02 技术审查裁决：结构化门禁解析', () => {
  // 下游穿刺升级门禁
  const escalation = EscalationRequestSchema.safeParse({
    reason: '接口契约涉及跨模块公共 API 与数据库迁移',
    suggestedTier: 'L',
    evidence: 'src/core/session-store.ts 与 3 个 adapter 存在隐式耦合',
  });
  assert.equal(escalation.success, true);
  assert.equal(
    EscalationRequestSchema.safeParse({ reason: '缺少等级', suggestedTier: 'S' }).success,
    false,
  );

  const found = findEscalationRequest([
    { toolName: 'Read', input: { file_path: 'a.ts' } },
    {
      toolName: 'request_escalation',
      input: { reason: '物理复杂度超标', suggestedTier: 'M' },
    },
  ]);
  assert.equal(found?.suggestedTier, 'M');
  assert.equal(findEscalationRequest([{ toolName: 'Read', input: {} }]), undefined);

  // Phase 3 技术审查裁决门禁
  const submission = SubmitTechReviewRequestSchema.safeParse({
    flowToken: 'abc123',
    verdict: 'rejected',
    comment: '缺少回滚策略与单测接缝',
  });
  assert.equal(submission.success, true);

  const rejected = findTechReviewSubmission([
    {
      toolName: 'submit_tech_review',
      input: { flowToken: 'abc123', verdict: 'rejected' },
    },
  ]);
  assert.equal(rejected?.verdict, 'rejected');
  assert.equal(
    findTechReviewSubmission([
      { toolName: 'submit_tech_review', input: { flowToken: 'x', verdict: 'maybe' } },
    ]),
    undefined,
  );
});

test('Ticket 03: L0 Meta Axioms and L1 Experience JIT Router', () => {
  assert.match(L0_META_AXIOMS, /M1 四层治理架构/);
  assert.match(L0_META_AXIOMS, /M10 约束换自主/);
  assert.match(L0_META_AXIOMS, /M13 摩擦驱动演进/);

  // 验证 L1 JIT 路由器按需匹配
  const cardRouter = getL1ExperienceRouter('请帮我修改卡片 button 和 input 组件');
  assert.match(cardRouter, /Feishu Card 2\.0/);

  const spawnRouter = getL1ExperienceRouter('调用 spawn 执行子进程 cmd 命令');
  assert.match(spawnRouter, /Windows Subprocess/);

  const cleanPrompt = buildBotPrompt(
    { role: '开发者', skills: [], systemPrompt: '执行任务' },
    '普通代码重构',
  );
  // L0 稳固在提示词顶层前缀
  assert.ok(cleanPrompt.startsWith(L0_META_AXIOMS));
});

test('Ticket 04: ExperienceCandidateStore records friction and exports to DC Article after 3 hits', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'friction-test-'));
  try {
    const tempStoreFile = join(tempDir, `test-friction-${Date.now()}.json`);
    const store = new ExperienceCandidateStore(tempStoreFile);

    const res1 = await store.recordFriction({
      category: 'CARD_SCHEMA_ERROR',
      details: '非法使用 tag: textarea',
    });
    assert.equal(res1.candidate.hitCount, 1);
    assert.equal(res1.nominated, false);

    const res2 = await store.recordFriction({
      category: 'CARD_SCHEMA_ERROR',
      details: '非法使用 tag: textarea',
    });
    assert.equal(res2.candidate.hitCount, 2);
    assert.equal(res2.nominated, false);

    const targetDir = join(tempDir, 'dc-inbox');
    const res3 = await store.recordFriction({
      category: 'CARD_SCHEMA_ERROR',
      details: '非法使用 tag: textarea',
      targetDcInboxDir: targetDir,
    });
    assert.equal(res3.candidate.hitCount, 3);
    assert.equal(res3.nominated, true);
    assert.ok(res3.exportPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

