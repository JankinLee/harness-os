import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARBITRATION_SUSPEND_MS,
  ArbitrationFlowStore,
  COLLABORATION_MAX_ROUNDS,
  NEGOTIATION_MAX_ROUNDS,
  assessLowRisk,
  isArbitrationOwner,
  maxTaskTier,
  planArbitrationTimeout,
  type ArbitrationFlow,
} from '../../src/core/collaboration.js';
import { buildArbitrationCard, buildChainCircuitBreakCard } from '../../src/im/card.js';
import {
  ARBITRATION_PRELIMINARY_TTL_MS,
  sweepArbitrations,
} from '../../src/app/arbitration-runner.js';
import type { AppRuntime } from '../../src/app/runtime.js';

const PRELIM_TTL = ARBITRATION_PRELIMINARY_TTL_MS;

/** 最小可用的假 runtime：只提供巡检真正触及的字段 */
function makeSweepRuntime(
  store: ArbitrationFlowStore,
  pushed: string[],
  options: { replies?: string[]; includeLeader?: boolean; failDispatch?: boolean } = {},
) {
  const push = options.replies ?? pushed;
  const bot = {
    replyCard: async (id: string) => {
      pushed.push(id);
      return id;
    },
    replyMention: async () => 'm-1',
    reply: async (_id: string, text: string) => {
      push.push(text);
      return 'r-1';
    },
  };
  const runtimes: Array<[string, unknown]> = [
    [
      'product',
      {
        config: { id: 'product', skills: [] },
        bot,
        identity: { openId: 'ou-bot', name: 'product' },
      },
    ],
  ];
  if (options.includeLeader !== false) {
    // 首领派发失败：只让 ceo 这一侧的卡片发送失败，
    // 与「告知卡失败」区分开 —— 后者不应阻断落地派发。
    const leaderBot = options.failDispatch
      ? {
          ...bot,
          replyCard: async () => {
            throw new Error('飞书网关不可用');
          },
        }
      : bot;
    runtimes.push([
      'ceo-assistant',
      {
        config: { id: 'ceo-assistant', skills: [] },
        bot: leaderBot,
        identity: { openId: 'ou-ceo', name: 'ceo' },
      },
    ]);
  }
  return {
    arbitrationFlows: store,
    botRuntimes: new Map(runtimes as never),
  } as unknown as AppRuntime;
}

function makeFlow(
  store: ArbitrationFlowStore,
  overrides: Partial<ArbitrationFlow> = {},
): ArbitrationFlow {
  return store.create({
    taskId: 'task-arb',
    fromBotId: 'product',
    toBotId: 'ceo-assistant',
    reportToBotId: 'ceo-assistant',
    objective: '就数据架构方案达成一致',
    instruction: 'product 主张事件溯源；developer 主张关系型 + outbox',
    contradictionReason: '辩证第 3 轮触顶仍未收敛',
    round: 5,
    maxRounds: COLLABORATION_MAX_ROUNDS,
    negotiationRound: NEGOTIATION_MAX_ROUNDS,
    negotiationMaxRounds: NEGOTIATION_MAX_ROUNDS,
    ownerOpenId: 'ou_owner',
    workspaceDir: process.cwd(),
    ...overrides,
  });
}

test('批次三 · 双计数语义隔离：链跳数与辩证轮数是两个独立约束', () => {
  // 两个常量必须彼此独立，且语义不同 —— 合并成一个数字正是历史上语义塌缩的根源
  assert.equal(NEGOTIATION_MAX_ROUNDS, 3);
  assert.equal(COLLABORATION_MAX_ROUNDS, 16);
  assert.notEqual(NEGOTIATION_MAX_ROUNDS, COLLABORATION_MAX_ROUNDS);

  // 链跳数可以在辩证轮数之外自由增长：转发 5 跳不该消耗任何辩证额度
  const store = new ArbitrationFlowStore();
  const flow = makeFlow(store, { round: 5, negotiationRound: 1 });
  assert.equal(flow.round, 5);
  assert.equal(flow.negotiationRound, 1);
  assert.ok(
    flow.round < flow.maxRounds && flow.negotiationRound <= NEGOTIATION_MAX_ROUNDS,
  );
});

