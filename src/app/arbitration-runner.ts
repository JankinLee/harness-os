import type { Bot } from '../im/lark.js';
import type { BotConfig } from '../core/bot-registry.js';
import {
  ARBITRATION_SUSPEND_MS,
  NEGOTIATION_MAX_ROUNDS,
  assessLowRisk,
  planArbitrationTimeout,
  type ArbitrationFlow,
  type TaskTier,
} from '../core/collaboration.js';
import {
  buildAlertCard,
  buildArbitrationCard,
  buildChainCircuitBreakCard,
} from '../im/card.js';
import { sendResultNotification } from './notification-service.js';
import { CollaborationService } from './collaboration-service.js';
import type { AppRuntime } from './runtime.js';

const TEAM_LEADER_ID = 'ceo-assistant';

/**
 * 初裁阶段时限。必须显著短于人类仲裁窗口：
 * 第三层（停滞休眠）是为「人类暂时不在」设计的，而 ceo 是常驻进程，
 * 让它占用完整的 24h 会把一条本可当天收敛的争议压到隔日。
 */
export const ARBITRATION_PRELIMINARY_TTL_MS = 30 * 60 * 1000;

export interface OpenArbitrationOptions {
  runtime: AppRuntime;
  /** 发起仲裁的一方（争议上报方） */
  config: BotConfig;
  bot: Bot;
  replyToMessageId: string;
  replyInThread?: boolean;
  taskId: string;
  dispatchId?: string;
  objective: string;
  /** 争议工件正文（双方论点/对抗意见），用于探针判定与人类阅读 */
  instruction: string;
  contradictionReason: string;
  round: number;
  maxRounds: number;
  negotiationRound?: number;
  negotiationMaxRounds?: number;
  ownerOpenId: string;
  ownerUnionId?: string;
  workspaceDir: string;
  originalMessageId?: string;
  tier?: TaskTier;
  escalations?: number;
  /** 触发来源，决定卡片如何叙述本次僵局 */
  trigger?: 'negotiation' | 'escalation';
}

/**
 * 三层仲裁链第一层的入口：建流 + 委派 ceo 初裁。
 *
 * 与旧实现的关键差别：**不直接把仲裁卡推给人类**。
 * 人类成本是最贵的资源，理应先由 ceo 在自身授权边界内消耗一次尝试；
 * 只有 ceo 弃权或超时才上浮人类。
 *
 * 同一任务已有待决仲裁时**复用而不新建**：升级超限与辩证触顶这两条独立路径
 * 可能先后命中同一条链，重复建流会向人类推送多张互相矛盾的仲裁卡。
 * （链路跳数触顶**不建仲裁流**——它走熔断终止，见 `circuitBreakChain`。）
 */
