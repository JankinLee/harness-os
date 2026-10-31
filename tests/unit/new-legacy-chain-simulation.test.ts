import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArbitrationFlowStore,
  CollaborationInbox,
  NEGOTIATION_MAX_ROUNDS,
  TechReviewFlowStore,
} from '../../src/core/collaboration.js';
import { JsonProductSpecFlowStore } from '../../src/core/product-spec-store.js';
import {
  LIFECYCLE_STALE_MS,
  isCredentiallessRow,
  type ProductSpecFlow,
} from '../../src/core/product-spec.js';
import { findApprovalRequest } from '../../src/core/approval.js';
import { findDispatchTaskRequest } from '../../src/core/collaboration.js';
import {
  mergeToolCallLists,
  repairTerminalToolSubmissions,
} from '../../src/app/terminal-tool-submission.js';
import {
  detectUnhandledTerminalCall,
  skillGatedTerminalTools,
} from '../../src/app/terminal-tool-probe.js';
import { checkToolRbac } from '../../src/core/tool-rbac.js';
import {
  archiveSpecFlow,
  markDeliveredFromDevReport,
  sweepLifecycles,
  wakeQuarantinedFlows,
} from '../../src/app/lifecycle-runner.js';
import { handOffToTechReview } from '../../src/app/product-spec-routing.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { CliRunResult } from '../../src/cli/types.js';

/**
 * 新旧链路串通仿真。
 *
 * 「新链路」＝本轮落地的三件事：终结工具入参纠错（并集合并）、
 * 控制流未承接探针（按成因分流）、宿主侧权限复核；
 * 「旧链路」＝升级前落盘的存量方案行（无任务凭据）与它们共存的四阶段生命周期。
 *
 * 仿真台的价值不在单模块断言，而在**把两侧接在一起跑**：
 * 单模块纯函数全绿并不能证明接线存在（本仓已两次踩中）。
 */

interface Harness {
  runtime: AppRuntime;
  cards: string[];
  subscriptions: string[];
  cleanup: () => void;
}