test('批次三 · 仲裁超时判定是纯函数且可穷举（自动采纳三条件缺一不可）', () => {
  const base = { status: 'pending_human' as const, updatedAt: 0 };
  const opts = { preliminaryTtlMs: PRELIM_TTL, suspendMs: ARBITRATION_SUSPEND_MS };

  // 未到期 → 什么都不做
  assert.equal(
    planArbitrationTimeout(
      { ...base, preliminaryVerdict: 'adopt_product', lowRisk: true },
      ARBITRATION_SUSPEND_MS - 1,
      opts,
    ),
    'none',
  );

  // 条件齐备 → 自动采纳
  assert.equal(
    planArbitrationTimeout(
      { ...base, preliminaryVerdict: 'adopt_product', lowRisk: true },
      ARBITRATION_SUSPEND_MS,
      opts,
    ),
    'auto_adopt',
  );

  // 负向用例 ①：ceo 弃权 → **任何情况下**都不自动采纳
  assert.equal(
    planArbitrationTimeout(
      { ...base, preliminaryVerdict: 'abstain', lowRisk: true },
      ARBITRATION_SUSPEND_MS * 10,
      opts,
    ),
    'suspend',
  );

  // 负向用例 ②：没有初裁（初裁超时上浮）→ 不自动采纳
  assert.equal(
    planArbitrationTimeout(
      { ...base, preliminaryVerdict: undefined, lowRisk: true },
      ARBITRATION_SUSPEND_MS * 10,
      opts,
    ),
    'suspend',
  );

  // 负向用例 ③：非低风险 → 不自动采纳
  assert.equal(
    planArbitrationTimeout(
      { ...base, preliminaryVerdict: 'adopt_developer', lowRisk: false },
      ARBITRATION_SUSPEND_MS * 10,
      opts,
    ),
    'suspend',
  );
  assert.equal(
    planArbitrationTimeout(
      { ...base, preliminaryVerdict: 'adopt_developer', lowRisk: undefined },
      ARBITRATION_SUSPEND_MS * 10,
      opts,
    ),
    'suspend',
  );

  // 第一层超时 → 上浮人类（且不产生初裁结论）
  assert.equal(
    planArbitrationTimeout(
      { status: 'pending_preliminary', updatedAt: 0 },
      PRELIM_TTL,
      opts,
    ),
    'escalate_to_human',
  );
  assert.equal(
    planArbitrationTimeout(
      { status: 'pending_preliminary', updatedAt: 0 },
      PRELIM_TTL - 1,
      opts,
    ),
    'none',
  );

  // 终态不再产生任何动作
  // 'expired' 已随「无驱动的空壳状态」退役（M8），不再列为终态断言
  for (const status of ['resolved', 'suspended'] as const) {
    assert.equal(
      planArbitrationTimeout({ status, updatedAt: 0 }, Number.MAX_SAFE_INTEGER, opts),
      'none',
    );
  }
});

test('批次三 · 初裁超时上浮后永不具备自动采纳资格', () => {
  const store = new ArbitrationFlowStore();
  const flow = store.create({
    taskId: 't-uplift',
    fromBotId: 'developer',
    toBotId: 'ceo-assistant',
    reportToBotId: 'ceo-assistant',
    objective: '实现 X',
    instruction: '争议正文',
    contradictionReason: '升级超限',
    round: 2,
    maxRounds: COLLABORATION_MAX_ROUNDS,
    ownerOpenId: 'ou_1',
    workspaceDir: process.cwd(),
  });
  assert.equal(flow.status, 'pending_preliminary');

  const uplifted = store.markPreliminaryTimeout(flow.token);
  assert.ok(uplifted);
  assert.equal(uplifted?.status, 'pending_human');
  // 关键：上浮路径**不写入** preliminaryVerdict，因此等价于弃权
  assert.equal(uplifted?.preliminaryVerdict, undefined);
  assert.equal(
    planArbitrationTimeout(
      { ...uplifted!, updatedAt: 0 },
      ARBITRATION_SUSPEND_MS * 10,
      { preliminaryTtlMs: PRELIM_TTL, suspendMs: ARBITRATION_SUSPEND_MS },
    ),
    'suspend',
  );
});