export async function openArbitration(
  options: OpenArbitrationOptions,
): Promise<ArbitrationFlow | undefined> {
  const store = options.runtime.arbitrationFlows;
  if (!store) return undefined;

  const existing = store.findOpenByTaskId(options.taskId, {
    originMessageId: options.originalMessageId,
  });
  if (existing) {
    console.log(
      `[仲裁] task=${options.taskId} 已有待决仲裁 ${existing.token}（${existing.status}），复用而不重复建流`,
    );
    // 复用不等于静默：本次触发的争议必须让人类看得见，否则新争议会被旧卡片吞掉，
    // 而人类只看到一张讨论着**另一件事**的仲裁卡。
    await sendResultNotification({
      bot: options.bot,
      replyToMessageId: options.replyToMessageId,
      target: { openId: options.ownerOpenId, name: '' },
      text: `本任务已有一份待决仲裁（编号 ${existing.token}），本次触发的争议（${options.contradictionReason}）已并入其中，请在既有仲裁卡中一并裁决。`,
      replyInThread: options.replyInThread ?? false,
    });
    return existing;
  }

  const flow = store.create({
    taskId: options.taskId,
    dispatchId: options.dispatchId,
    fromBotId: options.config.id,
    toBotId: TEAM_LEADER_ID,
    reportToBotId: TEAM_LEADER_ID,
    objective: options.objective,
    instruction: options.instruction,
    contradictionReason: options.contradictionReason,
    round: options.round,
    maxRounds: options.maxRounds,
    negotiationRound: options.negotiationRound,
    negotiationMaxRounds: options.negotiationMaxRounds ?? NEGOTIATION_MAX_ROUNDS,
    ownerOpenId: options.ownerOpenId,
    ownerUnionId: options.ownerUnionId,
    workspaceDir: options.workspaceDir,
    originalMessageId: options.originalMessageId,
    cardMessageId: options.replyToMessageId,
    replyInThread: options.replyInThread,
    tier: options.tier,
    escalations: options.escalations,
    trigger: options.trigger,
  });

  const leaderRuntime = options.runtime.botRuntimes.get(TEAM_LEADER_ID);
  if (!leaderRuntime) {
    // 没有 ceo 在线时绝不留幽灵仲裁流：宁可直接上浮人类，也不能留下一个永远没人认领的 pending
    store.delete(flow.token);
    await pushHumanArbitrationCard({ ...options, flow });
    return flow;
  }

  try {
    await new CollaborationService(options.runtime).dispatch({
      senderConfig: options.config,
      senderBot: options.bot,
      replyToMessageId: options.replyToMessageId,
      targetBotId: TEAM_LEADER_ID,
      taskId: options.taskId,
      ownerOpenId: options.ownerOpenId,
      ownerUnionId: options.ownerUnionId,
      reportToBotId: TEAM_LEADER_ID,
      objective: `【第一层仲裁 · 待初裁】${options.objective}`,
      instruction: [
        'product 与 developer 就本任务陷入僵局，现由你行使第一层初步仲裁。',
        `争议焦点：${options.contradictionReason}`,
        `双方论点与工件：\n${options.instruction}`,
        `仲裁编号：${flow.token}`,
        `辩证轮数：第 ${flow.negotiationRound}/${flow.negotiationMaxRounds} 轮触顶（链跳第 ${flow.round}/${flow.maxRounds} 跳）。`,
        '裁决边界：你**只能**在自身授权边界内（排期、粒度、取舍、方案选择）裁决。',
        '若争议实质是技术真实性（例如方案在物理上是否可行），那**超出**你的授权边界，必须弃权。',
        `请调用 submit_arbitration_verdict 回传裁决：flowToken=${flow.token}；verdict 取 adopt_product / adopt_developer / abstain；并在 reasoning 中写明理由。`,
        '若你判断本任务属于低风险可回滚变更，请一并给出 riskLevel=low，否则请给 riskLevel=high（宿主仍会用物理探针独立复核，二者同时成立才可能超时自动采纳）。',
      ].join('\n\n'),
      expectedOutput: '结构化的初步仲裁裁决（submit_arbitration_verdict）。',
      tier: options.tier,
      escalations: options.escalations,
      originMessageId: options.originalMessageId,
      round: options.round,
      maxRounds: options.maxRounds,
      negotiationRound: options.negotiationRound,
      negotiationMaxRounds: flow.negotiationMaxRounds,
      workspaceDir: options.workspaceDir,
    });
  } catch (error) {
    store.delete(flow.token);
    throw error;
  }

  await sendResultNotification({
    bot: options.bot,
    replyToMessageId: options.replyToMessageId,
    target: { openId: options.ownerOpenId, name: '' },
    text: `检测到协作僵局：${options.contradictionReason}。已先交由 ceo 助理做初步仲裁，若超出其授权边界会立即上浮请你裁定。`,
    replyInThread: options.replyInThread ?? false,
  });
  console.log(
    `[仲裁] flow=${flow.token} 已建流并委派 ceo 初裁 task=${options.taskId}`,
  );
  return flow;
}

/** 第二层：把争议推给人类（携带 ceo 初裁建议与仲裁叙事） */
export async function pushHumanArbitrationCard(options: {
  runtime: AppRuntime;
  config: BotConfig;
  bot: Bot;
  replyToMessageId: string;
  replyInThread?: boolean;
  ownerOpenId: string;
  flow: ArbitrationFlow;
}): Promise<void> {
  const { flow } = options;
  await options.bot.replyCard(
    flow.cardMessageId ?? options.replyToMessageId,
    buildArbitrationCard(flow),
    flow.replyInThread ?? options.replyInThread ?? false,
  );
  await sendResultNotification({
    bot: options.bot,
    replyToMessageId: options.replyToMessageId,
    target: { openId: options.ownerOpenId, name: '' },
    text: flow.preliminaryVerdict
      ? `ceo 已完成初步仲裁（${flow.preliminaryVerdict === 'abstain' ? '弃权，超出其授权边界' : '已给出建议'}），请在上方卡片中做出最终裁决。`
      : 'ceo 未在时限内给出初裁，争议已直接上浮，请在上方卡片中做出最终裁决。',
    replyInThread: flow.replyInThread ?? false,
  });
}

