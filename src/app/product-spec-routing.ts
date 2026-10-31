import type { Bot } from '../im/lark.js';
import { sendResultNotification } from './notification-service.js';
import type { BotConfig } from '../core/bot-registry.js';
import {
  COLLABORATION_MAX_ROUNDS,
  NEGOTIATION_MAX_ROUNDS,
  type CollaborationTierContext,
} from '../core/collaboration.js';
import type { ProductSpecFlow } from '../core/product-spec.js';
import type { AppRuntime } from './runtime.js';
import { CollaborationService } from './collaboration-service.js';

const DEV_BOT_ID = 'developer';

export interface TechReviewHandoff {
  reviewToken: string;
  round: number;
  maxRounds: number;
  devName: string;
}

/**
 * Phase 3 刚性流水线统一入口。
 *
 * M/L 级协作任务的产品方案在人类终审（Phase 4）之前，必须先交由 developer 做技术可行性对抗审查。
 * 该入口必须被「所有」方案提交路径复用（首轮提交、澄清回填、驳回修订），
 * 否则澄清/修订这两条最常见路径会绕过技术审查，使 Phase 3 沦为孤岛。
 *
 * 返回 undefined 表示无需技术审查（S 级、非协作任务或 Dev 不在线），调用方应直接渲染人类终审卡。
 */