test('批次三 · 接线级：初裁超时必须真的上浮人类并推卡（巡检范围回归）', async () => {
  // 本用例存在的理由：整套仲裁接线此前**零测试覆盖**，
  // 巡检被建在 `listOpen`（排除 pending_preliminary）上，
  // 使「初裁超时上浮」成为死代码、30 分钟初裁时限彻底失效，且无任何告警。
  const store = new ArbitrationFlowStore();
  const flow = makeFlow(store, { cardMessageId: 'om-card' });
  const pushed: string[] = [];
  const runtime = makeSweepRuntime(store, pushed);

  // 未到期 → 停在待初裁，不推卡
  await sweepArbitrations({ runtime, now: Date.now() + 60_000 });
  assert.equal(store.get(flow.token)?.status, 'pending_preliminary');
  assert.equal(pushed.length, 0);

  // 超过初裁时限 → 必须上浮为「等待人类裁决」并真的推卡
  await sweepArbitrations({
    runtime,
    now: Date.now() + ARBITRATION_PRELIMINARY_TTL_MS + 1,
  });
  const uplifted = store.get(flow.token);
  assert.equal(uplifted?.status, 'pending_human');
  // 上浮路径不产生初裁结论（等价于弃权），因此永不具备自动采纳资格
  assert.equal(uplifted?.preliminaryVerdict, undefined);
  assert.ok(pushed.length > 0, '初裁超时必须把人类仲裁卡真正推送出去');

  // 人类继续静默 → 只能休眠，绝不自动推进
  await sweepArbitrations({
    runtime,
    now: Date.now() + ARBITRATION_PRELIMINARY_TTL_MS + ARBITRATION_SUSPEND_MS + 2,
  });
  const dormant = store.get(flow.token);
  assert.equal(dormant?.status, 'suspended');
  assert.equal(dormant?.autoAdoptedAt, undefined);
});

test('批次三 · 接线级：低风险可自动采纳，但 ceo 离线时绝不 resolve（防静默丢弃）', async () => {
  const prepare = () => {
    const store = new ArbitrationFlowStore();
    const flow = makeFlow(store, { cardMessageId: 'om-card' });
    store.recordPreliminary(flow.token, {
      verdict: 'adopt_product',
      reasoning: '排期取舍属授权范围',
      lowRisk: true,
      riskReasons: [],
    });
    return { store, flow };
  };

  // ceo 不在线：必须**不 resolve**，把流留在巡检范围内等待下一轮，
  // 否则流会退出 listSweepable 且永不重试，任务被静默丢弃。
  {
    const { store, flow } = prepare();
    const pushed: string[] = [];
    const runtime = makeSweepRuntime(store, pushed, { includeLeader: false });
    await sweepArbitrations({
      runtime,
      now: Date.now() + ARBITRATION_SUSPEND_MS + 1,
    });
    assert.equal(
      store.get(flow.token)?.status,
      'pending_human',
      'ceo 离线时不得 resolve（resolve 后永不重试 = 静默丢弃）',
    );
    assert.equal(store.get(flow.token)?.autoAdoptedAt, undefined);
  }

  // ceo 在线但派发失败：裁决已落库，**必须显式回告人类**而不是只打一行日志
  {
    const { store, flow } = prepare();
    const pushed: string[] = [];
    const replies: string[] = [];
    const runtime = makeSweepRuntime(store, pushed, {
      replies,
      failDispatch: true,
    });
    await sweepArbitrations({
      runtime,
      now: Date.now() + ARBITRATION_SUSPEND_MS + 1,
    });
    const resolved = store.get(flow.token);
    assert.equal(resolved?.status, 'resolved');
    assert.ok(resolved?.autoAdoptedAt, '自动采纳必须留下时刻戳');
    assert.ok(
      resolved?.narrative.some((line) => /自动采纳/.test(line)),
      '仲裁叙事必须记录本次为超时自动采纳',
    );
    assert.ok(
      replies.some((text) => /派发失败/.test(text) && /没有\*\*在推进|没有在推进/.test(text)),
      `自动采纳的派发失败必须回告人类，实际回告：${JSON.stringify(replies)}`,
    );
  }
});