/** 链路发散熔断（与仲裁严格区分：不提供立场选项，只终止并交接） */
export async function circuitBreakChain(options: {
  runtime: AppRuntime;
  bot: Bot;
  replyToMessageId: string;
  replyInThread?: boolean;
  ownerOpenId: string;
  taskId: string;
  objective: string;
  lastResult?: string;
  round: number;
  maxRounds: number;
  reason: string;
}): Promise<void> {
  // 级联清理：熔断即链路终结，关联的待决流必须一并回收，
  // 否则同一话题的下个任务会被陈旧审查流/仲裁流命中并继承其轮次预算。
  options.runtime.techReviewFlows?.deleteByTaskId(options.taskId);
  options.runtime.arbitrationFlows?.deleteByTaskId(options.taskId);
  options.runtime.productSpecFlows.deleteByTaskId(options.taskId);

  await options.bot.replyCard(
    options.replyToMessageId,
    buildChainCircuitBreakCard({
      objective: options.objective,
      hopCount: options.round,
      maxHops: options.maxRounds,
      lastResult: options.lastResult,
    }),
    options.replyInThread ?? false,
  );
  await sendResultNotification({
    bot: options.bot,
    replyToMessageId: options.replyToMessageId,
    target: { openId: options.ownerOpenId, name: '' },
    text: `协作链路已消耗 ${options.round}/${options.maxRounds} 跳仍未收敛（${options.reason}），已按发散防护网熔断终止。关联流程已清理，缩小目标后可在本话题重新发起。`,
    replyInThread: options.replyInThread ?? false,
  });
  console.log(
    `[链路熔断] task=${options.taskId} round=${options.round}/${options.maxRounds} reason=${options.reason}`,
  );
}

/**
 * 仲裁超时巡检（第三层的驱动）。
 *
 * 纯函数 `planArbitrationTimeout` 负责判定，本函数只负责执行副作用：
 * 判定与动作分离，使「什么时候该自动采纳」可被单测穷举，而不是埋在定时器回调里。
 */
