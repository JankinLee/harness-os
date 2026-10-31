import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  selectCapsuleLineage,
  specPointerOf,
} from '../core/capsule-lineage.js';
import type { Bot } from '../im/lark.js';
import { buildCollaborationCard } from '../im/card.js';
import type { BotConfig } from '../core/bot-registry.js';
import {
  assembleContextCapsule,
  estimateCapsuleLength,
  type CollaborationMessage,
  type ContextCapsule,
  type TargetWorkspaceMetaPrompt,
  type TaskIntent,
} from '../core/collaboration.js';
import type { AppRuntime } from './runtime.js';

export interface CollaborationDispatch {
  senderConfig: BotConfig;
  senderBot: Bot;
  replyToMessageId: string;
  targetBotId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  targetWorkspace?: string;
  tier?: 'S' | 'M' | 'L';
  escalations?: number;
  originMessageId?: string;
  /** 无状态上下文胶囊：由调用方确定性装配后注入下游会话 */
  capsule?: ContextCapsule;
  round: number;
  maxRounds: number;
  /** 辩证轮数（收敛界计数）；与链跳数分离，互不消耗额度 */
  negotiationRound?: number;
  negotiationMaxRounds?: number;
  /** 工单性质：recon 允许在方案批准前直派 developer 做只读探查 */
  intent?: TaskIntent;
  workspaceDir: string;
}

export class CollaborationService {
  constructor(private readonly runtime: AppRuntime) {}