test('批次三 · 弃权不是终态：争议必须继续上浮到人类', () => {
  const store = new ArbitrationFlowStore();
  const flow = makeFlow(store);
  const recorded = store.recordPreliminary(flow.token, {
    verdict: 'abstain',
    reasoning: '方案在物理上是否可行超出我的授权边界',
    lowRisk: false,
    riskReasons: ['ceo 未显式声明低风险'],
  });
  assert.ok(recorded);
  // 弃权 → 仍然是「等待人类裁决」，而不是 resolved/expired
  assert.equal(recorded?.status, 'pending_human');
  assert.equal(recorded?.preliminaryVerdict, 'abstain');
  assert.ok(recorded?.narrative.some((line) => /弃权/.test(line)));
});

test('批次三 · 低风险判定 = 探针事实 ∧ ceo 自评（双条件，缺一不成立）', () => {
  // 双条件成立
  const ok = assessLowRisk({
    objective: '修改 src/im/card.ts 的文案',
    instruction: '把按钮标题改为「提交」',
    tier: 'S',
    ceoRiskLevel: 'low',
  });
  assert.equal(ok.lowRisk, true, `应判为低风险，实际理由：${ok.reasons.join('；')}`);

  // 只有 ceo 自评、探针不通过（触碰冻结边界）→ 不成立
  const boundary = assessLowRisk({
    objective: '调整 .env 中的凭证配置',
    instruction: '修改 config/bots.json 的协作轮次',
    tier: 'S',
    ceoRiskLevel: 'low',
  });
  assert.equal(boundary.lowRisk, false);
  assert.ok(boundary.reasons.some((r) => /物理探针不通过/.test(r)));

  // 只有探针通过、ceo 不背书 → 不成立
  const noBacking = assessLowRisk({
    objective: '修改 src/im/card.ts 的文案',
    instruction: '把按钮标题改为「提交」',
    tier: 'S',
  });
  assert.equal(noBacking.lowRisk, false);
  assert.ok(noBacking.reasons.some((r) => /未显式声明低风险/.test(r)));

  // ceo 自评高风险 → 不成立
  const high = assessLowRisk({
    objective: '修改 src/im/card.ts 的文案',
    instruction: '把按钮标题改为「提交」',
    tier: 'S',
    ceoRiskLevel: 'high',
  });
  assert.equal(high.lowRisk, false);

  // L 级任务即使 ceo 说低风险也不成立
  const lTier = assessLowRisk({
    objective: '重构协作总线',
    instruction: '调整 src/core/collaboration.ts',
    tier: 'L',
    ceoRiskLevel: 'low',
  });
  assert.equal(lTier.lowRisk, false);
  assert.ok(lTier.reasons.some((r) => /L 级/.test(r)));

  // 破坏性指令 → 探针必然拒绝
  const destructive = assessLowRisk({
    objective: '清理构建产物',
    instruction: 'rm -rf dist/ 后重新构建 package.json',
    tier: 'S',
    ceoRiskLevel: 'low',
  });
  assert.equal(destructive.lowRisk, false);
});

test('批次四 · 仲裁去重：同一任务不得并发多张待决仲裁卡', () => {
  const store = new ArbitrationFlowStore();
  const first = makeFlow(store, { originalMessageId: 'om-1' });
  assert.ok(store.findOpenByTaskId('task-arb', { originMessageId: 'om-1' }));

  // 同任务再次触发（升级熔断 / 辩证触顶 / 链路熔断三条路径都可达）→ 必须命中已有流
  const again = store.findOpenByTaskId('task-arb', { originMessageId: 'om-1' });
  assert.equal(again?.token, first.token);

  // 同话题的**另一个任务**（凭据不同）不得被误判为同一争议
  assert.equal(
    store.findOpenByTaskId('task-arb', { originMessageId: 'om-2' }),
    undefined,
  );

  // 已裁决的流不再算「待决」
  store.recordPreliminary(first.token, {
    verdict: 'adopt_product',
    reasoning: 'x',
  });
  store.resolve(first.token, { selectedOption: 'adopt_product' });
  assert.equal(
    store.findOpenByTaskId('task-arb', { originMessageId: 'om-1' }),
    undefined,
  );
});

