import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARBITRATION_SUSPEND_MS,
  ArbitrationFlowStore,
  COLLABORATION_MAX_ROUNDS,
  NEGOTIATION_MAX_ROUNDS,
  TechReviewFlowStore,
  type CollaborationMessage,
} from '../../src/core/collaboration.js';
import { ProductSpecFlowStore, LIFECYCLE_STALE_MS } from '../../src/core/product-spec.js';
import { CollaborationInbox } from '../../src/core/collaboration.js';
import {
  ARBITRATION_PRELIMINARY_TTL_MS,
  circuitBreakChain,
  openArbitration,
  resumeAfterArbitration,
  sweepArbitrations,
  wakeSuspendedArbitrations,
  type OpenArbitrationOptions,
} from '../../src/app/arbitration-runner.js';
import {
  archiveSpecFlow,
  reconcileDocumentSubscription,
  sweepLifecycles,
  wakeQuarantinedFlows,
} from '../../src/app/lifecycle-runner.js';
import type { AppRuntime } from '../../src/app/runtime.js';

/**
 * 全链路仿真台。
 *
 * 目的不是替代真实端到端，而是把**宿主侧的状态机串起来跑一遍**——
 * 单模块纯函数全绿并不能证明接线存在（这正是本仓错题本反复点名的形态）。
 */