function makeHarness(specStore?: JsonProductSpecFlowStore): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'new-legacy-sim-'));
  const cards: string[] = [];
  const subscriptions: string[] = [];

  const makeBot = (id: string) => ({
    replyCard: async (_messageId: string, card: unknown) => {
      cards.push(`${id}:${JSON.stringify(card).slice(0, 60)}`);
      return `card-${cards.length}`;
    },
    reply: async () => 'r-1',
    replyMention: async () => 'm-1',
    updateCard: async () => undefined,
    subscribeToDocumentComments: async () => {
      subscriptions.push(`subscribe:${id}`);
    },
    unsubscribeFromDocumentComments: async () => {
      subscriptions.push(`unsubscribe:${id}`);
    },
    appendDocumentSection: async () => true,
  });

  const botRuntimes = new Map(
    ['ceo-assistant', 'product', 'developer'].map((id) => [
      id,
      {
        config: { id, skills: ['lark-drive', 'to-spec', 'grill-me'] },
        bot: makeBot(id),
        identity: { openId: `ou-${id}`, name: id },
      },
    ]),
  );

  const runtime = {
    sessions: { get: () => ({ workspaceDir: process.cwd() }) },
    productSpecFlows: specStore ?? new JsonProductSpecFlowStore(join(dir, 'spec.json')),
    techReviewFlows: new TechReviewFlowStore(),
    arbitrationFlows: new ArbitrationFlowStore(),
    capsuleLog: undefined,
    collaborationInbox: new CollaborationInbox(),
    botRuntimes,
  } as unknown as AppRuntime;

  return {
    runtime,
    cards,
    subscriptions,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function round(toolCalls: Array<{ toolName: string; input: unknown }>, answer = '本轮结论'): CliRunResult {
  return {
    answer,
    sessionId: 's-1',
    toolCalls: toolCalls.map((call, index) => ({ toolUseId: `t-${index}`, ...call })),
  };
}

const VALID_APPROVAL = {
  operation: '重建索引',
  detail: '对 workspace 重建索引',
  impact: '只读期间不可检索',
  rollback: '重跑一次即可',
};

// ────────────────────────────────────────────── 新链路

test('串通·新链路：一轮内「派发写错 + 审批写对」——纠错后两者都必须在场', async () => {
  const original = round([
    { toolName: 'dispatch_task', input: { targetBotId: 'product' } }, // 缺 objective/instruction
    { toolName: 'request_approval', input: VALID_APPROVAL },
  ]);

  const merged = await repairTerminalToolSubmissions({
    result: original,
    retry: async () =>
      round([
        {
          toolName: 'dispatch_task',
          input: { targetBotId: 'product', objective: '补方案', instruction: '按模板补齐' },
        },
      ]),
  });

  assert.deepEqual(
    findDispatchTaskRequest(merged.toolCalls),
    { targetBotId: 'product', objective: '补方案', instruction: '按模板补齐' },
    '写错的调用必须被纠正后生效',
  );
  assert.deepEqual(
    findApprovalRequest(merged.toolCalls),
    VALID_APPROVAL,
    '同批里写**对**的审批请求不得因「整份替换」而消失——那会让高危操作的人工门禁静默失效',
  );
  assert.equal(merged.answer, '本轮结论', '正文以首轮为准');

  // 承接判定：两者都被承接 → 不应告警（误报会把真信号淹掉）
  assert.equal(
    detectUnhandledTerminalCall({
      toolCalls: merged.toolCalls,
      handledToolNames: ['dispatch_task', 'request_approval'],
      skillGatedToolNames: [],
    }),
    undefined,
  );
});

test('串通·新链路：纠错空手而归 → 探针以**准确成因**命中（而不是让人去查技能配置）', async () => {
  const original = round([
    { toolName: 'request_clarification', input: { questions: [] } },
  ]);
  const merged = await repairTerminalToolSubmissions({
    result: original,
    retry: async () => round([], '抱歉，我无法调用该工具'),
  });

  const found = detectUnhandledTerminalCall({
    toolCalls: merged.toolCalls,
    handledToolNames: [],
    skillGatedToolNames: skillGatedTerminalTools({
      grillMeEnabled: true,
      managesProductSpec: true,
    }),
  });
  assert.equal(found?.cause, 'schema');
  assert.match(found?.detail ?? '', /questions/, '必须把 zod 的字段级错误带给人类');
  assert.equal(merged.answer, '本轮结论', '道歉式正文不得覆盖首轮结论');
});

test('串通·新链路：越权调用既**不执行**、也被准确归因为 rbac', () => {
  // 宿主侧权限复核与 MCP 共用同一真源
  assert.equal(checkToolRbac('product', 'request_escalation').allowed, false);
  assert.equal(checkToolRbac('developer', 'request_escalation').allowed, true);

  const found = detectUnhandledTerminalCall({
    toolCalls: [{ toolName: 'request_escalation', input: { reason: '复杂度超标' } }],
    handledToolNames: [], // 宿主复核拒绝 → 不提取 → 未承接
    skillGatedToolNames: [],
    rbacDeniedToolNames: ['request_escalation'],
  });
  assert.equal(found?.cause, 'rbac');
});

// ────────────────────────────────────────────── 旧链路

test('串通·旧链路：存量无凭据行与新任务同处一话题时必须互不干扰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-sim-'));
  const filePath = join(dir, 'spec.json');
  const base = {
    taskId: 'topic-1',
    botId: 'product',
    sessionId: 's-1',
    ownerOpenId: 'ou-human',
    status: 'approved',
    lifecycle: 'in_development',
    lifecycleUpdatedAt: Date.now(),
    request: {
      deliveryMode: 'local',
      title: '方案',
      summary: 's',
      specPath: '.scratch/f/spec.md',
      ticketsPath: '.scratch/f/tickets.md',
    },
  };
  writeFileSync(
    filePath,
    JSON.stringify([
      { ...base, token: 'legacy-1' },
      { ...base, token: 'fresh-1', originalMessageId: 'om_task_new' },
    ]),
    'utf8',
  );

  try {
    const store = new JsonProductSpecFlowStore(filePath);

    assert.equal(
      store.findLatestByTaskId('topic-1', { originMessageId: 'om_task_new' })?.token,
      'fresh-1',
      '新任务必须拿到**自己**的方案，而不是排在更前的存量行',
    );
    assert.equal(
      store.get('legacy-1')?.token,
      'legacy-1',
      '存量行按 token 直取必须仍然可达（人类卡片/归档路径不受隔离影响）',
    );
    assert.equal(
      isCredentiallessRow(store.get('legacy-1')!),
      true,
      '存量行按「无凭据」判定，因此对任务级查询天然不可见',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('串通·旧链路：交付回执找不到在研方案时不得误伤存量行（且必须留痕）', async () => {
  const h = makeHarness();
  try {
    const legacy = h.runtime.productSpecFlows.create({
      taskId: 'topic-1',
      botId: 'product',
      sessionId: 's-1',
      ownerOpenId: 'ou-human',
      // 刻意不给凭据：模拟升级前落盘的存量行
      request: {
        deliveryMode: 'local',
        title: '存量方案',
        summary: 's',
        specPath: '.scratch/f/spec.md',
        ticketsPath: '.scratch/f/tickets.md',
      },
    });
    h.runtime.productSpecFlows.transitionLifecycle(legacy.token, 'approved');

    const delivered = await markDeliveredFromDevReport({
      runtime: h.runtime,
      bot: h.runtime.botRuntimes.get('product')!.bot,
      taskId: 'topic-1',
      fromBotId: 'developer',
      credential: 'om_task_new',
      summary: '新任务的交付简报',
      testPassed: true,
    });

    assert.equal(delivered, undefined, '存量行不得被新任务的交付回执推进');
    assert.equal(
      h.runtime.productSpecFlows.get(legacy.token)?.lifecycle,
      'in_development',
      '存量行必须原样不动（误推进会让它带着假凭据进入验收）',
    );
  } finally {
    h.cleanup();
  }
});

// ────────────────────────────────────────────── 端到端串通

test('串通·端到端：一轮纠错 → 技术审查 → 人类批准 → 交付 → 休眠 → 归档退订', async () => {
  const h = makeHarness();
  try {
    const { runtime } = h;
    const credential = 'om_task_e2e';

    // ① 一轮里既有写坏的终结调用、又有真实的方案提审 → 纠错合并后取到方案请求
    const repaired = await repairTerminalToolSubmissions({
      result: round([
        { toolName: 'relay_to_peer', input: { targetBotId: 'developer', instruction: '' } },
        {
          toolName: 'request_spec_approval',
          input: {
            deliveryMode: 'local',
            title: '端到端方案',
            summary: '串通仿真',
            specPath: '.scratch/sim/spec.md',
            ticketsPath: '.scratch/sim/tickets.md',
          },
        },
      ]),
      retry: async () =>
        round([
          {
            toolName: 'relay_to_peer',
            input: { targetBotId: 'developer', instruction: '补齐转发说明' },
          },
        ]),
    });
    assert.equal(repaired.toolCalls?.length, 3, '并集合并不丢任何一条事实');

    // ② 建立方案流（凭据来自任务发起消息）+ 技术审查移交（M 级）
    const spec = runtime.productSpecFlows.create({
      taskId: 'topic-e2e',
      botId: 'product',
      sessionId: 's-1',
      ownerOpenId: 'ou-human',
      originalMessageId: credential,
      request: {
        deliveryMode: 'local',
        title: '端到端方案',
        summary: '串通仿真',
        specPath: '.scratch/sim/spec.md',
        ticketsPath: '.scratch/sim/tickets.md',
      },
    });
    const handoff = await handOffToTechReview({
      runtime,
      config: runtime.botRuntimes.get('product')!.config,
      bot: runtime.botRuntimes.get('product')!.bot,
      replyToMessageId: 'om_reply',
      tierContext: { tier: 'M', originMessageId: credential },
      specFlow: spec,
      workspaceDir: process.cwd(),
    });
    assert.ok(handoff, 'M 级任务必须移交 Phase 3 技术审查');
    assert.equal(handoff?.maxRounds, NEGOTIATION_MAX_ROUNDS, '辩证收敛界应挂在审查流上');

    // ③ dev 通过审查 → 人类批准 → 生命周期推进
    const review = runtime.techReviewFlows!.get(handoff!.reviewToken);
    assert.ok(review);
    runtime.techReviewFlows!.recordFeedback(review!.token, '接缝无风险', true);
    assert.equal(runtime.techReviewFlows!.get(review!.token)?.status, 'approved');

    runtime.productSpecFlows.approve(spec.token);
    const inDev = runtime.productSpecFlows.transitionLifecycle(spec.token, 'approved');
    assert.equal(inDev?.lifecycle, 'in_development');

    // ④ 交付回执（带同一凭据）→ delivered + 研发简报落档
    const delivered = await markDeliveredFromDevReport({
      runtime,
      bot: runtime.botRuntimes.get('product')!.bot,
      taskId: 'topic-e2e',
      fromBotId: 'developer',
      credential,
      summary: '已按方案实现并自测',
      testPassed: true,
    });
    assert.equal(delivered?.lifecycle, 'delivered');
    assert.equal(
      runtime.productSpecFlows.get(spec.token)?.devReport?.testPassed,
      true,
      '交付事实必须落档（三态校验：未提供 ≠ 通过）',
    );

    // ⑤ 7 天停滞 → 休眠（不改阶段）；人类交互 → 热激活
    await sweepLifecycles({
      runtime,
      now: (delivered!.lifecycleUpdatedAt ?? 0) + LIFECYCLE_STALE_MS,
    });
    assert.equal(runtime.productSpecFlows.get(spec.token)?.quarantined, true);
    assert.equal(runtime.productSpecFlows.get(spec.token)?.lifecycle, 'delivered');
    assert.equal(await wakeQuarantinedFlows({ runtime, taskId: 'topic-e2e' }), 1);

    // ⑥ 14 天 → 自动归档（行删除 + 释放云文档监听）
    const woken = runtime.productSpecFlows.get(spec.token)!;
    await sweepLifecycles({
      runtime,
      now: (woken.lifecycleUpdatedAt ?? 0) + LIFECYCLE_STALE_MS * 3,
    });
    assert.equal(runtime.productSpecFlows.get(spec.token), undefined, '归档即删除行');
    assert.ok(
      h.subscriptions.some((entry) => entry.startsWith('unsubscribe:')),
      '归档是「释放监听」的唯一时刻，必须触发退订对账',
    );

    // ⑦ 归档通道①：人工点击同样收敛到同一实现
    const second = runtime.productSpecFlows.create({
      taskId: 'topic-e2e-2',
      botId: 'product',
      sessionId: 's-1',
      ownerOpenId: 'ou-human',
      originalMessageId: 'om_task_e2e_2',
      request: spec.request,
    });
    assert.equal(
      await archiveSpecFlow({
        runtime,
        bot: runtime.botRuntimes.get('product')!.bot,
        flow: second as ProductSpecFlow,
        channel: 'manual',
        deliverCard: false,
      }),
      true,
    );
    assert.equal(runtime.productSpecFlows.get(second.token), undefined);
  } finally {
    h.cleanup();
  }
});

test('串通·合并语义：无重试时不得重复记账（潜伏缺陷防线）', () => {
  const calls = [{ toolUseId: 'c1', toolName: 'request_approval', input: VALID_APPROVAL }];
  assert.equal(mergeToolCallLists(calls, calls).length, 1);
});