test('批次四 · 发起人鉴权：非发起人不得裁决争议', () => {
  const flow = makeFlow(new ArbitrationFlowStore(), { ownerOpenId: 'ou_owner', ownerUnionId: 'un_owner' });
  assert.equal(
    isArbitrationOwner(flow, { operatorOpenId: 'ou_owner', operatorUnionId: 'un_owner' }),
    true,
  );
  assert.equal(
    isArbitrationOwner(flow, { operatorOpenId: 'ou_other', operatorUnionId: 'un_other' }),
    false,
  );
  // unionId 跨应用稳定，优先于 openId 比较
  assert.equal(
    isArbitrationOwner(flow, { operatorOpenId: 'ou_renamed', operatorUnionId: 'un_owner' }),
    true,
  );
  assert.equal(isArbitrationOwner(flow, { operatorOpenId: 'ou_other' }), false);
});

test('批次四 · terminate 级联清理：链路终止必须回收该任务的全部仲裁', () => {
  const store = new ArbitrationFlowStore();
  makeFlow(store, { taskId: 't-a', originalMessageId: 'om-a' });
  makeFlow(store, { taskId: 't-a', originalMessageId: 'om-b' });
  makeFlow(store, { taskId: 't-b', originalMessageId: 'om-c' });

  // 级联清理必须覆盖**全部状态**的关联仲裁（含尚未初裁的 pending_preliminary）。
  // 三个列表方法的职责必须保持显式区分：
  //   listOpen     = 人类此刻可操作的（pending_human / suspended）
  //   listSweepable= 超时巡检要覆盖的（含 pending_preliminary）
  // 曾把巡检建在 listOpen 上，导致「初裁超时上浮人类」永远不可达。
  assert.equal(store.listOpen().length, 0);
  assert.equal(store.listSweepable().length, 3);
  assert.equal(store.deleteByTaskId('t-a'), 2);
  // 只清理目标任务：同话题的其他任务不受牵连
  assert.equal(store.deleteByTaskId('t-b'), 1);
  assert.equal(store.deleteByTaskId('t-a'), 0);
});

test('批次三/四 · 仲裁卡片渲染真实阈值与初裁建议（不再硬编码 3 轮）', () => {
  const store = new ArbitrationFlowStore();
  const flow = makeFlow(store, { round: 7, maxRounds: COLLABORATION_MAX_ROUNDS });
  const beforePreliminary = JSON.stringify(buildArbitrationCard(flow));
  // 副标题必须反映真实阈值，而不是写死的「3 轮上限」
  assert.match(beforePreliminary, /辩证第 3 \/ 3 轮触顶/);
  assert.match(beforePreliminary, /链跳第 7 \/ 16 跳/);
  assert.doesNotMatch(beforePreliminary, /任务协作达到 3 轮上限/);
  // 尚未初裁时不得谎称已有初裁结论
  assert.match(beforePreliminary, /ceo 未在时限内给出初裁|第一层 · ceo 初步仲裁/);

  store.recordPreliminary(flow.token, {
    verdict: 'adopt_developer',
    reasoning: '接口契约与现有适配层冲突',
    lowRisk: false,
    riskReasons: ['ceo 自评为高风险'],
  });
  const afterPreliminary = JSON.stringify(
    buildArbitrationCard(store.get(flow.token)!),
  );
  assert.match(afterPreliminary, /采纳 Developer 架构调整建议/);
  assert.match(afterPreliminary, /接口契约与现有适配层冲突/);
  // 非低风险必须明确告知「不会自动推进」
  assert.match(afterPreliminary, /不会\*\*自动推进|不会自动推进/);

  // Schema 2.0 合规：不得出现 textarea
  assert.doesNotMatch(afterPreliminary, /textarea/);
});

test('批次三 · 链路熔断卡与仲裁卡语义严格区分（熔断不提供立场选项）', () => {
  const card = buildChainCircuitBreakCard({
    objective: '跨模块重构',
    hopCount: 16,
    maxHops: 16,
    lastResult: '最后一跳产出摘要',
  });
  const json = JSON.stringify(card);
  assert.match(json, /协作链路发散熔断 · 已终止/);
  assert.match(json, /链跳 16 \/ 16 触顶/);
  // 熔断不是仲裁：不得出现任何「选边」按钮
  assert.doesNotMatch(json, /decide_arbitration/);
  assert.doesNotMatch(json, /按 Product 方案继续/);
  assert.doesNotMatch(json, /终止任务/);
});