interface Harness {
  runtime: AppRuntime;
  cards: Array<{ to: string; title: string }>;
  subscriptions: string[];
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'chain-sim-'));
  const cards: Array<{ to: string; title: string }> = [];
  const subscriptions: string[] = [];

  const makeBot = (id: string) => ({
    replyCard: async (messageId: string, card: unknown) => {
      const json = JSON.stringify(card);
      cards.push({
        to: id,
        title: /"content":"([^"]{0,60})/.exec(json)?.[1] ?? json.slice(0, 40),
      });
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
        config: { id, skills: ['lark-drive'] },
        bot: makeBot(id),
        identity: { openId: `ou-${id}`, name: id },
      },
    ]),
  );

  const runtime = {
    sessions: {
      get: () => ({ workspaceDir: process.cwd() }),
    },
    productSpecFlows: new ProductSpecFlowStore(),
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

function makeSpecFlow(
  runtime: AppRuntime,
  overrides: Partial<Parameters<AppRuntime['productSpecFlows']['create']>[0]> = {},
) {
  return runtime.productSpecFlows.create({
    taskId: 'topic-1',
    botId: 'product',
    sessionId: 's-1',
    ownerOpenId: 'ou-human',
    originalMessageId: 'om-task-1',
    request: {
      deliveryMode: 'local',
      title: '仿真方案',
      summary: '全链路仿真',
      specPath: '.scratch/sim/spec.md',
      ticketsPath: '.scratch/sim/tickets.md',
    },
    ...overrides,
  });
}

test('全链路仿真 · 主链：Phase 1→3→4→5 一路走到归档', async () => {
  const h = makeHarness();
  try {
    const { runtime } = h;
    // Phase 1-2：product 产出方案
    const spec = makeSpecFlow(runtime);

    // Phase 3：技术审查流建立（handOffToTechReview 的等价位）
    const review = runtime.techReviewFlows!.create({
      taskId: spec.taskId,
      originMessageId: spec.originalMessageId,
      specFlowToken: spec.token,
      title: '仿真方案',
      summary: '全链路仿真',
      productBotId: 'product',
      devBotId: 'developer',
      maxRounds: NEGOTIATION_MAX_ROUNDS,
      ownerOpenId: spec.ownerOpenId,
      workspaceDir: process.cwd(),
    });
    assert.equal(review.round, 1);

    // Phase 3：dev 提出对抗意见 → 退回 product（辩证第 1 轮）
    const rejectedRound = runtime.techReviewFlows!.recordFeedback(
      review.token,
      '接口契约与适配层冲突',
      false,
    );
    assert.equal(rejectedRound?.status, 'pending');
    assert.equal(rejectedRound?.round, 2, '退回修正消耗一轮辩证额度');

    // Phase 3：第 2 轮通过 → 进入 Phase 4
    const approved = runtime.techReviewFlows!.recordFeedback(
      review.token,
      '已对齐接口契约',
      true,
    );
    assert.equal(approved?.status, 'approved');

    // Phase 4：人类放行 → 生命周期与审批态同时推进
    runtime.productSpecFlows.approve(spec.token);
    const inDev = runtime.productSpecFlows.transitionLifecycle(spec.token, 'approved');
    assert.equal(inDev?.lifecycle, 'in_development');

    // Phase 5：dev 交付回传 → delivered
    const delivered = runtime.productSpecFlows.transitionLifecycle(
      spec.token,
      'dev_delivered',
    );
    assert.equal(delivered?.lifecycle, 'delivered');

    // 两段式验收第一段：人类确认验收（不改变阶段，只记录观察起点）
    const accepted = runtime.productSpecFlows.transitionLifecycle(spec.token, 'accepted');
    assert.equal(accepted?.lifecycle, 'delivered');
    assert.ok(accepted?.acceptedAt, '验收必须留下观察期起点');

    // 归档通道①：人工点击 → 终态 + 释放监听
    const bot = runtime.botRuntimes.get('product')!.bot;
    const ok = await archiveSpecFlow({
      runtime,
      bot,
      flow: accepted!,
      channel: 'manual',
      deliverCard: false,
    });
    assert.equal(ok, true);
    assert.equal(runtime.productSpecFlows.get(spec.token), undefined, '归档后行必须被删除');
    assert.ok(
      h.subscriptions.includes('unsubscribe:product'),
      '归档是「释放监听」的唯一时刻，必须触发退订对账',
    );
  } finally {
    h.cleanup();
  }
});

test('全链路仿真 · 辩证触顶 → 三层仲裁链 → 人类裁决', async () => {
  const h = makeHarness();
  try {
    const { runtime } = h;
    const spec = makeSpecFlow(runtime);
    const review = runtime.techReviewFlows!.create({
      taskId: spec.taskId,
      originMessageId: spec.originalMessageId,
      title: '争议方案',
      summary: 's',
      productBotId: 'product',
      devBotId: 'developer',
      maxRounds: NEGOTIATION_MAX_ROUNDS,
      ownerOpenId: spec.ownerOpenId,
      workspaceDir: process.cwd(),
    });

    // 连续打回直到辩证界触顶
    for (let round = 0; round < NEGOTIATION_MAX_ROUNDS; round += 1) {
      runtime.techReviewFlows!.recordFeedback(review.token, `第 ${round + 1} 轮对抗`, false);
    }
    assert.equal(
      runtime.techReviewFlows!.get(review.token)?.status,
      'arbitration_needed',
      '辩证界触顶必须置为待仲裁',
    );

    // 第一层：建流并委派 ceo 初裁
    const opened = await openArbitration({
      runtime,
      config: runtime.botRuntimes.get('developer')!.config,
      bot: runtime.botRuntimes.get('developer')!.bot,
      replyToMessageId: 'msg-1',
      taskId: spec.taskId,
      objective: '争议方案',
      instruction: '双方论点',
      contradictionReason: '辩证触顶',
      round: 3,
      maxRounds: COLLABORATION_MAX_ROUNDS,
      negotiationRound: NEGOTIATION_MAX_ROUNDS,
      negotiationMaxRounds: NEGOTIATION_MAX_ROUNDS,
      ownerOpenId: spec.ownerOpenId,
      workspaceDir: process.cwd(),
      originalMessageId: spec.originalMessageId,
      trigger: 'negotiation',
    } as OpenArbitrationOptions);
    assert.ok(opened);
    assert.equal(opened?.status, 'pending_preliminary', '第一层不得直接推给人类');
    assert.equal(opened?.trigger, 'negotiation');

    // 第一层超时 → 上浮人类（且不产生初裁结论）
    await sweepArbitrations({
      runtime,
      now: Date.now() + ARBITRATION_PRELIMINARY_TTL_MS + 1,
    });
    const uplifted = runtime.arbitrationFlows!.get(opened!.token);
    assert.equal(uplifted?.status, 'pending_human');
    assert.equal(uplifted?.preliminaryVerdict, undefined);

    // 人类继续静默 → 休眠（绝不自动推进）
    await sweepArbitrations({
      runtime,
      now:
        Date.now() + ARBITRATION_PRELIMINARY_TTL_MS + ARBITRATION_SUSPEND_MS + 2,
    });
    assert.equal(runtime.arbitrationFlows!.get(opened!.token)?.status, 'suspended');

    // 人类交互 → 热激活 → 裁决
    const woken = await wakeSuspendedArbitrations({ runtime, taskId: spec.taskId });
    assert.equal(woken, 1, '人类任意交互必须唤醒休眠仲裁');
    const resolved = runtime.arbitrationFlows!.resolve(opened!.token, {
      selectedOption: 'adopt_product',
    });
    assert.equal(resolved?.status, 'resolved');
    await resumeAfterArbitration({
      runtime,
      bot: runtime.botRuntimes.get('ceo-assistant')!.bot,
      flow: resolved!,
      decision: 'adopt_product',
    });
    // 裁决后续跑：链跳数继续累加，辩证轮数重置
    const resumed = [...runtime.collaborationInbox['messages'].values()].pop() as
      | CollaborationMessage
      | undefined;
    assert.equal(resumed?.round, resolved!.round + 1, '链跳数必须继续累加而非重置');
    assert.equal(resumed?.negotiationRound, 1, '裁决后辩证轮数重新起算');
  } finally {
    h.cleanup();
  }
});

test('全链路仿真 · 发散网熔断是终止而非仲裁，且级联清理', async () => {
  const h = makeHarness();
  try {
    const { runtime } = h;
    const spec = makeSpecFlow(runtime);
    // 两态必须区别对待：
    // · pending_preliminary（等 ceo）—— 链路已终结，争议随之作废，**应当**回收；
    // · pending_human（人类面前有卡片）—— 抹掉它就是点了没反应的死按钮，**不得**回收。
    const waitingCeo = runtime.arbitrationFlows!.create({
      taskId: spec.taskId,
      fromBotId: 'product',
      toBotId: 'ceo-assistant',
      reportToBotId: 'ceo-assistant',
      objective: '尚未初裁的争议',
      instruction: 'i',
      contradictionReason: 'c',
      round: 5,
      maxRounds: COLLABORATION_MAX_ROUNDS,
      ownerOpenId: 'ou-human',
      workspaceDir: process.cwd(),
      originalMessageId: spec.originalMessageId,
    });
    const arb = runtime.arbitrationFlows!.create({
      taskId: spec.taskId,
      fromBotId: 'product',
      toBotId: 'ceo-assistant',
      reportToBotId: 'ceo-assistant',
      objective: '已推到人类面前的争议',
      instruction: 'i',
      contradictionReason: 'c',
      round: 5,
      maxRounds: COLLABORATION_MAX_ROUNDS,
      ownerOpenId: 'ou-human',
      workspaceDir: process.cwd(),
      originalMessageId: spec.originalMessageId,
    });
    runtime.arbitrationFlows!.recordPreliminary(arb.token, {
      verdict: 'abstain',
      reasoning: '超出授权边界',
    });
    runtime.techReviewFlows!.create({
      taskId: spec.taskId,
      originMessageId: spec.originalMessageId,
      title: 't',
      summary: 's',
      productBotId: 'product',
      devBotId: 'developer',
      maxRounds: NEGOTIATION_MAX_ROUNDS,
      ownerOpenId: 'ou-human',
      workspaceDir: process.cwd(),
    });

    await circuitBreakChain({
      runtime,
      bot: runtime.botRuntimes.get('ceo-assistant')!.bot,
      replyToMessageId: 'msg-1',
      ownerOpenId: 'ou-human',
      taskId: spec.taskId,
      objective: '长程发散任务',
      round: COLLABORATION_MAX_ROUNDS,
      maxRounds: COLLABORATION_MAX_ROUNDS,
      reason: '触顶',
    });

    // 熔断是终止：不建任何仲裁流，且对人类待办只做「保留」而非「抹除」
    assert.ok(
      runtime.arbitrationFlows!.get(arb.token),
      '熔断不得抹掉人类正在裁决的争议（那是点了没反应的死按钮）',
    );
    assert.equal(
      runtime.arbitrationFlows!.get(waitingCeo.token),
      undefined,
      '链路已终结，尚未初裁的争议应随之作废（避免 ceo 拿着失效编号回传）',
    );
    assert.equal(
      runtime.techReviewFlows!.get([...runtime.techReviewFlows!['flows'].keys()][0]!),
      undefined,
      '代理侧在途的审查流必须被回收',
    );
  } finally {
    h.cleanup();
  }
});

test('全链路仿真 · 生命周期两档：7 天休眠（本地忽略）→ 14 天归档', async () => {
  const h = makeHarness();
  try {
    const { runtime } = h;
    const spec = makeSpecFlow(runtime);
    runtime.productSpecFlows.approve(spec.token);
    runtime.productSpecFlows.transitionLifecycle(spec.token, 'approved');
    const delivered = runtime.productSpecFlows.transitionLifecycle(
      spec.token,
      'dev_delivered',
    )!;
    await reconcileDocumentSubscription(runtime, 'product');

    // 7 天：进入停滞休眠（PRD §2.2.3 的原始对象就是 delivered）
    await sweepLifecycles({
      runtime,
      now: (delivered.lifecycleUpdatedAt ?? 0) + LIFECYCLE_STALE_MS,
    });
    const sleeping = runtime.productSpecFlows.get(spec.token);
    assert.equal(sleeping?.quarantined, true, 'delivered 必须在 7 天档真的进入休眠');
    assert.equal(
      sleeping?.lifecycle,
      'delivered',
      '休眠只改标记，不改阶段（跃迁表漏键曾让这一步静默失效）',
    );

    // 休眠期间人类交互 → 热激活
    const woken = await wakeQuarantinedFlows({ runtime, taskId: spec.taskId });
    assert.equal(woken, 1);
    assert.equal(runtime.productSpecFlows.get(spec.token)?.quarantined, false);

    // 14 天：自动归档 + 退订
    const afterWake = runtime.productSpecFlows.get(spec.token)!;
    await sweepLifecycles({
      runtime,
      now: (afterWake.lifecycleUpdatedAt ?? 0) + LIFECYCLE_STALE_MS * 3,
    });
    assert.equal(runtime.productSpecFlows.get(spec.token), undefined, '14 天必须自动归档');
    assert.ok(h.subscriptions.some((s) => s.startsWith('unsubscribe:')));
  } finally {
    h.cleanup();
  }
});