export async function sweepArbitrations(options: {
  runtime: AppRuntime;
  now?: number;
}): Promise<void> {
  const store = options.runtime.arbitrationFlows;
  if (!store) return;
  const now = options.now ?? Date.now();

  // 必须遍历 listSweepable（含 pending_preliminary）而不是 listOpen：
  // 后者刻意排除了尚未初裁的流，用它巡检验等于让「初裁超时上浮人类」变成死代码。
  for (const flow of store.listSweepable()) {
    const action = planArbitrationTimeout(flow, now, {
      preliminaryTtlMs: ARBITRATION_PRELIMINARY_TTL_MS,
      suspendMs: ARBITRATION_SUSPEND_MS,
    });
    if (action === 'none') continue;

    const botRuntime = options.runtime.botRuntimes.get(flow.fromBotId);
    const bot = botRuntime?.bot;
    const replyTarget = flow.cardMessageId;

    // 前置条件必须先于状态跃迁检查：若先改状态再发现「没有可回复的卡片」，
    // 流程会被推进到一个**从未通知过任何人**的新状态，然后静默空转一整个挂起窗口。
    if (!bot || !replyTarget) {
      console.warn(
        `[仲裁] flow=${flow.token} 缺少可回复的 bot/卡片，本次 ${action} 未执行，等待下一轮巡检`,
      );
      continue;
    }

    if (action === 'escalate_to_human') {
      // 第一层超时：不产生初裁建议，直接上浮（等价于弃权，永不允许自动采纳）
      const updated = store.markPreliminaryTimeout(flow.token);
      if (!updated) continue;
      await pushHumanArbitrationCard({
        runtime: options.runtime,
        config: botRuntime?.config ?? ({ id: flow.fromBotId } as BotConfig),
        bot,
        replyToMessageId: replyTarget,
        ownerOpenId: flow.ownerOpenId,
        flow: updated,
      });
      console.log(`[仲裁] flow=${flow.token} 初裁超时，已直接上浮人类`);
      continue;
    }

    if (action === 'suspend') {
      const suspended = store.suspend(flow.token);
      if (!suspended) continue;
      await sendResultNotification({
        bot,
        replyToMessageId: replyTarget,
        target: { openId: flow.ownerOpenId, name: '' },
        text: `任务「${flow.objective}」的仲裁已等待 ${Math.round(ARBITRATION_SUSPEND_MS / 3_600_000)} 小时仍无裁决，已转入停滞休眠并释放工作区与 CLI 资源。你在话题中的任意交互都会立刻唤醒它。`,
        replyInThread: flow.replyInThread ?? false,
      });
      console.log(`[仲裁] flow=${flow.token} 超时转停滞休眠`);
      continue;
    }

    if (action === 'auto_adopt') {
      // 派发前置条件必须先于 resolve 检查：resolve 之后流就退出巡检范围，**永不重试**。
      // 曾在此处直接 resolve 再调 resume，后者在 ceo 不在线时静默 return、
      // 在派发失败时抛错到巡检外只打一行 console —— 任务被静默丢弃且人类零通知。
      const resumeTarget = options.runtime.botRuntimes.get(TEAM_LEADER_ID);
      if (!resumeTarget) {
        console.warn(
          `[仲裁] flow=${flow.token} 满足自动采纳条件但 ceo-assistant 不在线，本轮不 resolve，等待下一轮巡检`,
        );
        continue;
      }

      const resolved = store.resolve(flow.token, {
        selectedOption: flow.preliminaryVerdict,
        autoAdopted: true,
      });
      if (!resolved) continue;
      // 告知卡失败不得阻断后续的落地派发：网关抖动时，
      // 「不知道该不该推进」远不如「推进了但没收到通知」严重。
      await bot
        .replyCard(
          replyTarget,
          buildAlertCard({
            title: '仲裁超时 · 已按 ceo 初裁自动推进',
            template: 'yellow',
            detail: [
              `协作任务「${resolved.objective}」的人类裁决已等待 ${Math.round(ARBITRATION_SUSPEND_MS / 3_600_000)} 小时。`,
              `经「物理探针 ∧ ceo 自评」双条件判定为低风险可回滚，系统已按时限自动采纳 ceo 初裁继续推进。`,
              `初裁结论：${resolved.preliminaryVerdict === 'adopt_product' ? '采纳 Product 方案' : '采纳 Developer 建议'}`,
              '本次自动采纳**会被显式标注在最终交付物上**，你仍可随时叫停并改判。',
            ].join('\n\n'),
          }),
          resolved.replyInThread ?? false,
        )
        .catch((error) => {
          console.warn(
            `[仲裁] flow=${resolved.token} 自动采纳告知卡发送失败:`,
            (error as Error).message,
          );
        });
      // 走到这里 preliminaryVerdict 必然是明确初裁（planArbitrationTimeout 已排除弃权/缺省），
      // 因此不做 `?? 'adopt_product'` 兜底 —— 那会在条件被放宽时静默倒向一边。
      const verdict = resolved.preliminaryVerdict;
      if (verdict !== 'adopt_product' && verdict !== 'adopt_developer') {
        console.error(
          `[仲裁] flow=${flow.token} 自动采纳前置条件被破坏（verdict=${String(verdict)}），已拒绝推进`,
        );
        continue;
      }
      try {
        await resumeAfterArbitration({
          runtime: options.runtime,
          bot,
          flow: resolved,
          decision: verdict,
          autoAdopted: true,
        });
        console.log(`[仲裁] flow=${flow.token} 低风险超时，已按初裁自动采纳`);
      } catch (error) {
        // 自动采纳路径的失败必须与人类裁决路径同样**显式回告**：
        // 裁决已落库但没有任何 Agent 收到指令，是人类最容易被误导的状态。
        const message = (error as Error).message;
        console.error(`[仲裁] flow=${flow.token} 自动采纳派发失败:`, message);
        await bot
          .reply(
            replyTarget,
            `已按超时策略采纳 ceo 初裁，但重新派发失败：${message}。任务当前**没有**在推进，请人工介入或重新发起。`,
            resolved.replyInThread ?? false,
          )
          .catch(() => undefined);
      }
    }
  }
}

/**
 * 人类任意交互触发的热激活：把休眠中的仲裁唤醒回等待态。
 * 「秒级热激活」的本质是**不销毁上下文**——叙事与初裁都还在，人类回来即可续判。
 */
export async function wakeSuspendedArbitrations(options: {
  runtime: AppRuntime;
  taskId: string;
  bot?: Bot;
}): Promise<number> {
  const store = options.runtime.arbitrationFlows;
  if (!store) return 0;
  let woken = 0;
  for (const flow of store.listOpen()) {
    if (flow.taskId !== options.taskId || flow.status !== 'suspended') continue;
    const updated = store.wake(flow.token);
    if (!updated) continue;
    woken += 1;
    const bot = options.bot ?? options.runtime.botRuntimes.get(flow.fromBotId)?.bot;
    const target = flow.cardMessageId;
    if (bot && target) {
      await sendResultNotification({
        bot,
        replyToMessageId: target,
        target: { openId: flow.ownerOpenId, name: '' },
        text: `检测到你在话题中的交互，仲裁请求「${flow.objective}」已热激活并重新计时，请在上方卡片中裁决。`,
        replyInThread: flow.replyInThread ?? false,
      });
    }
    console.log(`[仲裁] flow=${flow.token} 已被人类交互热激活`);
  }
  return woken;
}