export async function handOffToTechReview(options: {
  runtime: AppRuntime;
  config: BotConfig;
  bot: Bot;
  replyToMessageId: string;
  tierContext?: CollaborationTierContext;
  specFlow: ProductSpecFlow;
  workspaceDir: string;
  replyInThread?: boolean;
}): Promise<TechReviewHandoff | undefined> {
  const { specFlow, runtime } = options;
  const tier = options.tierContext?.tier;
  // 仅 M/L 级刚性流水线需要 Phase 3；S 级直派不引入审查开销
  if (tier !== 'M' && tier !== 'L') return undefined;

  // 刚性生命周期门禁：仅处于初稿编制期（lifecycle === 'pending'）的方案需要进入 Phase 3 对抗审查；
  // 已经进入研发（in_development）或交付验收（delivered/archived）的方案绝不得重复派发技术对抗审查，杜绝交付期角色错位死循环
  if (specFlow.lifecycle && specFlow.lifecycle !== 'pending') return undefined;

  const store = runtime.techReviewFlows;
  const devRuntime = runtime.botRuntimes.get(DEV_BOT_ID);
  // 无 Dev 在线时降级为人类终审，绝不静默卡死流水线
  if (!store || !devRuntime) return undefined;

  // 任务凭据的唯一来源：方案流是当前任务的权威记录，tierContext 仅在方案流缺凭据时兜底。
  // 严禁在此处使用与本函数查表逻辑不同的第二个来源，否则后续会演变成静默不匹配。
  const taskCredential =
    specFlow.originalMessageId ?? options.tierContext?.originMessageId;

  const request = specFlow.request;
  const specPointer = {
    specFlowToken: specFlow.token,
    title: request.title ?? '产品方案',
    summary: request.summary ?? '',
    // 交付方式可能在修订轮次间切换，两个指针必须整体替换
    specDocumentUrl:
      request.deliveryMode === 'lark-doc' ? request.documentUrl : undefined,
    specPath: request.deliveryMode === 'local' ? request.specPath : undefined,
    // 归属与工作区必须跟随当前方案流刷新，否则话题级 taskId 会让新任务被指向上一个任务的工作区
    ownerOpenId: specFlow.ownerOpenId,
    ownerUnionId: specFlow.ownerUnionId,
    workspaceDir: options.workspaceDir,
  };

  // 同一任务链的修订轮次复用同一审查流，确保 3 轮收敛上限不被重置。
  // 以原始人类消息 id 作为「同一任务」的物理凭据，区分同话题下的不同任务。
  const existing = store.findPendingByTaskId(specFlow.taskId, {
    originMessageId: taskCredential,
  });
  const reviewFlow = existing
    ? (store.bindSpecFlow(existing.token, specPointer) ?? existing)
    : store.create({
        taskId: specFlow.taskId,
        dispatchId: options.tierContext?.dispatchId,
        originMessageId: taskCredential,
        ...specPointer,
        productBotId: options.config.id,
        devBotId: DEV_BOT_ID,
        // 辩证收敛界（不是链跳上限）：本流管的是「product↔dev 就这份方案吵几轮」
        maxRounds: NEGOTIATION_MAX_ROUNDS,
        ownerOpenId: specFlow.ownerOpenId,
        ownerUnionId: specFlow.ownerUnionId,
        workspaceDir: options.workspaceDir,
      });

  try {
    await new CollaborationService(runtime).dispatch({
      senderConfig: options.config,
      senderBot: options.bot,
      replyToMessageId: options.replyToMessageId,
      targetBotId: DEV_BOT_ID,
      taskId: specFlow.taskId,
      ownerOpenId: specFlow.ownerOpenId,
      ownerUnionId: specFlow.ownerUnionId,
      reportToBotId: options.config.id,
      objective: `【Phase 3 技术可行性对抗审查】${reviewFlow.title}`,
      instruction: [
        '产品方案初稿已完成，请对方案执行穿刺式技术可行性审查（接口契约、测试接缝、物理可行性、回滚策略）。',
        `技术审查编号：${reviewFlow.token}`,
        `方案标题：${reviewFlow.title}`,
        `方案摘要：${reviewFlow.summary}`,
        reviewFlow.specDocumentUrl
          ? `方案云文档：${reviewFlow.specDocumentUrl}`
          : `方案本地路径：${reviewFlow.specPath}`,
        `辩证轮次：第 ${reviewFlow.round}/${reviewFlow.maxRounds} 轮，请聚焦核心分歧快速收敛。`,
        '审查完成后必须调用 submit_tech_review 回传裁决：方案可行则 verdict=approved；存在架构冲突、接口不兼容或测试接缝缺陷则 verdict=rejected，并在 comment 中写明具体对抗意见。',
      ].join('\n\n'),
      expectedOutput:
        '结构化技术审查裁决（submit_tech_review），或退回产品修正的对抗意见。',
      tier,
      // 链跳数沿原链**继续累加**（这已是一次新的协作跳转），
      // 而辩证轮数由审查流承载（本跳是这一辩证轮的开始，尚未推进）。
      round: (specFlow.collaboration?.round ?? 0) + 1,
      maxRounds:
        specFlow.collaboration?.maxRounds ?? COLLABORATION_MAX_ROUNDS,
      negotiationRound: reviewFlow.round,
      negotiationMaxRounds: reviewFlow.maxRounds,
      escalations: options.tierContext?.escalations,
      // 凭据沿链路继承，保证召回/续派产生的技术审查仍被识别为同一任务
      originMessageId: taskCredential,
      workspaceDir: options.workspaceDir,
    });
  } catch (error) {
    // 派发失败时必须回滚刚创建的审查流，否则会留下永远无人认领的 pending 幽灵状态，
    // 使后续同一话题的新任务被 findPendingByTaskId 命中并继承陈旧的审查编号与轮次。
    if (!existing) store.delete(reviewFlow.token);
    throw error;
  }

  await sendResultNotification({
    bot: options.bot,
    replyToMessageId: options.replyToMessageId,
    target: { openId: specFlow.ownerOpenId, name: '' },
    text: '产品方案初稿已生成，已启动 Phase 3 技术可行性对抗审查，通过后才会提交你终审。',
    replyInThread: options.replyInThread ?? false,
  });
  console.log(
    `[技术审查] 已启动 Phase 3 对抗审查 flow=${reviewFlow.token} round=${reviewFlow.round}/${reviewFlow.maxRounds} task=${specFlow.taskId}`,
  );

  return {
    reviewToken: reviewFlow.token,
    round: reviewFlow.round,
    maxRounds: reviewFlow.maxRounds,
    devName: devRuntime.identity.name,
  };
}