test('批次三 · ARBITRATION_SUSPEND_MS 是人类仲裁窗口（24h）', () => {
  assert.equal(ARBITRATION_SUSPEND_MS, 24 * 60 * 60 * 1000);
});

test('批次一/三 · 分级单调不降在仲裁链路中同样成立', () => {
  // 仲裁不应成为降级通道：tier 只能被 maxTaskTier 向上钳制
  assert.equal(maxTaskTier('S', 'M'), 'M');
  assert.equal(maxTaskTier('L', 'S'), 'L');
  assert.equal(maxTaskTier(undefined, 'M'), 'M');
  assert.equal(maxTaskTier('M', undefined), 'M');
});

test('批次四 · 持久化子类必须转发级联参数（覆写吞参回归）', async () => {
  // 基类签名是双参、子类覆写只声明单参 → tsc 不报错、运行时静默丢参，
  // 于是「人类明确终止时连人类待办一起回收」在**持久化层**失效，
  // 被杀的链会在 24h 后按超时策略自动复活。与「schema 静默剥字段」同型。
  const { JsonArbitrationFlowStore } = await import(
    '../../src/core/arbitration-store.js'
  );
  const { JsonProductSpecFlowStore } = await import(
    '../../src/core/product-spec-store.js'
  );
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'cascade-'));
  try {
    // 仲裁：基类语义必须穿过子类落地
    const arbFile = join(dir, 'arb.json');
    const arb = new JsonArbitrationFlowStore(arbFile);
    const humanPending = arb.create({
      taskId: 't-1',
      fromBotId: 'product',
      toBotId: 'ceo-assistant',
      reportToBotId: 'ceo-assistant',
      objective: 'o',
      instruction: 'i',
      contradictionReason: 'c',
      round: 1,
      maxRounds: COLLABORATION_MAX_ROUNDS,
      ownerOpenId: 'ou',
      workspaceDir: process.cwd(),
    });
    arb.recordPreliminary(humanPending.token, { verdict: 'abstain', reasoning: 'r' });
    const notYet = arb.create({
      taskId: 't-1',
      fromBotId: 'product',
      toBotId: 'ceo-assistant',
      reportToBotId: 'ceo-assistant',
      objective: 'o2',
      instruction: 'i2',
      contradictionReason: 'c2',
      round: 1,
      maxRounds: COLLABORATION_MAX_ROUNDS,
      ownerOpenId: 'ou',
      workspaceDir: process.cwd(),
    });
    // 默认：保留「已推到人类面前」的待办
    assert.equal(arb.deleteByTaskId('t-1'), 1, '默认不得回收人类待办');
    assert.ok(arb.get(humanPending.token), '人类待决的仲裁必须存活');
    assert.equal(arb.get(notYet.token), undefined);
    // 显式 includeHumanPending：连人类待办一起回收
    const reloaded = new JsonArbitrationFlowStore(arbFile);
    assert.equal(
      reloaded.deleteByTaskId('t-1', { includeHumanPending: true }),
      1,
      '显式参数必须穿过覆写落地（此前被静默吞掉）',
    );

    // 方案流同理
    const specFile = join(dir, 'spec.json');
    const specs = new JsonProductSpecFlowStore(specFile);
    const pending = specs.create({
      taskId: 't-2',
      botId: 'product',
      sessionId: 's',
      ownerOpenId: 'ou',
      request: {
        deliveryMode: 'local',
        title: 't',
        summary: 's',
        specPath: '.scratch/x/spec.md',
        ticketsPath: '.scratch/x/tickets.md',
      },
    });
    assert.equal(specs.deleteByTaskId('t-2'), 0, '默认不得回收人类待审方案');
    assert.ok(specs.get(pending.token));
    const reloadedSpecs = new JsonProductSpecFlowStore(specFile);
    assert.equal(
      reloadedSpecs.deleteByTaskId('t-2', { includeHumanPending: true }),
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