/**
 * 裁决落地：把结论交回链路继续推进。
 *
 * 人类裁决与超时自动采纳**必须共用本实现**，否则两条路径会在
 * 「分级/升级预算/任务凭据/双计数」的继承上逐渐漂移，最终演化成两套语义。
 */
export async function resumeAfterArbitration(options: {
  runtime: AppRuntime;
  bot: Bot;
  flow: ArbitrationFlow;
  decision: string;
  customGuidance?: string;
  autoAdopted?: boolean;
}): Promise<void> {
  const { flow } = options;
  const leaderRuntime = options.runtime.botRuntimes.get(TEAM_LEADER_ID);
  // 不得静默 return：调用方已经改写了持久状态，悄悄返回会让「已裁决但无人接手」
  // 变成一个既不报错也不推进的黑洞。抛出后由调用方负责回告人类。
  if (!leaderRuntime) {
    throw new Error('ceo-assistant 不在线，裁决无法落地为新的协作指令');
  }

  const decisionInstruction =
    options.decision === 'adopt_product'
      ? '人工仲裁裁决：采纳 Product 方案，请按 Product 确认方案继续推进。'
      : options.decision === 'adopt_developer'
        ? '人工仲裁裁决：采纳 Developer 架构调整建议，请调整方案后继续推进。'
        : `仲裁具体指示：${options.customGuidance ?? options.decision}`;

  // 自动采纳必须**显式标注**并写进链路目标：目标会随每一跳注入提示词，
  // 是唯一能保证标注活着走到最终交付物的载体（仅写在通知卡里会中途丢失）。
  const objectivePrefix = options.autoAdopted
    ? '【仲裁超时按 ceo 初裁自动推进 · 本任务未获人类显式裁决】'
    : '【人工仲裁生效】';

  const instruction = [
    '多 Agent 协作争议已完成仲裁介入，请根据以下权威决策继续统筹执行：',
    decisionInstruction,
    options.autoAdopted
      ? '注意：本次裁决是**超时自动采纳**而非人类显式拍板，请在最终交付物中显式标注这一点。'
      : '',
    '请作为 Team Leader 落实该裁决，继续派发或完成交付。',
  ]
    .filter(Boolean)
    .join('\n\n');

  await new CollaborationService(options.runtime).dispatch({
    senderConfig: leaderRuntime.config,
    senderBot: leaderRuntime.bot,
    replyToMessageId: flow.cardMessageId ?? flow.originalMessageId ?? '',
    targetBotId: TEAM_LEADER_ID,
    taskId: flow.taskId,
    ownerOpenId: flow.ownerOpenId,
    ownerUnionId: flow.ownerUnionId,
    reportToBotId: TEAM_LEADER_ID,
    objective: `${objectivePrefix}${flow.objective}`,
    instruction,
    tier: flow.tier,
    escalations: flow.escalations,
    originMessageId: flow.originalMessageId,
    // 链跳数**继续累加**：仲裁消耗的是「辩证额度」的重置机会，不是整条链的续命。
    // 曾在此处重置为 round=1 / maxRounds=3，把 16 跳的发散网错当成 3 跳的辩证界，
    // 导致裁决后第 3 跳就再次熔断。
    round: flow.round + 1,
    maxRounds: flow.maxRounds,
    // 辩证轮数重置为 1：裁决给出了新的方向，双方理应重新起算对抗轮次。
    negotiationRound: 1,
    negotiationMaxRounds: flow.negotiationMaxRounds ?? NEGOTIATION_MAX_ROUNDS,
    workspaceDir: flow.workspaceDir,
  });
}

/** 计算仲裁流的低风险判定（探针事实 ∧ ceo 自评），供初裁落地时调用 */
export function assessArbitrationRisk(options: {
  flow: Pick<ArbitrationFlow, 'objective' | 'instruction' | 'tier'>;
  ceoRiskLevel?: 'low' | 'high';
}): { lowRisk: boolean; reasons: string[] } {
  return assessLowRisk({
    objective: options.flow.objective,
    instruction: options.flow.instruction,
    tier: options.flow.tier,
    ceoRiskLevel: options.ceoRiskLevel,
  });
}