  async dispatch(options: CollaborationDispatch): Promise<void> {
    const target = this.runtime.botRuntimes.get(options.targetBotId);
    if (!target) throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`);
    const reportTo = this.runtime.botRuntimes.get(options.reportToBotId);
    if (!reportTo)
      throw new Error(`结果接收 bot 尚未就绪: ${options.reportToBotId}`);

    // 支持跨仓 targetWorkspace 物理穿透解析
    let resolvedTargetWorkspace = options.workspaceDir;
    if (options.targetWorkspace) {
      resolvedTargetWorkspace = await this.runtime.workspaceResolver.resolveAndEnsure(
        options.targetWorkspace,
        options.workspaceDir,
      );
    }

    const dispatchId = randomUUID().replaceAll('-', '').slice(0, 12);

    // 目标工作区知识空间资产元数据唯一定点收口装配（严格绑定目标工作区）
    let targetWorkspaceMeta: TargetWorkspaceMetaPrompt | undefined;
    const shouldInjectTargetMeta =
      options.targetBotId === 'product' ||
      options.tier === 'M' ||
      options.tier === 'L';
    if (shouldInjectTargetMeta && this.runtime.workspaceResolver) {
      const meta = this.runtime.workspaceResolver.getWorkspaceMetadata(
        resolvedTargetWorkspace,
      );
      if (meta.wikiSpaceId || meta.prdParentNodeToken) {
        targetWorkspaceMeta = {
          alias: this.runtime.workspaceResolver.getAlias(resolvedTargetWorkspace),
          path: meta.path,
          wikiSpaceId: meta.wikiSpaceId,
          prdParentNodeToken: meta.prdParentNodeToken,
          archivedParentNodeToken: meta.archivedParentNodeToken,
          wikiSpaceUrl: meta.wikiSpaceUrl,
        };
      }
    }

    // **装配收口**：调用方没给胶囊时，由唯一收口处依链路事实装配。
    // 此前「装配」是每个调用点各自要做的动作 —— 11 处派发只有 2 处做了，
    // 其余 9 处（仲裁续跑、交付回执、失败回传、Phase 3 移交）全都没有上下文，
    // 而这些恰是最容易断链的路径。分散动作一定会漏，收口后结构上不可能漏。
    const capsule = options.capsule
      ? (targetWorkspaceMeta && !options.capsule.targetWorkspaceMeta
          ? assembleContextCapsule({
              sourceTaskId: options.capsule.sourceTaskId,
              fromWorkspace: options.capsule.fromWorkspace,
              toWorkspace: options.capsule.toWorkspace,
              objective: options.capsule.objective,
              tier: options.tier,
              targetWorkspaceMeta,
              approvedSpecPointer: options.capsule.approvedSpecPointer,
              distilledDecisionsSummary:
                options.capsule.distilledDecisionsSummary,
              constraints: options.capsule.constraints,
              lineage: options.capsule.lineage,
            })
          : options.capsule)
      : assembleContextCapsule({
          sourceTaskId: options.taskId,
          // 统一用 basename：总纲要求「去物理路径」，且同一条链上同一个工作区
          // 若一处写绝对路径、一处写目录名，下游会把它们当成两个工作区。
          fromWorkspace: basename(options.workspaceDir),
          // 目标一律用**解析后的物理目录名**，不再回退到 alias：
          // alias 在不同解析路径下会被抹掉，导致同一跳的 toWorkspace 含义漂移。
          toWorkspace: basename(resolvedTargetWorkspace),
          objective: options.objective,
          tier: options.tier,
          targetWorkspaceMeta,
          // 权威方案指针：缺少它会让收口胶囊成为**次等品**——
          // 下游只看到一个属于历史任务、且被标注「仅供追溯」的指针，
          // 从而误判「当前没有已批准方案」并重新探查。
          // 可选链：收口装配不得因为某个存储未接线就让**整条派发**崩掉 ——
          // 上下文供给是增强项，不是派发的前置条件（测试用的最小 runtime 即是此情形）。
          approvedSpecPointer: specPointerOf(
            this.runtime.productSpecFlows?.findLatestByTaskId(options.taskId, {
              originMessageId: options.originMessageId,
            })?.request,
          ),
          // 承接来源只在有凭据时求：凭据为空时比较无意义，
          // 会把同话题任意一条已交付流误当成「上游」。
          lineage: options.originMessageId
            ? selectCapsuleLineage({
                flows: this.runtime.productSpecFlows?.listAll() ?? [],
                taskId: options.taskId,
                currentCredential: options.originMessageId,
              })
            : undefined,
        });

    const collaboration: CollaborationMessage = {
      dispatchId,
      taskId: options.taskId,
      ownerOpenId: options.ownerOpenId,
      ownerUnionId: options.ownerUnionId,
      fromBotId: options.senderConfig.id,
      toBotId: options.targetBotId,
      reportToBotId: options.reportToBotId,
      objective: options.objective,
      instruction: options.instruction,
      expectedOutput: options.expectedOutput,
      tier: options.tier,
      escalations: options.escalations,
      originMessageId: options.originMessageId,
      capsule,
      round: options.round,
      maxRounds: options.maxRounds,
      negotiationRound: options.negotiationRound,
      negotiationMaxRounds: options.negotiationMaxRounds,
      intent: options.intent,
      workspaceDir: resolvedTargetWorkspace,
      targetWorkspace: options.targetWorkspace,
    };
    this.runtime.collaborationInbox.register(collaboration);

    // 上下文谱系：在**唯一派发收口**处落节点，因此每一条派发路径都自动纳入审计。
    // parentNodeId 指向「本 Bot 在这条链上最近消费过的节点」——由此形成可追溯的派生链，
    // 而不是一串互不相干的孤立快照。
    if (collaboration.capsule) {
      const parent = this.runtime.capsuleLog?.findLastConsumedBy(
        collaboration.taskId,
        collaboration.fromBotId,
        { originMessageId: collaboration.originMessageId },
      );
      this.runtime.capsuleLog?.append({
        nodeId: collaboration.dispatchId,
        parentNodeId: parent?.nodeId,
        event: 'dispatch',
        taskId: collaboration.taskId,
        originMessageId: collaboration.originMessageId,
        fromBotId: collaboration.fromBotId,
        toBotId: collaboration.toBotId,
        recordedAt: new Date().toISOString(),
        capsule: collaboration.capsule,
        renderedLength: estimateCapsuleLength(collaboration.capsule),
        // 署名必须锚定在**真有摘要**这一事实上，而不是「调用方传了胶囊」：
        // 胶囊里还有由宿主确定性推导的字段（指针、承接、工作区），
        // 把整颗胶囊署名为发送方，会让审计者误以为指针也是它主张的。
        summaryAuthor:
          options.capsule && collaboration.capsule.distilledDecisionsSummary
            ? options.senderConfig.id
            : undefined,
      });
    }

    try {
      const cardMessageId = await options.senderBot.replyCard(
        options.replyToMessageId,
        buildCollaborationCard({
          senderName:
            this.runtime.botRuntimes.get(options.senderConfig.id)?.identity
              .name ?? options.senderConfig.id,
          targetName: target.identity.name,
          reportToName: reportTo.identity.name,
          workspaceName: basename(options.workspaceDir),
          objective: options.objective,
          instruction: options.instruction,
          expectedOutput: options.expectedOutput,
          round: options.round,
          maxRounds: options.maxRounds,
        }),
        true,
      );
      if (!cardMessageId) {
        throw new Error('飞书没有返回协作卡片 message_id');
      }
      const mentionMessageId = await options.senderBot.replyMention(
        cardMessageId,
        target.identity,
        options.round === 1
          ? `新的协作任务：${options.objective}（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
          : `协作结果已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
        true,
      );
      if (!mentionMessageId) {
        throw new Error('飞书没有返回协作通知 message_id');
      }
    } catch (error) {
      this.runtime.collaborationInbox.consume(
        collaboration.dispatchId,
        collaboration.toBotId,
      );
      throw error;
    }
    console.log(
      `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
    );
  }
}
