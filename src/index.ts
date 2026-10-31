/**
 * HarnessOS 入口。
 * 当前阶段：飞书消息驱动 Claude Code / Codex 完成任务。
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { startBot, type Bot, type IncomingDocumentComment } from './im/lark.js';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildAlertCard,
  buildArbitrationCard,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildClarificationSupersededCard,
  buildSessionNoticeCard,
  buildTaskCard,
  buildScheduleCreatedCard,
  buildScheduleListCard,
  buildApprovalCard,
  buildQueueWaitingCard,
  buildDeliveryReviewCard,
  buildGovernanceCard,
  LIFECYCLE_LABELS,
  splitLongText,
  ThrottledCardUpdater,
} from './im/card.js';
import { resolveMentions, extractResourceKeys } from './im/message-parser.js';
import { parseCliRequest, parseCommand } from './core/command-parser.js';
import { SessionManager } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import { TaskProgressTracker } from './core/task-progress.js';
import type { ActiveRun } from './core/task-abort.js';
import {
  ClarificationFlowStore,
  findClarificationRequest,
  formatClarificationMessage,
} from './core/clarification.js';
import type { ProductSpecRequest } from './core/product-spec.js';
import {
  JsonProductSpecFlowStore,
} from './core/product-spec-store.js';
import {
  LIFECYCLE_ARCHIVE_MS,
  LIFECYCLE_STALE_MS,
  documentToken,
} from './core/product-spec.js';
import {
  READONLY_FORBIDDEN_TOOLS,
  TERMINAL_CONTROL_TOOLS,
} from './cli/app-tools.js';
import {
  DEFAULT_APPROVAL_TIMEOUT_SECONDS,
  findApprovalRequest,
} from './core/approval.js';
import { JsonApprovalFlowStore } from './core/approval-store.js';
import { JsonScheduleStore } from './core/schedule-store.js';
import { JsonScheduleRunStore } from './core/schedule-run-store.js';
import { topicTaskId } from './core/topic-task.js';
import {
  CollaborationInbox,
  buildCollaborationPrompt,
  collaborationOrigin,
  collaborationTurnKey,
  findArbitrationVerdict,
  findDispatchTaskRequest,
  findEscalationRequest,
  findRelayRequest,
  findTechReviewSubmission,
  assembleContextCapsule,
  estimateCapsuleLength,
  detectApprovedSpec,
  checkRelayGuardrails,
  inferTaskTier,
  MAX_TASK_ESCALATIONS,
  NEGOTIATION_MAX_ROUNDS,
  ARBITRATION_SUSPEND_MS,
  maxTaskTier,
  SeamProbeEngine,
  type CollaborationMessage,
} from './core/collaboration.js';
import { CapsuleLog } from './core/capsule-log.js';
import { selectStaleDelivered } from './core/product-spec.js';
import { recordFriction } from './app/friction-recorder.js';
import {
  verifyReconMutation,
  type ReconGuardOutcome,
} from './app/recon-guard.js';
import {
  selectCapsuleLineage,
  specPointerOf,
} from './core/capsule-lineage.js';
import {
  diffWorkspaceFingerprint,
  readWorkspaceFingerprint,
  type WorkspaceFingerprint,
} from './core/workspace-change-probe.js';
import { JsonArbitrationFlowStore } from './core/arbitration-store.js';
import { JsonTechReviewFlowStore } from './core/tech-review-store.js';
import {
  assessArbitrationRisk,
  circuitBreakChain,
  openArbitration,
  resumeAfterArbitration,
  sweepArbitrations,
  wakeSuspendedArbitrations,
  ARBITRATION_PRELIMINARY_TTL_MS,
} from './app/arbitration-runner.js';
import {
  archiveSpecFlow,
  markDeliveredFromDevReport,
  reconcileDocumentSubscription,
  sweepLifecycles,
  wakeQuarantinedFlows,
} from './app/lifecycle-runner.js';
import {
  WorkspaceResolver,
} from './core/workspace-resolver.js';
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from './core/workspace.js';
import {
  buildBotPrompt,
  loadHarnessOsConfig,
  type BotConfig,
} from './core/bot-registry.js';
import { TeamRegistry } from './core/team-registry.js';
import { getCliAdapter, listCliAdapters } from './cli/registry.js';
import { compactCliSession } from './cli/native-compact.js';
import {
  createCardActionHandler,
  scheduleApprovalContinuation,
} from './app/card-action-handler.js';
import { assertProductSpecDocuments } from './app/product-spec-documents.js';
import { executeCli } from './app/cli-execution.js';
import { RunawayDetector } from './core/runaway-detector.js';
import { handleSessionCommand } from './app/command-handler.js';
import { sendResultNotification } from './app/notification-service.js';
import { markSessionIdle } from './app/session-view.js';
import { runProductDocumentComment } from './app/product-comment-runner.js';
import { ensureProductSpecSubmission } from './app/product-spec-submission.js';
import {
  mergeToolCallLists,
  repairTerminalToolSubmissions,
} from './app/terminal-tool-submission.js';
import {
  detectUnhandledTerminalCall,
  skillGatedTerminalTools,
} from './app/terminal-tool-probe.js';
import {
  markTerminalToolRejected,
  readObservedToolCalls,
  readTerminalToolRejected,
} from './cli/failure-metadata.js';
import { harvestLatestDecisionSummary } from './app/product-decision-harvester.js';
import { checkToolRbac } from './core/tool-rbac.js';
import type { CliRunResult } from './cli/types.js';
import { CollaborationService } from './app/collaboration-service.js';
import { handOffToTechReview } from './app/product-spec-routing.js';
import { Scheduler } from './app/scheduler.js';
import { startScheduleApi } from './app/schedule-api.js';
import { startScheduleFileWatcher } from './app/schedule-watcher.js';
import type { AppRuntime, BotRuntime } from './app/runtime.js';

const botConfigPath = resolve(
  process.env.BOTS_CONFIG ?? join('config', 'bots.json'),
);
const harnessOsConfig = await loadHarnessOsConfig(botConfigPath);
const botConfigs = harnessOsConfig.bots;
const teamRegistry = new TeamRegistry(harnessOsConfig.teamLeaderId, botConfigs);
await Promise.all(
  botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)),
);
for (const missing of await teamRegistry.findMissingSkills()) {
  console.warn(
    `[Skill] bot=${missing.botId} 找不到 ${missing.skill}，请安装到工作区或用户级 Skills 目录`,
  );
}
const workspaceResolver = new WorkspaceResolver({
  defaultWorkspace: harnessOsConfig.defaultWorkspaceDir,
  workspaces: harnessOsConfig.workspaces,
  wikiSpaceId: harnessOsConfig.wikiSpaceId,
});
const defaultWorkspaces = Object.fromEntries(
  botConfigs.map((config) => [config.id, config.workspaceDir]),
);
const sessions = await SessionManager.open({
  store: new JsonSessionStore(
    join('data', 'sessions.json'),
    botConfigs[0]?.id,
    defaultWorkspaces,
  ),
});
const activeRuns = new Map<string, ActiveRun>();
const contextWindows = new Map<string, number>();
const sessionRunawayDetectors = new Map<string, RunawayDetector>();
const botRuntimes = new Map<string, BotRuntime>();
const processedCollaborationTurns = new Set<string>();
const collaborationInbox = new CollaborationInbox();
const clarificationFlows = new ClarificationFlowStore();
const productSpecFlows = new JsonProductSpecFlowStore(
  join('data', 'product-spec-flows.json'),
);
const approvalFlows = new JsonApprovalFlowStore(
  join('data', 'approval-flows.json'),
);
// 仲裁流与技术审查流必须持久化：仲裁是跨 24h 的生命周期，而宿主是 watch 模式热重载进程，
// 纯内存态会在任意一次源码变更重启时把待决仲裁与仲裁叙事整体丢空。
const arbitrationFlows = new JsonArbitrationFlowStore(
  join('data', 'arbitration-flows.json'),
);
const techReviewFlows = new JsonTechReviewFlowStore(
  join('data', 'tech-review-flows.json'),
);
// 胶囊供给日志：让「下游到底看到了什么」在事后可审计（此前消费即销毁，断链后无从归因）
const capsuleLog = new CapsuleLog(join('data', 'capsule-log.json'));
const processedDocumentCommentEvents = new Set<string>();
const documentCommentQueues = new Map<string, Promise<void>>();
const MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS = 1_000;
const runtime: AppRuntime = {
  sessions,
  teamRegistry,
  workspaceResolver,
  activeRuns,
  contextWindows,
  botRuntimes,
  processedCollaborationTurns,
  collaborationInbox,
  clarificationFlows,
  productSpecFlows,
  approvalFlows,
  arbitrationFlows,
  techReviewFlows,
  capsuleLog,
};
function persistBotIdentities(): void {
  const identities = Object.fromEntries(
    [...botRuntimes.entries()].map(([id, run]) => [
      id,
      { openId: run.identity.openId, name: run.identity.name },
    ]),
  );
  mkdirSync(join('data'), { recursive: true });
  writeFileSync(
    join('data', 'bot-identities.json'),
    `${JSON.stringify(identities, null, 2)}\n`,
    'utf8',
  );
}
const collaborationService = new CollaborationService(runtime);
const scheduleFilePath = join('data', 'schedules.json');
const scheduleStore = new JsonScheduleStore(scheduleFilePath);
const scheduleRunStore = new JsonScheduleRunStore(
  join('data', 'schedule-runs.json'),
);
const scheduler = new Scheduler({
  runtime,
  scheduleStore,
  runStore: scheduleRunStore,
  defaultProductDeliveryMode: harnessOsConfig.defaultProductDeliveryMode,
});

console.log('HarnessOS 启动，正在建立飞书长连接…');
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，Team Leader=${teamRegistry.leaderBotId}，已恢复 ${sessions.size} 个会话`,
);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
}
for (const config of botConfigs) {
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} workspace=${config.workspaceDir}`,
  );
}

async function startConfiguredBot(
  config: BotConfig,
  collaborationService: CollaborationService,
): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    onCardAction: createCardActionHandler({
      runtime,
      config,
      collaborationService,
      defaultProductDeliveryMode: harnessOsConfig.defaultProductDeliveryMode,
    }),
    onDocumentComment: config.skills.includes('lark-drive')
      ? async (comment, bot) => scheduleDocumentComment(config, bot, comment)
      : undefined,
    onMessage: async (msg, bot) => {
      const resolved = resolveMentions(msg.text, msg.mentions);
      const taskId = topicTaskId(msg);
      // 第三层仲裁的「热激活」：人类在话题中的任意交互都会唤醒该话题下休眠的仲裁。
      // 热激活的关键不是速度，而是**不销毁上下文**——仲裁叙事与 ceo 初裁都还在，
      // 人类回来即可续判，无需任何一方重述争议。
      if (msg.senderType !== 'app' && msg.senderType !== 'bot') {
        void wakeSuspendedArbitrations({ runtime, taskId, bot }).catch(
          (error) => {
            console.warn('[仲裁] 热激活扫描失败:', (error as Error).message);
          },
        );
        // 方案流的停滞休眠同理：人类回来即可续办，不销毁任何上下文
        void wakeQuarantinedFlows({ runtime, taskId }).catch((error) => {
          console.warn('[生命周期] 热激活扫描失败:', (error as Error).message);
        });
      }
      let senderRuntime: BotRuntime | undefined;
      let collaboration: CollaborationMessage | undefined;
      if (msg.senderType === 'app' || msg.senderType === 'bot') {
        const currentRuntime = botRuntimes.get(config.id);
        const mentionedCurrentBot = currentRuntime
          ? msg.mentions.some(
              (mention) => mention.openId === currentRuntime.identity.openId,
            )
          : false;
        const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
        // **peek 而非 consume**：破坏性取出会把重复投递变成 `undefined`，
        // 从而绕过下面整条去重护栏、被降级成「外部派活」再跑一次 CLI。
        // 「取出即销毁」与「Set 型去重」不可共存，必须先 peek、去重通过后再 ack。
        const pending =
          msg.messageType === 'post' && mentionedCurrentBot && dispatchId
            ? collaborationInbox.peek(dispatchId, config.id)
            : undefined;
        if (!pending) {
          if (mentionedCurrentBot) {
            console.log(
              `[协作] bot 消息 @ 当前 bot，按外部派活处理 sender=${msg.senderOpenId} target=${config.id}`,
            );
          } else {
            console.log(
              `[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`,
            );
            return;
          }
        } else {
          senderRuntime = botRuntimes.get(pending.fromBotId);
          if (!senderRuntime) {
            console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
            return;
          }
          const turnKey = collaborationTurnKey(pending);
          if (processedCollaborationTurns.has(turnKey)) {
            console.log(`[协作] 忽略重复消息 ${turnKey}`);
            return;
          }
          processedCollaborationTurns.add(turnKey);
          // 去重通过后才真正移除（两段式的第二段）
          collaborationInbox.ack(pending.dispatchId);
          collaboration = pending;
          // 消费留痕：下游**实际读取**胶囊的那一刻落一个节点，
          // 与派发节点配对后即可回答「谁在什么时候看到了什么」，
          // 也使后续派发能通过 parentNodeId 接上派生链。
          if (pending.capsule) {
            capsuleLog.append({
              nodeId: `consume:${pending.dispatchId}`,
              parentNodeId: pending.dispatchId,
              event: 'consume',
              taskId: pending.taskId,
              // 凭据必须随节点保存，否则同话题的第二个任务会被焊接到本链上
              originMessageId: pending.originMessageId,
              fromBotId: config.id,
              toBotId: pending.fromBotId,
              recordedAt: new Date().toISOString(),
              capsule: pending.capsule,
              renderedLength: estimateCapsuleLength(pending.capsule),
            });
          }
        }
      }
      const botSender = msg.senderType === 'app' || msg.senderType === 'bot';
      const ownerOpenId =
        collaboration?.ownerOpenId ??
        (botSender
          ? (process.env.OWNER_OPEN_ID ?? msg.senderOpenId)
          : msg.senderOpenId);
      const ownerUnionId =
        collaboration?.ownerUnionId ??
        (botSender ? undefined : msg.senderUnionId);
      const hasThread = !!msg.threadId || !!msg.rootId;
      const command = parseCommand(resolved);
      const cliRequest = parseCliRequest(resolved);
      if (cliRequest && !cliRequest.prompt) {
        await bot.reply(
          msg.messageId,
          `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
          hasThread,
        );
        return;
      }
      const pendingClarification =
        msg.senderType !== 'app' && msg.senderType !== 'bot' && !command
          ? clarificationFlows.findForTask(taskId, config.id)
          : undefined;
      const targetWorkspaceDir = collaboration?.workspaceDir ?? config.workspaceDir;
      const targetWorkspaceAlias =
        workspaceResolver.getAlias(targetWorkspaceDir);
      const resolvedSession = await sessions.resolve(
        msg,
        cliRequest?.cliId ?? config.defaultCliId,
        config.id,
        targetWorkspaceDir,
        targetWorkspaceAlias,
      );
      let { session } = resolvedSession;
      const { isNew } = resolvedSession;
      if (command && isNew && session.status === 'creating') {
        session = await sessions.transition(session.id, 'idle');
      }
      const cliAdapter = getCliAdapter(session.cliId);
      const isCompacting = command?.name === 'compact';
      let taskText = pendingClarification
        ? formatClarificationMessage(
            pendingClarification,
            cliRequest?.prompt ?? resolved,
          )
        : collaboration
          ? buildCollaborationPrompt(collaboration)
          : (cliRequest?.prompt ?? resolved);
      if (command?.name === 'schedule' && command.request) {
        taskText = [
          '用户想创建一个定时任务。',
          `需求：${command.request}`,
          '请使用 schedule_manage 工具，action=add 创建：targetBotId 选择团队中合适的成员，prompt 保留完整需求，rule 根据需求选择合适的调度规则。',
        ].join('\n\n');
      }
      const prompt = buildBotPrompt(
        config,
        taskText,
        teamRegistry.contextFor(config.id, targetWorkspaceDir),
        harnessOsConfig.defaultProductDeliveryMode,
      );
      const taskCardTitle = isCompacting
        ? '整理上下文'
        : cliAdapter.displayName;
      console.log(
        `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
      );
      console.log(`  原文: ${msg.text}`);
      console.log(`  还原: ${resolved}`);
      console.log(
        `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`,
      );
      console.log(
        `  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status}`,
      );

      // 通道②：`/archive` 命令归档。
      // 与人工点击、自动归档共用同一个 archiveSpecFlow 收口，
      // 因此「释放监听、清理状态、通知人类」在任何通道下都必然同时发生。
      if (command?.name === 'archive') {
        const active = productSpecFlows
          .listAll()
          .filter(
            (flow) =>
              flow.taskId === taskId &&
              flow.botId === config.id &&
              flow.lifecycle !== 'archived',
          );
        if (active.length === 0) {
          await bot.reply(
            msg.messageId,
            '当前话题没有可归档的方案流（可能已经归档，或尚未建立方案）。',
            hasThread,
          );
          return;
        }
        let archivedCount = 0;
        for (const flow of active) {
          const ok = await archiveSpecFlow({
            runtime,
            bot,
            flow,
            channel: 'command',
          });
          if (ok) archivedCount += 1;
        }
        await sendResultNotification({
          bot,
          replyToMessageId: msg.messageId,
          target: { openId: ownerOpenId, name: '' },
          text: `已归档 ${archivedCount} 份方案并释放云文档监听。`,
          replyInThread: hasThread,
        });
        return;
      }

      // 治理大盘：通道③（集中批量归档）+ 胶囊供给审计入口（终结「审计设施只写不读」的孤岛）
      if (command?.name === 'governance') {
        const now = Date.now();
        const all = productSpecFlows.listAll();
        const stale = selectStaleDelivered(all, now);
        const capsuleEntries = (runtime.capsuleLog?.load() ?? [])
          .slice(-5)
          .reverse();
        await bot.replyCard(
          msg.messageId,
          buildGovernanceCard({
            staleFlows: stale.map((flow) => ({
              token: flow.token,
              title: `【${flow.botId}】${flow.request.title ?? '未命名方案'}`,
              taskId: flow.taskId,
              idleDays: Math.floor(
                (now - (flow.lifecycleUpdatedAt ?? now)) / 86_400_000,
              ),
            })),
            activeFlows: all
              .filter((flow) => flow.lifecycle !== 'delivered')
              .map((flow) => ({
                title: `【${flow.botId}】${flow.request.title ?? '未命名方案'}`,
                stage: LIFECYCLE_LABELS[flow.lifecycle ?? 'pending'],
                taskId: flow.taskId,
              })),
            capsuleEntries: capsuleEntries.map((entry, index) => ({
              // 本链第一个节点 = 窗口内该 taskId 的最早一条。窗口滚动后中段节点会失去父引用，
              // 必须靠这个判定把「链起点」与「上游已滚出窗口」区分开。
              isChainHead: !capsuleEntries
                .slice(index + 1)
                .some((other) => other.taskId === entry.taskId),
              recordedAt: entry.recordedAt,
              fromBotId: entry.fromBotId,
              toBotId: entry.toBotId,
              taskId: entry.taskId,
              objective: entry.capsule.objective,
              event: entry.event,
              nodeId: entry.nodeId,
              parentNodeId: entry.parentNodeId,
              summaryAuthor: entry.summaryAuthor,
            })),
          }),
          hasThread,
        );
        return;
      }

      const commandOutcome = await handleSessionCommand({
        runtime,
        scheduler,
        config,
        msg,
        bot,
        session,
        cliAdapter,
        command,
        cliRequest,
        isNew,
        hasThread,
      });
      if (commandOutcome === 'handled') {
        if (command && ['new', 'close', 'mount', 'workspace'].includes(command.name)) {
          sessionRunawayDetectors.delete(session.id);
        }
        return;
      }

      if (session.status === 'closed') {
        sessionRunawayDetectors.delete(session.id);
        await bot.reply(
          msg.messageId,
          '这个话题的会话已经关闭，请新开一个话题继续。',
          hasThread,
        );
        return;
      }
      if (!isNew && session.status === 'creating') {
        await bot.reply(
          msg.messageId,
          '当前会话正在准备，请稍后再追问。',
          hasThread,
        );
        return;
      }
      if (session.status === 'active') {
        await bot.reply(
          msg.messageId,
          '当前会话还在执行，请等任务结束后再追问。',
          hasThread,
        );
        return;
      }

      if (pendingClarification) {
        clarificationFlows.delete(pendingClarification.token);
        if (pendingClarification.cardMessageId) {
          try {
            await bot.updateCard(
              pendingClarification.cardMessageId,
              buildClarificationSupersededCard(pendingClarification),
            );
          } catch (error) {
            console.warn(
              '[澄清] 旧卡片更新失败，继续处理用户的新消息:',
              (error as Error).message,
            );
          }
        }
      }

      if (
        collaboration &&
        session.workspaceDir !== collaboration.workspaceDir
      ) {
        await ensureWorkspaceDirectory(collaboration.workspaceDir);
        session = await sessions.setWorkspaceDir(
          session.id,
          collaboration.workspaceDir,
        );
      }

      await sessions.transition(session.id, 'active');
      const run = new AbortController();
      const activeRun: ActiveRun = {
        controller: run,
        ownerOpenId,
      };
      activeRuns.set(session.id, activeRun);

      // 图片/文件下载
      const resources = extractResourceKeys(msg.messageType, msg.rawContent);
      for (const res of resources) {
        try {
          const savePath = await bot.downloadResource(
            msg.messageId,
            res.key,
            res.type,
            join('data', 'downloads'),
            res.fileName,
          );
          console.log(`  [下载] ${res.type} → ${savePath}`);
        } catch (e) {
          console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
        }
      }

      // 先回复一张卡片，让用户知道任务已经进入执行队列。
      let cardId: string | undefined;
      try {
        cardId = await bot.replyCard(
          msg.messageId,
          buildTaskCard({
            title: taskCardTitle,
            status: 'running',
            detail: isCompacting
              ? cliAdapter.id === 'codex' && command?.instructions
                ? 'Codex 正在使用原生默认策略整理上下文'
                : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : '正在理解任务',
            abortSessionId: session.id,
          }),
          hasThread,
        );
      } catch (error) {
        if (activeRuns.get(session.id)?.controller === run)
          activeRuns.delete(session.id);
        await markSessionIdle(sessions, session.id);
        throw error;
      }

      if (!cardId) {
        console.error('[卡片] 响应里没有 message_id，无法继续更新');
        if (activeRuns.get(session.id)?.controller === run)
          activeRuns.delete(session.id);
        await markSessionIdle(sessions, session.id);
        return;
      }
      console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

      const progress = new TaskProgressTracker(
        Date.now,
        contextWindows.get(session.id),
        !session.cliSessionId,
      );
      const cardUpdater = new ThrottledCardUpdater((card) =>
        bot.updateCard(cardId, card),
      );
      const cliEnv = {
        HARNESS_OS_CHAT_ID: msg.chatId,
        HARNESS_OS_OWNER_OPEN_ID: collaboration?.ownerOpenId ?? msg.senderOpenId,
        HARNESS_OS_BOT_ID: config.id,
      };

      const holderId = collaboration
        ? `collab:${collaboration.toBotId}:${collaboration.taskId.slice(0, 8)}`
        : `session:${session.id.slice(0, 8)}`;

      const holderContext = {
        id: holderId,
        botId: config.id,
        botRole: config.role,
        taskSubject: collaboration ? collaboration.objective : (cliRequest?.prompt ?? resolved).slice(0, 60),
        chatId: msg.chatId,
        threadId: msg.threadId,
        // 锁模式严格由外部显式契约决定（M10），废除脆弱的启发式关键词猜词：
        // 协作只读调研（intent === 'recon'）由契约赋予共享读锁；其余常规任务诚实承认物理单写铁律，默认独占写锁排队
        mode: collaboration?.intent === 'recon' ? ('read' as const) : ('write' as const),
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      };

      const executionCwd = collaboration ? collaboration.workspaceDir : session.workspaceDir;
      let waitingInfo: Parameters<typeof buildQueueWaitingCard>[0] | undefined;

      const onWaiting = (info: any) => {
        const queueCardOptions = {
          ...info,
          sessionId: session.id,
          workspacePath: executionCwd,
        };
        waitingInfo = queueCardOptions;
        cardUpdater.push(buildQueueWaitingCard(queueCardOptions));
      };

      const onLockAcquired = () => {
        if (waitingInfo) {
          waitingInfo = undefined;
          renderProgress();
        }
      };

      const renderProgress = () => {
        if (waitingInfo) {
          cardUpdater.push(buildQueueWaitingCard(waitingInfo));
          return;
        }
        const snapshot = progress.snapshot();
        cardUpdater.push(
          buildTaskCard({
            title: taskCardTitle,
            status: 'running',
            detail: isCompacting
              ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : snapshot.current,
            ...(!isCompacting ? { progress: snapshot } : {}),
            abortSessionId: session.id,
          }),
        );
      };
      const progressHeartbeat = setInterval(renderProgress, 1_000);
      progressHeartbeat.unref();

      // 让事件回调尽快返回，CLI 在后台继续执行。
      const executionSessionId = collaboration ? undefined : session.cliSessionId;
      // 只读调研的基准指纹：声明不可信，用 git 的物理差异复核「说只读，是否真的只读」。
      // 只在 recon 时采集，不给普通任务叠加额外的 git 调用开销。
      const isReconRun = holderContext.mode === 'read';
      // 是否具备产品方案处理流：成功路径与失败路径都要用它判定「控制流工具是否根本未启用」，
      // 因此**定义在两条路径之外**，不能让其中一条自己重算一分（两份表达式迟早错位）。
      const managesProductSpec =
        !isCompacting &&
        (config.skills.includes('to-spec') || config.skills.includes('lark-doc'));
      /**
       * 本角色被**权限真源**拒绝的终结工具。探针据此把「越权」与「没有处理流」区分开——
       * 两者的处置完全不同（前者要换人执行，后者要查配置），共用一套文案就是归因误导。
       */
      const rbacDeniedToolNames = TERMINAL_CONTROL_TOOLS.filter(
        (name) => !checkToolRbac(config.id, name).allowed,
      );
      let reconBaseline: WorkspaceFingerprint | undefined;
      let warnedBudget80 = false;
      let sessionDetector = sessionRunawayDetectors.get(session.id);
      if (!sessionDetector) {
        sessionDetector = new RunawayDetector();
        sessionRunawayDetectors.set(session.id, sessionDetector);
      }
      /**
       * 最近一次**完成轮次**已观测到的工具调用。
       *
       * 失败路径的探针需要「本轮调过哪些控制流工具」，而宿主自己在 `.then` 里抛错时
       * （派发规则拒绝、文档校验失败、卡片发送失败……）异常上不会带任何附件 ——
       * 若只读异常附件，那段探针在宿主抛错路径上**永不触发**（等于白写）。
       */
      let lastRoundToolCalls: CliRunResult['toolCalls'];

      /**
       * 模型修正入参后的重试（终结工具提交纠错 / 产品方案提审引导共用）。
       *
       * 与主执行保持同一套 cwd / 会话 / 锁 / 环境 / stop 列表，两处**刻意**的差异：
       * 1. 带上 recon 的只读禁用表 —— 否则 recon 轮次里的一次「纠错重试」会成为
       *    绕过事前只读拦截的缺口（主执行有这个列表，重试没有，等于开后门）；
       * 2. **不重新采集** recon 基准指纹 —— 重试发生在首轮之后，重采会把首轮
       *    可能落下的改动洗成「基准」，让复核永远看不到它（假阴性）。
       */
      const retryCli = (
        retryPrompt: string,
        resultSessionId: string | undefined,
      ) =>
        executeCli(
          cliAdapter,
          retryPrompt,
          executionCwd,
          resultSessionId ?? (collaboration ? undefined : session.cliSessionId),
          run.signal,
          [
            ...TERMINAL_CONTROL_TOOLS,
            ...(isReconRun ? READONLY_FORBIDDEN_TOOLS : []),
          ],
          (event) => {
            if (
              event.type !== 'tool_start' &&
              event.type !== 'tool_end' &&
              event.type !== 'context'
            )
              return;
            progress.accept(event);
            renderProgress();
          },
          cliEnv,
          {
            holderId,
            // holderContext 必须原样带上：保持首轮所确立的模式与心跳上下文不变
            holderContext,
            onWaiting,
            detector: sessionDetector,
            onLockAcquired: async () => {
              await onLockAcquired?.();
            },
          },
        );

      /**
       * 「复核之后的重试」的**唯一收口**：recon 轮次一律退化为「不重试」。
       *
       * 只读复核的窗口是「锁内首轮 ↔ 复核时刻」；复核之后再跑一轮 CLI，
       * 会让这一轮的写入落在窗口之外（指纹比对已经结束，破坏不再被归因）。
       * 把判定放在收口处而不是各调用点，是因为「需要 N 个地方自觉遵守」
       * 在本仓已有明确结论：那种约定一定会漏。
       */
      const retryAfterGuard = (rawResult: CliRunResult) =>
        isReconRun
          ? async (_prompt: string, _sessionId: string | undefined) => rawResult
          : retryCli;

      const execution = isCompacting
        ? compactCliSession({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: command.instructions,
            signal: run.signal,
          }).then((result) => ({
            answer: result.message ?? '',
            sessionId: result.sessionId,
            stats: undefined,
            toolCalls: undefined,
          }))
        : executeCli(
            cliAdapter,
            prompt,
            executionCwd,
            executionSessionId,
            run.signal,
            [
              ...TERMINAL_CONTROL_TOOLS,
              // recon 事前拦截写入类工具：CLI 在工具执行前即被截断
              ...(isReconRun ? READONLY_FORBIDDEN_TOOLS : []),
            ],
            (event) => {
              if (
                event.type !== 'tool_start' &&
                event.type !== 'tool_end' &&
                event.type !== 'context'
              )
                return;
              progress.accept(event);
              renderProgress();

              // 渐进告警：达到 80% 预算/上下文阈值时，向话题发送黄色预警卡片
              const snap = progress.snapshot();
              if (!warnedBudget80 && snap.contextWindowTokens && snap.contextUsedTokens) {
                const ratio = snap.contextUsedTokens / snap.contextWindowTokens;
                if (ratio >= 0.8) {
                  warnedBudget80 = true;
                  // 网络类副作用一律自带 catch：飞书返回 4xx/5xx 或网络抖动时，
                  // 未处理的 rejection 在 Node 22 默认策略下会**直接终止宿主进程** ——
                  // 代价是全部 Bot 的连接、所有在跑会话与内存态一并蒸发，
                  // 而收益只是少发一张预警卡。本文件的其它 fire-and-forget 均已带 catch。
                  void bot
                    .replyCard(
                      msg.messageId,
                      buildAlertCard({
                        title: '会话 Token 预算 80% 预警',
                        template: 'yellow',
                        detail: `当前会话上下文消耗已达 ${Math.round(ratio * 100)}%（${snap.contextUsedTokens} / ${snap.contextWindowTokens} tokens）。建议在适当时候使用 /compact 整理上下文或 /new 开启新会话。`,
                      }),
                      hasThread,
                    )
                    .catch((error) => {
                      console.warn(
                        '[预警] 预算卡片推送失败（已降级，不影响会话）:',
                        (error as Error).message,
                      );
                    });
                }
              }
            },
            cliEnv,
            {
              holderId,
              holderContext,
              onWaiting,
              detector: sessionDetector,
              // 基准指纹必须在**持锁之后**采集：锁外的读取会把别的会话在排队期间
              // 落下的改动算进本次差异，把一次干净的调研误判成越权（假阳性）。
              onLockAcquired: async () => {
                await onLockAcquired?.();
                if (isReconRun) {
                  reconBaseline = await readWorkspaceFingerprint(executionCwd);
                }
              },
            },
          );

      /**
       * 只读调研的物理复核：唯一实现已抽到 `recon-guard.ts`（可被真实覆盖）。
       * 此处只做装配——把宿主侧的副作用注入进去。
       */
      const runReconGuard = (): Promise<ReconGuardOutcome> =>
        verifyReconMutation({
          executionCwd,
          baseline: reconBaseline,
          readFingerprint: readWorkspaceFingerprint,
          replyCard: (card, inThread) =>
            bot.replyCard(msg.messageId, card, inThread).then(() => undefined),
          finishCard: (card) => cardUpdater.finish(card),
          inThread: hasThread,
          reportToUpstream: async (options) => {
            if (!collaboration) return;
            // 不走 checkRelayGuardrails，因此必须自己挡住「回告对象就是自己」——
            // 否则一次自我派发会白白消耗一跳，且无人拦截。
            if (collaboration.reportToBotId === config.id) {
              console.warn(
                `[只读复核] task=${collaboration.taskId} 回传对象即自身，跳过回告以免自我派发`,
              );
              return;
            }
            try {
              await collaborationService.dispatch({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: msg.messageId,
                targetBotId: collaboration.reportToBotId,
                taskId: collaboration.taskId,
                ownerOpenId: collaboration.ownerOpenId,
                ownerUnionId: collaboration.ownerUnionId,
                reportToBotId: collaboration.reportToBotId,
                objective: `【只读调研未通过复核】${collaboration.objective}`,
                instruction: [
                  options.reason,
                  `工作区：${executionCwd}`,
                  options.changes.length
                    ? ['变更条目（前 20 条）：', ...options.changes.slice(0, 20)].join('\n')
                    : '',
                  '本次产出**不构成**调研结论，请重新派发：若确需实现，请走完整 Phase 1-4 流水线；若确需调研，请确保只读。',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
                expectedOutput: '重新评估该工单性质后决定派发路径。',
                tier: collaboration.tier,
                escalations: collaboration.escalations,
                // 后续必须按实现类工单走完整流水线，绝不能继承 recon
                intent: 'implement',
                originMessageId:
                  collaboration.originMessageId ?? msg.messageId,
                round: collaboration.round + 1,
                maxRounds: collaboration.maxRounds,
                workspaceDir: executionCwd,
              });
            } catch (error) {
              console.error('[只读复核] 回告失败:', (error as Error).message);
              recordFriction(
                'SUBPROCESS_ESCAPE',
                `[只读复核] 回告失败: ${(error as Error).message}`,
              );
            }
          },
          buildAlert: ({ title, level, detail }) =>
            buildAlertCard({
              title,
              template: level,
              detail,
            }),
          recordFriction: (details) =>
            recordFriction('GATE_INTERCEPTION', `[只读调研越权] ${details}`),
        });

      void execution
        .then(async (rawResult) => {
          clearInterval(progressHeartbeat);

          // 失败路径的兜底必须在**复核之前**就位：复核自身会 reject（git 指纹读取、
          // 退订/回告卡片发送），一旦它抛错，异常上没有附件、闭包变量又还是空，
          // 失败探针就会静默失效——而那正是这段兜底声称要覆盖的场景。
          lastRoundToolCalls = rawResult.toolCalls;

          // 只调用一次：复核本身带副作用（告警卡 + 上游回告），调用两次会重复告警
          const reconOutcome = await runReconGuard();
          if (reconOutcome === 'violated' || reconOutcome === 'unverifiable') {
            return;
          }

          // 终结型控制工具的**入参纠错**：必须在所有提取点之前完成 ——
          // 否则下游看到的是「模型没调」，而真相只是「调错了参数」。
          //
          // recon 轮次由 `retryAfterGuard` 统一退化为不重试（见其定义处），
          // 此处无需再分叉；代价仅是「本轮失去一次自我修正机会」，
          // 探针仍会给出准确的 schema 告警。
          const result = await repairTerminalToolSubmissions({
            result: rawResult,
            retry: retryAfterGuard(rawResult),
          });
          lastRoundToolCalls = result.toolCalls;

          if (!isCompacting && !collaboration && result.sessionId) {
            await sessions.setCliSessionId(session.id, result.sessionId);
          }
          if (!isCompacting && !collaboration && result.stats?.contextWindowTokens) {
            contextWindows.set(session.id, result.stats.contextWindowTokens);
          }
          const clarificationRequest =
            !isCompacting && config.skills.includes('grill-me')
              ? findClarificationRequest(result.toolCalls)
              : undefined;
          if (clarificationRequest) {
            const flow = clarificationFlows.create({
              taskId,
              botId: config.id,
              sessionId: session.id,
              ownerOpenId,
              ownerUnionId,
              collaboration: collaboration
                ? collaborationOrigin(collaboration)
                : undefined,
              originalMessageId: msg.messageId,
              cardMessageId: cardId,
              replyInThread: hasThread,
              request: clarificationRequest,
            });
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            await cardUpdater.finish(buildClarificationCard({ flow }));
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: flow.ownerOpenId, name: '' },
              text: `需要你确认 ${clarificationRequest.questions.length} 个问题，请在上方卡片中选择。`,
              replyInThread: hasThread,
            });
            console.log(
              `[澄清] 已发送交互卡片 questions=${clarificationRequest.questions.length}`,
            );
            return;
          }
          let finalResult = result;
          let productSpecRequest: ProductSpecRequest | undefined;
          if (managesProductSpec) {
            const submission = await ensureProductSpecSubmission({
              result,
              defaultDeliveryMode: harnessOsConfig.defaultProductDeliveryMode,
              promptText: taskText,
              retry: retryAfterGuard(rawResult),
            });
            // 与终结工具纠错同一条不变式：修正轮的产物**并集**回首轮事实，
            // 而不是整份替换——否则同批里已成功的 dispatch_task / submit_tech_review
            // 会随替换一起消失（与「F1：替换使审批门禁静默失效」完全相同的一类缺陷）。
            finalResult = {
              ...submission.result,
              answer: result.answer || submission.result.answer,
              toolCalls: mergeToolCallLists(
                result.toolCalls,
                submission.result.toolCalls,
              ),
            };
            productSpecRequest = submission.request;
            if ((!collaboration || productSpecRequest) && finalResult.sessionId) {
              await sessions.setCliSessionId(session.id, finalResult.sessionId);
            }
            if ((!collaboration || productSpecRequest) && finalResult.stats?.contextWindowTokens) {
              contextWindows.set(
                session.id,
                finalResult.stats.contextWindowTokens,
              );
            }
          }
          const dispatchRequest = !isCompacting
            ? findDispatchTaskRequest(finalResult.toolCalls)
            : undefined;
          if (dispatchRequest) {
            // 三处拒绝都必须带标记：本轮之所以失败正是因为 dispatch_task 被拒，
            // 原因已由失败卡说明，失败路径的探针据此跳过，避免同一件事被两张卡重复告警。
            if (config.id !== harnessOsConfig.teamLeaderId) {
              throw markTerminalToolRejected(
                new Error('只有 CEO 助理可以调用 dispatch_task 派发团队任务'),
                'dispatch_task',
              );
            }
            const dispatchTarget = teamRegistry.get(
              dispatchRequest.targetBotId,
            );
            if (!dispatchTarget) {
              throw markTerminalToolRejected(
                new Error(
                  `团队成员未注册或未启用: ${dispatchRequest.targetBotId}`,
                ),
                'dispatch_task',
              );
            }
            if (dispatchRequest.targetBotId === config.id) {
              throw markTerminalToolRejected(
                new Error(`不能把团队任务派发给当前 bot: ${config.id}`),
                'dispatch_task',
              );
            }
            if (
              collaboration &&
              collaboration.round >= collaboration.maxRounds
            ) {
              throw markTerminalToolRejected(
                new Error(
                  `协作任务已达到轮次上限 ${collaboration.maxRounds}，不能继续派发`,
                ),
                'dispatch_task',
              );
            }
          }
          if (productSpecRequest && dispatchRequest) {
            throw markTerminalToolRejected(
              new Error('不能同时提交产品方案和派发团队任务'),
              'dispatch_task',
            );
          }
          if (productSpecRequest) {
            if (productSpecRequest.deliveryMode === 'local') {
              await assertProductSpecDocuments(
                session.workspaceDir,
                productSpecRequest,
              );
            }
            if (finalResult.sessionId) {
              await sessions.setCliSessionId(session.id, finalResult.sessionId);
            }
            if (finalResult.stats?.contextWindowTokens) {
              contextWindows.set(
                session.id,
                finalResult.stats.contextWindowTokens,
              );
            }
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            let objToken: string | undefined;
            if (
              productSpecRequest.deliveryMode === 'lark-doc' &&
              bot.resolveDocumentObjToken
            ) {
              objToken = await bot.resolveDocumentObjToken(
                productSpecRequest.documentUrl,
              );
            }
            const flow = productSpecFlows.create({
              taskId,
              botId: config.id,
              sessionId: session.id,
              ownerOpenId,
              ownerUnionId,
              collaboration: collaboration
                ? collaborationOrigin(collaboration)
                : undefined,
              // 凭据必须是任务发起时的人类消息，而非本跳入站消息，
              // 否则 escalation 召回后的重新提交会被误判为「同话题的另一个任务」
              originalMessageId:
                collaboration?.originMessageId ?? msg.messageId,
              cardMessageId: cardId,
              replyInThread: hasThread,
              request: productSpecRequest,
              objToken,
            });
            // 有了活跃方案流就必须恢复云文档评论订阅（退订是对账的另一半，
            // 二者必须成对出现，否则会出现「归档时退订了、新方案却再也没订阅上」）
            await reconcileDocumentSubscription(runtime, config.id);

            // Phase 3 刚性流水线：M/L 级协作任务在人类终审前，必须先经 Dev 技术可行性对抗审查
            const handoff = await handOffToTechReview({
              runtime,
              config,
              bot,
              replyToMessageId: msg.messageId,
              tierContext: collaboration,
              specFlow: flow,
              workspaceDir: session.workspaceDir,
              replyInThread: hasThread,
            });
            if (handoff) {
              await cardUpdater.finish(
                buildTaskCard({
                  title: cliAdapter.displayName,
                  // 本轮 product 的工作已经结束（移交给 Dev），不能留一张永远转圈的 running 卡片
                  status: 'success',
                  detail: `产品方案已移交 Phase 3 技术可行性对抗审查（第 ${handoff.round}/${handoff.maxRounds} 轮），等待 ${handoff.devName} 穿刺结论。`,
                }),
              );
              return;
            }

            await cardUpdater.finish(buildProductSpecApprovalCard(flow));
            const notificationText = productSpecRequest.warning
              ? `${productSpecRequest.warning}。产品方案已生成，请查看上方确认卡。`
              : '产品方案已生成，请查看上方确认卡。';
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: {
                openId: ownerOpenId,
                name: '',
              },
              text: notificationText,
              replyInThread: hasThread,
            });
            console.log('[产品文档] 已展示待确认产物');
            return;
          }
          const approvalRequest = !isCompacting
            ? findApprovalRequest(finalResult.toolCalls)
            : undefined;
          if (approvalRequest) {
            // 高危审批强门禁：所有物理不可逆高危操作次次强人工审核，彻底废除任何形式的免审白名单穿透
            const flow = approvalFlows.create({
              taskId,
              botId: config.id,
              sessionId: session.id,
              ownerOpenId,
              ownerUnionId,
              collaboration: collaboration
                ? collaborationOrigin(collaboration)
                : undefined,
              originalMessageId: msg.messageId,
              cardMessageId: cardId,
              replyInThread: hasThread,
              request: approvalRequest,
            });
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            await cardUpdater.finish(buildApprovalCard(flow));
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: ownerOpenId, name: '' },
              text: '开发者请求执行高危操作，请在上方卡片中拍板（300秒内未批准将自动拒绝）。',
              replyInThread: hasThread,
            });
            console.log(`[审批] 已展示审批卡 flow=${flow.token}`);
            const timeoutMs =
              (approvalRequest.timeoutSeconds ??
                DEFAULT_APPROVAL_TIMEOUT_SECONDS) * 1_000;
            const timeout = setTimeout(() => {
              void (async () => {
                const current = approvalFlows.get(flow.token);
                if (!current || current.status !== 'pending') return;
                const expired = approvalFlows.expire(flow.token);
                const botRuntime = botRuntimes.get(config.id);
                if (!expired || !botRuntime) return;
                try {
                  console.log(
                    `[审批门禁] flow=${flow.token} 达到 ${timeoutMs / 1000}s 超时限制，自动执行 Fail-Safe 拒绝`,
                  );
                  await scheduleApprovalContinuation({
                    runtime,
                    config,
                    flow: expired,
                    bot: botRuntime.bot,
                  });
                } catch (error) {
                  console.error(
                    '[审批] 超时自动拒绝失败:',
                    (error as Error).message,
                  );
                }
              })();
            }, timeoutMs);
            timeout.unref?.();
            return;
          }

          // 宿主侧角色复核：与 MCP 共用**同一份**权限真源（`core/tool-rbac`）。
          // 被 MCP 拒绝的调用现在也会回到这里（kill 与 tool_result 的竞态不再掩盖它），
          // 若执行方不复核，`request_escalation` / `submit_tech_review` /
          // `submit_arbitration_verdict` 这三个「MCP 有校验、宿主没有」的工具
          // 就会被越权执行。权限判定必须两侧同源，且**执行方也要判**。
          const roleAllows = (toolName: string) =>
            checkToolRbac(config.id, toolName).allowed;

          // 同一轮若同时产出技术审查裁决与升级申请，以技术审查裁决为准（更具体的状态机流转优先）
          const techReviewSubmission =
            !isCompacting && roleAllows('submit_tech_review')
              ? findTechReviewSubmission(finalResult.toolCalls)
              : undefined;
          // 协作转发：链内成员延续既有授权的通道（与 dispatch_task 的"创造授权"相对）
          const relayRequest = !isCompacting
            ? findRelayRequest(finalResult.toolCalls)
            : undefined;
          const relayBlockReason = relayRequest
            ? checkRelayGuardrails({
                selfBotId: config.id,
                targetBotId: relayRequest.targetBotId,
                targetRegistered: Boolean(
                  teamRegistry.get(relayRequest.targetBotId),
                ),
                chain: collaboration
                  ? {
                      reportToBotId: collaboration.reportToBotId,
                      round: collaboration.round,
                      maxRounds: collaboration.maxRounds,
                      tier: collaboration.tier,
                      objective: collaboration.objective,
                      intent: collaboration.intent,
                    }
                  : undefined,
                instruction: relayRequest.instruction,
              })
            : undefined;
          // 三层仲裁链第一层：ceo 初步裁决（独立工具，防止与"派发新任务"的归属混淆）
          const arbitrationVerdict =
            !isCompacting && roleAllows('submit_arbitration_verdict')
              ? findArbitrationVerdict(finalResult.toolCalls)
              : undefined;

          // 下游穿刺动态升级门禁：developer 在物理探查中发现复杂度超标时行使专业主权
          const escalationRequest =
            !isCompacting &&
            !techReviewSubmission &&
            roleAllows('request_escalation')
              ? findEscalationRequest(finalResult.toolCalls)
              : undefined;
          if (escalationRequest) {
            const escalatedTier = escalationRequest.suggestedTier;
            const priorEscalations = collaboration?.escalations ?? 0;
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);

            // 有界自愈熔断：升级次数超限说明 product 与 developer 无法就复杂度收敛，进入仲裁链
            if (priorEscalations >= MAX_TASK_ESCALATIONS) {
              // 任务改由仲裁接管，遗留的待审查流必须回收，否则会被同一话题的下个任务继承
              if (collaboration) {
                const orphanReview = techReviewFlows.findPendingByTaskId(
                  collaboration.taskId,
                );
                if (orphanReview) techReviewFlows.delete(orphanReview.token);
              }
              await openArbitration({
                runtime,
                config,
                bot,
                replyToMessageId: msg.messageId,
                replyInThread: hasThread,
                taskId: collaboration?.taskId ?? taskId,
                dispatchId: collaboration?.dispatchId,
                objective: collaboration?.objective ?? '任务复杂度争议',
                instruction: escalationRequest.reason,
                contradictionReason: `任务已连续 ${priorEscalations} 次动态升级，product 与 developer 仍未就任务复杂度与方案边界收敛`,
                round: collaboration?.round ?? 1,
                maxRounds:
                  collaboration?.maxRounds ?? config.collaborationMaxRounds,
                negotiationRound: collaboration?.negotiationRound,
                negotiationMaxRounds: collaboration?.negotiationMaxRounds,
                ownerOpenId,
                ownerUnionId,
                workspaceDir: session.workspaceDir,
                tier: collaboration?.tier,
                escalations: collaboration?.escalations,
                originalMessageId:
                  collaboration?.originMessageId ?? msg.messageId,
                trigger: 'escalation',
              });
              await cardUpdater.finish(
                buildAlertCard({
                  title: '任务复杂度争议 · 已进入仲裁链',
                  template: 'orange',
                  detail: `任务已连续 ${priorEscalations} 次动态升级仍未收敛，已由 ceo 助理先行初裁；若争议超出其授权边界会立即上浮请你裁定。`,
                }),
              );
              console.log(
                `[动态升级] task=${taskId} 升级次数达 ${priorEscalations}，熔断转入仲裁链`,
              );
              return;
            }

            await cardUpdater.finish(
              buildAlertCard({
                title: '任务动态升级 · 召回产品介入',
                template: 'yellow',
                detail: [
                  `developer 在物理代码探查中发现实际复杂度超出原定等级，已行使专业主权将任务升级为 ${escalatedTier} 级。`,
                  `升级理由：${escalationRequest.reason}`,
                  escalationRequest.evidence
                    ? `探查证据：${escalationRequest.evidence}`
                    : '',
                  '协同总线已重新编排流水线，召回 product 介入方案编制。',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              }),
            );
            try {
              await collaborationService.dispatch({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: msg.messageId,
                targetBotId: 'product',
                taskId,
                ownerOpenId,
                ownerUnionId,
                reportToBotId: collaboration?.reportToBotId ?? config.id,
                objective: `[动态升级 ${escalatedTier} 级] ${collaboration?.objective ?? '任务复杂度超标召回'}`,
                instruction: [
                  `developer 在执行任务时通过物理代码探查判定实际复杂度已达 ${escalatedTier} 级，超出原定轻量范围。`,
                  `升级理由：${escalationRequest.reason}`,
                  escalationRequest.evidence
                    ? `物理探查证据：${escalationRequest.evidence}`
                    : '',
                  '请立即介入执行 Phase 1 探查与调研，并输出方案与任务切片，交由 Dev 进行技术可行性审查。',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
                expectedOutput:
                  '经技术审查的方案与 Tickets 切片，或明确的架构冲突结论。',
                tier: escalatedTier,
                // 升级后开启新的**辩证**轮次（重新走 Phase 1，双方重新对抗），
                // 因此重置的是 negotiationRound，而不是链跳数。
                // 递归深度由 escalations 计数（MAX_TASK_ESCALATIONS）兜底：
                // 链跳数若也在此重置，发散防护网会被每次升级刷新，16 跳的网就名存实亡。
                round: collaboration ? collaboration.round + 1 : 1,
                maxRounds:
                  collaboration?.maxRounds ?? config.collaborationMaxRounds,
                negotiationRound: 1,
                negotiationMaxRounds: NEGOTIATION_MAX_ROUNDS,
                escalations: priorEscalations + 1,
                // 召回同样继承任务凭据，否则 product 重新提交的方案会被误判为「同话题的另一个任务」
                originMessageId:
                  collaboration?.originMessageId ?? msg.messageId,
                workspaceDir: session.workspaceDir,
              });
            } catch (error) {
              console.error(
                '[动态升级] 召回 product 失败:',
                (error as Error).message,
              );
              await bot.reply(
                msg.messageId,
                `动态升级流转失败：${(error as Error).message}`,
                hasThread,
              );
            }
            console.log(
              `[动态升级] task=${taskId} 升级为 ${escalatedTier} 级并召回 product`,
            );
            return;
          }

          // Phase 3 技术可行性对抗审查裁决流转
          if (techReviewSubmission) {
            const reviewFlow = techReviewFlows.get(
              techReviewSubmission.flowToken,
            );
            if (!reviewFlow) {
              await cardUpdater.finish(
                buildAlertCard({
                  title: '技术审查编号失效',
                  template: 'yellow',
                  detail: `收到无法识别的技术审查编号 ${techReviewSubmission.flowToken}，本轮审查结论未生效。若进程刚刚重启导致状态丢失，请由 ceo-assistant 重新发起该任务的协作。`,
                }),
              );
              return;
            }
            const approved = techReviewSubmission.verdict === 'approved';
            const updated = techReviewFlows.recordFeedback(
              reviewFlow.token,
              techReviewSubmission.comment ??
                (approved ? '技术可行性审查通过' : '存在未收敛的对抗意见'),
              approved,
            );
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);

            // 审查流已终结（重复或迟到的裁决）：旧裁决不得重新唤起已收敛的流程，
            // 否则 product 会去修改一份人类已经批准过的方案，并把 3 轮上限清零。
            if (!updated) {
              await cardUpdater.finish(
                buildAlertCard({
                  title: '技术审查已收敛',
                  template: 'yellow',
                  detail: `技术审查 ${reviewFlow.token} 当前状态为 ${reviewFlow.status}，已不接受新的裁决，本轮结论未生效。`,
                }),
              );
              return;
            }

            if (updated?.status === 'approved') {
              const specFlow = reviewFlow.specFlowToken
                ? productSpecFlows.get(reviewFlow.specFlowToken)
                : undefined;
              if (specFlow && specFlow.status === 'pending') {
                await cardUpdater.finish(
                  buildProductSpecApprovalCard(specFlow),
                );
                await sendResultNotification({
                  bot,
                  replyToMessageId: msg.messageId,
                  target: { openId: ownerOpenId, name: '' },
                  text: 'Phase 3 技术可行性审查已通过，方案已完成双重穿刺，请在上方卡片中终审。',
                  replyInThread: hasThread,
                });
                console.log(
                  `[技术审查] flow=${reviewFlow.token} 审查通过，已进入 Phase 4 人类终审`,
                );
              } else {
                await cardUpdater.finish(
                  buildAlertCard({
                    title: '关联方案已失效',
                    template: 'yellow',
                    detail:
                      '技术审查已通过，但关联的产品方案记录已失效或被更新，无法进入人类终审，请重新发起。',
                  }),
                );
              }
              // 审查流已收敛，状态由 productSpecFlow / 人类终审卡承接，及时释放避免无界堆积
              techReviewFlows.delete(reviewFlow.token);
              return;
            }

            if (updated?.status === 'arbitration_needed') {
              // 辩证界触顶 → 进入三层仲裁链（第一层 ceo 初裁）。
              // 注意这里传的是**链跳数**（collaboration.round/maxRounds）与
              // **辩证轮数**（reviewFlow.round/maxRounds）两组独立计数：
              // 前者决定这条链还能走多远，后者才是本次争议的烈度。
              await openArbitration({
                runtime,
                config,
                bot,
                replyToMessageId: msg.messageId,
                replyInThread: hasThread,
                taskId: reviewFlow.taskId,
                dispatchId: reviewFlow.dispatchId,
                objective: reviewFlow.title,
                instruction: reviewFlow.comments.join('\n\n'),
                contradictionReason: `Phase 3 技术可行性审查已达辩证第 ${reviewFlow.round}/${reviewFlow.maxRounds} 轮上限，双方尚未就方案收敛`,
                // 链跳数**不能**退回 reviewFlow.round 兜底：那是辩证轮数，
                // 写进链跳字段等于在降级路径上把发散防护网悄悄重置成一段新额度。
                round: collaboration ? collaboration.round + 1 : 1,
                maxRounds:
                  collaboration?.maxRounds ?? config.collaborationMaxRounds,
                negotiationRound: reviewFlow.round,
                negotiationMaxRounds: reviewFlow.maxRounds,
                trigger: 'negotiation',
                ownerOpenId: reviewFlow.ownerOpenId,
                ownerUnionId: reviewFlow.ownerUnionId,
                workspaceDir: reviewFlow.workspaceDir,
                tier: collaboration?.tier,
                escalations: collaboration?.escalations,
                originalMessageId:
                  collaboration?.originMessageId ?? reviewFlow.originMessageId,
              });
              await cardUpdater.finish(
                buildAlertCard({
                  title: 'Phase 3 辩证触顶 · 已进入仲裁链',
                  template: 'orange',
                  detail: `技术可行性审查已完成辩证第 ${reviewFlow.round}/${reviewFlow.maxRounds} 轮仍未收敛，已由 ceo 助理先行初裁。`,
                }),
              );
              console.log(
                `[技术审查] flow=${reviewFlow.token} 辩证第 ${reviewFlow.round}/${reviewFlow.maxRounds} 轮触顶，转入仲裁链`,
              );
              // 状态由 ArbitrationFlow 承接，释放审查流
              techReviewFlows.delete(reviewFlow.token);
              return;
            }

            // 退回产品修正，在**辩证额度**内继续收敛
            await cardUpdater.finish(
              buildTaskCard({
                title: cliAdapter.displayName,
                status: 'running',
                detail: `Phase 3 技术审查提出对抗意见，已退回 product 修正（辩证第 ${updated?.round ?? reviewFlow.round}/${reviewFlow.maxRounds} 轮）`,
              }),
            );
            await collaborationService.dispatch({
              senderConfig: config,
              senderBot: bot,
              replyToMessageId: msg.messageId,
              targetBotId: reviewFlow.productBotId,
              taskId: reviewFlow.taskId,
              ownerOpenId: reviewFlow.ownerOpenId,
              ownerUnionId: reviewFlow.ownerUnionId,
              reportToBotId: config.id,
              objective: `【Phase 3 技术审查退回修正】${reviewFlow.title}`,
              instruction: [
                `developer 完成第 ${reviewFlow.round} 轮技术可行性穿刺，判定方案尚未收敛。`,
                `对抗意见：\n${techReviewSubmission.comment ?? '（未提供具体意见）'}`,
                `请在辩证第 ${reviewFlow.maxRounds} 轮上限内快速修正方案（接口契约、测试接缝、物理可行性、回滚策略），修订完成后重新调用 request_spec_approval 提交同一任务方案。`,
                `技术审查编号：${reviewFlow.token}`,
              ].join('\n\n'),
              expectedOutput: '修订后的产品方案，并重新提交提审请求。',
              tier: collaboration?.tier ?? 'M',
              // 升级预算属于整条任务链，任何一跳都不能把它清零，否则 MAX_TASK_ESCALATIONS 形同虚设
              escalations: collaboration?.escalations,
              originMessageId: collaboration?.originMessageId ?? msg.messageId,
              // **两组计数必须分别传递**：这一跳走的是链跳数，消耗的是辩证额度。
              // 曾经把 reviewFlow.maxRounds（辩证 3 轮）直接当成链跳上限写进 maxRounds，
              // 使退回修正后的链路被 3 跳短绳勒死，与 16 跳发散网语义完全颠倒。
              round: collaboration ? collaboration.round + 1 : 1,
              maxRounds:
                collaboration?.maxRounds ?? config.collaborationMaxRounds,
              negotiationRound: updated?.round ?? reviewFlow.round,
              negotiationMaxRounds: reviewFlow.maxRounds,
              workspaceDir: reviewFlow.workspaceDir,
            });
            console.log(
              `[技术审查] flow=${reviewFlow.token} 退回 product 修正 round=${updated?.round}`,
            );
            return;
          }

          // ── 三层仲裁链第一层落地：ceo 初步裁决 ──
          if (arbitrationVerdict) {
            const flow = arbitrationFlows.get(arbitrationVerdict.flowToken);
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);

            if (!flow || flow.status !== 'pending_preliminary') {
              await cardUpdater.finish(
                buildAlertCard({
                  title: '仲裁编号失效',
                  template: 'yellow',
                  detail: `收到无法识别的仲裁编号 ${arbitrationVerdict.flowToken}（或该仲裁已不在待初裁状态），本轮初裁未生效。请核对协作指令中的仲裁编号。`,
                }),
              );
              return;
            }

            // 低风险判定 = 探针事实 ∧ ceo 自评，二者缺一即不成立。
            // 必须由宿主独立复核：ceo 自评只是**其中一个**必要条件，不是充分条件。
            const risk = assessArbitrationRisk({
              flow,
              ceoRiskLevel: arbitrationVerdict.riskLevel,
            });

            const recorded = arbitrationFlows.recordPreliminary(flow.token, {
              verdict: arbitrationVerdict.verdict,
              reasoning: arbitrationVerdict.reasoning,
              lowRisk: risk.lowRisk,
              riskReasons: risk.reasons,
            });
            if (!recorded) {
              await cardUpdater.finish(
                buildAlertCard({
                  title: '仲裁状态已变更',
                  template: 'yellow',
                  detail: '该仲裁在本轮初裁落地前已被处理，本次结论未生效。',
                }),
              );
              return;
            }

            const verdictLabel =
              recorded.preliminaryVerdict === 'adopt_product'
                ? '采纳 Product 方案'
                : recorded.preliminaryVerdict === 'adopt_developer'
                  ? '采纳 Developer 建议'
                  : '弃权（超出授权边界）';
            await cardUpdater.finish(
              buildAlertCard({
                title: '初步仲裁已完成',
                template:
                  recorded.preliminaryVerdict === 'abstain' ? 'yellow' : 'orange',
                detail: [
                  `ceo 初裁结论：${verdictLabel}`,
                  `初裁理由：${recorded.preliminaryReasoning ?? '（未提供）'}`,
                  `低风险复核：${risk.lowRisk ? '通过（探针事实 ∧ ceo 自评双条件成立）' : `未通过 —— ${risk.reasons.join('；')}`}`,
                  recorded.preliminaryVerdict === 'abstain'
                    ? '该争议已上浮人类裁定（弃权不产生裁决建议，永不会自动采纳）。'
                    : '争议已上浮人类终裁；人类未在时限内响应时，仅当低风险复核同时通过才会按初裁自动推进。',
                ].join('\n\n'),
              }),
            );

            // 第二层：把争议推给人类（携带初裁建议与仲裁叙事）
            await bot.replyCard(
              recorded.cardMessageId ?? msg.messageId,
              buildArbitrationCard(recorded),
              recorded.replyInThread ?? hasThread,
            );
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: recorded.ownerOpenId, name: '' },
              text:
                recorded.preliminaryVerdict === 'abstain'
                  ? 'ceo 已弃权：该争议超出其授权边界，需要你直接裁定，请在上方卡片中选择。'
                  : 'ceo 已给出初步仲裁建议，请在上方卡片中终裁（或采纳其建议）。',
              replyInThread: recorded.replyInThread ?? hasThread,
            });
            console.log(
              `[仲裁] flow=${recorded.token} 初裁=${recorded.preliminaryVerdict} lowRisk=${risk.lowRisk}，已上浮人类`,
            );
            return;
          }

          // 控制流承接判定必须在**完成卡片与完成通知之前**算出 ——
          // 它们是同一件事的两个口径，任何一个先定稿，都会留下
          // 「绿色：执行完成」与「黄色：控制流未承接」并存的矛盾现场
          // （原实现把探针放在通知之后、探针内又不 return，两个目标一个都没达成）。
          //
          // 承接集合按**提取结果**构造，而不是复刻一遍「哪些分支已经 return」：
          // 判断依据是事实（本轮确实建了哪条流），不是控制流的形状——
          // 后者会在任何一次分支调整后静默失配（本仓已有两次同型事故）。
          const unhandledTerminal = !isCompacting
            ? detectUnhandledTerminalCall({
                toolCalls: finalResult.toolCalls,
                handledToolNames: [
                  clarificationRequest && 'request_clarification',
                  productSpecRequest && 'request_spec_approval',
                  dispatchRequest && 'dispatch_task',
                  relayRequest && !relayBlockReason && 'relay_to_peer',
                  arbitrationVerdict && 'submit_arbitration_verdict',
                  approvalRequest && 'request_approval',
                  techReviewSubmission && 'submit_tech_review',
                  escalationRequest && 'request_escalation',
                  // 被技术审查优先级**刻意抢占**的升级申请不算「未承接」：
                  // 那是宿主自身的设计优先级（同轮两者并存时以更具体的状态机流转为准），
                  // 不是断链。不排除它会让探针为一个既定设计发卡并把成因归错。
                  techReviewSubmission && 'request_escalation',
                ].filter((name): name is string => Boolean(name)),
                skillGatedToolNames: skillGatedTerminalTools({
                  grillMeEnabled: config.skills.includes('grill-me'),
                  managesProductSpec,
                }),
                rbacDeniedToolNames,
              })
            : undefined;

          // 「未承接」时，**所有**「已完成」口径都必须带保留 ——
          // 完成卡片、人类通知、上游回执、协作转发指令，漏掉任何一处
          // 就还是会出现「控制流未承接」与「任务已完成」并存（本次要修掉的正是这个形态）。
          const controlFlowCaveat = unhandledTerminal
            ? `\n⚠️ 但本轮有一次控制流工具调用【${unhandledTerminal.toolName}】未被承接，其意图可能未被执行（详见告警卡片）。`
            : '';

          const rejection = relayBlockReason
            ? { toolName: 'relay_to_peer', reason: relayBlockReason }
            : (unhandledTerminal && (unhandledTerminal.cause === 'rbac' || unhandledTerminal.cause === 'skill' || unhandledTerminal.cause === 'unroutable'))
              ? { toolName: unhandledTerminal.toolName, reason: unhandledTerminal.detail }
              : undefined;

          if (rejection && !isCompacting) {
            console.warn(
              `[越权与规则拦截] 会话 ${session.id} 触发单轮自愈注入: tool=${rejection.toolName} reason=${rejection.reason}`,
            );
            recordFriction(
              'CONTROL_FLOW_UNHANDLED',
              `[单轮自愈拦截] tool=${rejection.toolName} role=${config.role}(${config.id}) | ${rejection.reason}`,
              session.workspaceDir ? basename(session.workspaceDir) : undefined,
            );

            try {
              await bot.replyCard(
                msg.messageId,
                buildAlertCard({
                  title: '操作被系统拦截提示',
                  template: 'yellow',
                  detail: `${config.role} (${config.id}) 调用了【${rejection.toolName}】，已被系统门禁拦截：${rejection.reason}`,
                }),
                hasThread,
              );
            } catch (err) {
              console.warn('[拦截卡片] 发送失败:', (err as Error).message);
            }

            const selfHealingPrompt = [
              '【系统规则与权限拦截通知】',
              `你刚才调用的工具【${rejection.toolName}】已被系统门禁拦截，原因如下：`,
              rejection.reason,
              '',
              '【单轮自愈要求】',
              '1. 本次为系统单轮自愈纠偏轮次，严禁再次调用该受限工具；',
              '2. 请直接在当前回复文本中，向用户明确说明当前分析进展、遇到的具体疑问或被系统拦截的原因；',
              '3. 若该操作需要其他角色协助（例如需要 CEO 助理统一发起任务派发，或需要产品经理主持需求澄清），请在回复中明确告知用户建议的下一步操作（例如建议用户在群内 @对应角色 推进）；',
              '4. 给出清晰完整的文本回复后，立即结束本轮。',
            ].join('\n');

            let selfHealingResult: CliRunResult | undefined;
            try {
              selfHealingResult = await retryCli(selfHealingPrompt, finalResult.sessionId);
            } catch (retryErr) {
              console.warn('[单轮自愈] 自动执行失败:', (retryErr as Error).message);
            }

            const healingAnswer =
              selfHealingResult?.answer?.trim() ||
              `⚠️ 本轮调用的工具【${rejection.toolName}】已被系统门禁拦截（${rejection.reason}），且自愈执行未能产出回复，请人工介入。`;
            const snapshot = progress.snapshot();
            await cardUpdater.finish(
              buildTaskCard({
                title: taskCardTitle,
                status: 'failed',
                detail: '已拦截未授权操作并完成自愈反馈',
                progress: snapshot,
                answer: healingAnswer,
                stats: selfHealingResult?.stats ?? finalResult.stats,
              }),
            );

            if (healingAnswer) {
              for (const chunk of splitLongText(healingAnswer)) {
                await bot.reply(msg.messageId, chunk, hasThread);
              }
            }

            sessionRunawayDetectors.delete(session.id);
            if (activeRuns.get(session.id)?.controller === run) {
              activeRuns.delete(session.id);
            }
            await markSessionIdle(sessions, session.id);
            return;
          }

          const snapshot = progress.snapshot();
          await cardUpdater.finish(
            isCompacting
              ? buildSessionNoticeCard({
                  title: finalResult.answer ? '暂时无需整理' : '上下文已整理',
                  template: finalResult.answer ? 'grey' : 'green',
                  detail:
                    finalResult.answer ||
                    [
                      `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                      'CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。',
                    ].join('\n\n'),
                })
              : buildTaskCard({
                  title: taskCardTitle,
                  status: 'success',
                  detail: `执行完成${controlFlowCaveat}`,
                  progress: snapshot,
                  answer: finalResult.answer,
                  stats: finalResult.stats,
                }),
          );
          if (!isCompacting && answerNeedsContinuation(finalResult.answer)) {
            for (const chunk of splitLongText(
              answerContinuation(finalResult.answer),
            )) {
              await bot.reply(msg.messageId, chunk, hasThread);
            }
          }
          console.log(
            `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? '(无)'}`,
          );
          sessionRunawayDetectors.delete(session.id);
          if (!collaboration) {
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: ownerOpenId, name: '' },
              text: isCompacting
                ? '上下文整理已完成，请查看上方结果。'
                : unhandledTerminal
                  ? '本轮有控制流工具调用未被承接，请看下方告警卡片。'
                  : '任务已完成，请查看上方结果。',
              replyInThread: hasThread,
            });
          }
          if (unhandledTerminal) {
            console.warn(
              `[控制流告警] 会话 ${session.id} 检测到未被承接的控制流工具调用: ${unhandledTerminal.toolName}（成因: ${unhandledTerminal.cause}）`,
            );
            // 接 M13：同类阻碍 ≥3 次应自动沉淀为公理候选，而不是只留在 console 里
            recordFriction(
              'CONTROL_FLOW_UNHANDLED',
              `[控制流未承接] cause=${unhandledTerminal.cause} tool=${unhandledTerminal.toolName} role=${config.role}(${config.id}) | ${unhandledTerminal.detail}`,
              session.workspaceDir ? basename(session.workspaceDir) : undefined,
            );
            // 告警卡是**附加**设施：发送失败不得拖垮本轮主流程
            // （本仓有过卡片 HTTP 400 阻断渲染的历史，且此处后面还有协作转发与回执要跑）
            try {
              await bot.replyCard(
                msg.messageId,
                buildAlertCard({
                  title: '控制流工具调用异常提示',
                  template: 'yellow',
                  detail: `${config.role} (${config.id}) ${unhandledTerminal.detail}`,
                }),
                hasThread,
              );
            } catch (error) {
              console.warn(
                `[控制流告警] 卡片发送失败: ${(error as Error).message}`,
              );
            }
          }
          if (!isCompacting) {
            try {

              // 协作转发（relay_to_peer）：链内成员把当前工件交给同伴继续处理。
              // 铁律：**不产生新授权** —— 目标/分级/轮次/工作区/回传对象全部沿原链继承，
              // 只有 instruction 与期望产出由转发方补充。任何一项可改写，转发即退化为越权派发后门。
              if (relayRequest && !relayBlockReason) {
                // 护栏全绿时 collaboration 必非空（checkRelayGuardrails 已保证），此处再次断言收窄类型
                if (!collaboration) return;
                try {
                  await collaborationService.dispatch({
                    senderConfig: config,
                    senderBot: bot,
                    replyToMessageId: msg.messageId,
                    targetBotId: relayRequest.targetBotId,
                    taskId: collaboration.taskId,
                    ownerOpenId: collaboration.ownerOpenId,
                    ownerUnionId: collaboration.ownerUnionId,
                    // 回传对象沿原链继承，禁止截流另起炉灶
                    reportToBotId: collaboration.reportToBotId,
                    // objective 沿原链继承，转发方无权改写任务授权边界
                    objective: collaboration.objective,
                    instruction: relayRequest.instruction,
                    expectedOutput: relayRequest.expectedOutput,
                    tier: collaboration.tier,
                    escalations: collaboration.escalations,
                    // 转发不改变工单性质：recon 链上转给 developer 仍是只读调研
                    intent: collaboration.intent,
                    originMessageId:
                      collaboration.originMessageId ?? msg.messageId,
                    capsule: assembleContextCapsule({
                      sourceTaskId: collaboration.taskId,
                      // 与收口装配保持**同一种命名**：同一条链上同一个工作区
                      // 若一处写绝对路径、一处写目录名，下游会把它们当成两个工作区
                      fromWorkspace: basename(session.workspaceDir),
                      toWorkspace: basename(session.workspaceDir),
                      objective: collaboration.objective,
                      tier: collaboration.tier,
                      approvedSpecPointer: specPointerOf(
                        productSpecFlows.findLatestByTaskId(
                          collaboration.taskId,
                          {
                            originMessageId:
                              collaboration.originMessageId ?? msg.messageId,
                          },
                        )?.request,
                      ),
                      distilledDecisionsSummary:
                        relayRequest.distilledDecisionsSummary ||
                        harvestLatestDecisionSummary(session.workspaceDir),
                      lineage: selectCapsuleLineage({
                        flows: productSpecFlows.listAll(),
                        taskId: collaboration.taskId,
                        currentCredential:
                          collaboration.originMessageId ?? msg.messageId,
                      }),
                    }),
                    round: collaboration.round + 1,
                    maxRounds: collaboration.maxRounds,
                    negotiationRound: collaboration.negotiationRound,
                    negotiationMaxRounds: collaboration.negotiationMaxRounds,
                    workspaceDir: session.workspaceDir,
                  });
                  console.log(
                    `[协作转发] task=${collaboration.taskId} ${config.id} -> ${relayRequest.targetBotId} round=${collaboration.round + 1}/${collaboration.maxRounds}`,
                  );
                } catch (error) {
                  const message = (error as Error).message;
                  console.error('[协作转发] 派发失败:', message);
                  await bot.reply(
                    msg.messageId,
                    `协作转发失败：${message}`,
                    hasThread,
                  );
                }
                return;
              }

              if (dispatchRequest) {
                // 结合显式声明与工作区物理探针进行 Tier 事实校准（M10 决策充分性）
                const probeResult = SeamProbeEngine.calibrateTier({
                  // 分级单调不降：既不能被重新探针降级，也不能被某一跳显式声明为 S 而降级，
                  // 否则链路中已定级的 M/L 任务可绕过 Phase 3。探针仍保留上调能力。
                  declaredTier: maxTaskTier(
                    dispatchRequest.tier,
                    collaboration?.tier,
                  ),
                  objective: dispatchRequest.objective,
                  instruction: dispatchRequest.instruction,
                });
                const effectiveTier = probeResult.calibratedTier;
                if (probeResult.escalated) {
                  console.log(
                    `[物理探针校准] 任务等级已由上游定级的 ${probeResult.declaredTier} 校准为 ${probeResult.calibratedTier}：${probeResult.reason}`,
                  );
                }

                // 已确认方案必须锚定到具体产物指针，不能只凭派发者自己写下的“方案”二字自证，
                // 否则 M/L 级直派门禁可被同一段 LLM 文案自签放行。
                const hasApprovedSpec = detectApprovedSpec({
                  objective: dispatchRequest.objective,
                  instruction: dispatchRequest.instruction,
                  chainObjective: collaboration?.objective,
                });

                // 工单性质：默认 implement（fail-closed）。只有显式 recon 才走只读调研分支，
                // 且事后由 git 变更探针物理复核——声明不可信，事实才可信（M10）。
                const taskIntent = dispatchRequest.intent ?? 'implement';
                const isRecon = taskIntent === 'recon';

                // M/L 级任务刚性流水线约束：若 CEO 助理试图直接派发 Dev 且无已批准方案，自动拦截并重路由给 product。
                // **只读调研例外**：PRD Phase 1 明确要求 Dev 在方案批准前做本地 Seam 探查，
                // 若把调研也拦下，PRD 的两条要求会互相打架（门禁拦的是"跳过方案下实现单"，不是"任何与 Dev 的交互"）。
                if (
                  dispatchRequest.targetBotId === 'developer' &&
                  effectiveTier !== 'S' &&
                  !hasApprovedSpec &&
                  !isRecon
                ) {
                  console.log(
                    `[分级协同] 检测到 ${effectiveTier} 级任务直接派发 developer 且无已确认方案，自动拦截并激活 Phase 1 方案探查阶段路由给 product`,
                  );
                  dispatchRequest.targetBotId = 'product';
                  dispatchRequest.objective = `[Phase 1 探查与方案编制] ${dispatchRequest.objective}`;
                  dispatchRequest.instruction = `【刚性 5 阶段流水线 · Phase 1】本任务经物理探针校准为 ${effectiveTier} 级任务，已由协同总线自动激活自适应流水线。\n请首先使用 grill-me / lark-doc 进行需求澄清、资产探查与方案编制。\n\n原始任务指令：\n${dispatchRequest.instruction}`;
                }

                await collaborationService.dispatch({
                  senderConfig: config,
                  senderBot: bot,
                  replyToMessageId: msg.messageId,
                  targetBotId: dispatchRequest.targetBotId,
                  taskId,
                  ownerOpenId,
                  ownerUnionId,
                  reportToBotId: collaboration?.reportToBotId ?? config.id,
                  objective: dispatchRequest.objective,
                  instruction: dispatchRequest.instruction,
                  expectedOutput: dispatchRequest.expectedOutput,
                  targetWorkspace: dispatchRequest.targetWorkspace,
                  tier: effectiveTier,
                  // 无状态上下文胶囊：让下游在新会话中仍能看到上游目标与已确认方案指针
                  capsule: assembleContextCapsule({
                    sourceTaskId: taskId,
                    fromWorkspace: basename(session.workspaceDir),
                    // 与收口装配统一为 basename：总纲要求「去物理路径」，
                    // 且链上同一工作区出现两种命名会让下游误判为两个工作区。
                    toWorkspace: basename(
                      dispatchRequest.targetWorkspace ?? session.workspaceDir,
                    ),
                    objective: dispatchRequest.objective,
                    tier: effectiveTier,
                    // 权威方案指针：下游据此免于重复探查已决策事项
                    approvedSpecPointer: specPointerOf(
                      productSpecFlows.findLatestByTaskId(taskId, {
                        originMessageId:
                          collaboration?.originMessageId ?? msg.messageId,
                      })?.request,
                    ),
                    // 上游显式提供的决策摘要（若未提供，从裁决文档结构段自动派生）
                    distilledDecisionsSummary:
                      dispatchRequest.distilledDecisionsSummary ||
                      harvestLatestDecisionSummary(
                        dispatchRequest.targetWorkspace ?? session.workspaceDir,
                      ),
                    // 承接来源：显式声明本链续接自哪一条已收口的上游链，
                    // 使「先单独对话、再启动协作链」不再依赖凭据过滤的偶然放行
                    lineage: selectCapsuleLineage({
                      flows: productSpecFlows.listAll(),
                      taskId,
                      currentCredential:
                        collaboration?.originMessageId ?? msg.messageId,
                    }),
                  }),
                  // 升级预算属于整条任务链，任何一跳都不能把它清零
                  escalations: collaboration?.escalations,
                  intent: taskIntent,
                  originMessageId:
                    collaboration?.originMessageId ?? msg.messageId,
                  round: collaboration ? collaboration.round + 1 : 1,
                  maxRounds:
                    collaboration?.maxRounds ?? config.collaborationMaxRounds,
                  // 辩证轮数只由 Phase 3 的对抗循环推进，普通链路跳转只是**透传**，
                  // 否则每转发一次都会消耗辩证额度，3 轮收敛界会被链路长度淹没。
                  negotiationRound: collaboration?.negotiationRound ?? 1,
                  negotiationMaxRounds:
                    collaboration?.negotiationMaxRounds ?? NEGOTIATION_MAX_ROUNDS,
                  workspaceDir: session.workspaceDir,
                });
                if (!collaboration) {
                  const targetName =
                    botRuntimes.get(dispatchRequest.targetBotId)?.identity
                      .name ?? dispatchRequest.targetBotId;
                  await sendResultNotification({
                    bot,
                    replyToMessageId: msg.messageId,
                    target: { openId: ownerOpenId, name: '' },
                    text: `任务已交给 ${targetName}，请查看上方协作消息。`,
                    replyInThread: hasThread,
                  });
                }
              } else if (collaboration) {
                if (collaboration.reportToBotId === config.id) {
                  // 完成态必须与「链上是否仍有未收敛流程」联动。
                  // 否则：Dev 在 Phase 3 未调用 submit_tech_review 而以散文收尾（或经中转回传）时，
                  // 此处会向人类谎报「任务已完成」，而技术审查流与方案流其实都还 pending，
                  // 方案永远走不到人类终审。这是链路谎报的**根因**，与 relay 通道无关。
                  const taskCredential =
                    collaboration.originMessageId ?? msg.messageId;
                  const strandedReview = techReviewFlows.findPendingByTaskId(
                    collaboration.taskId,
                    { originMessageId: taskCredential },
                  );
                  const strandedSpec = productSpecFlows.findPendingByTaskId(
                    collaboration.taskId,
                    { originMessageId: taskCredential },
                  );
                  // 待初裁的仲裁流同样是「未收敛」：ceo 若以散文收尾而非调用
                  // submit_arbitration_verdict，链路不得向人类谎报完成。
                  const strandedArbitration =
                    arbitrationFlows.findOpenByTaskId(collaboration.taskId, {
                      originMessageId: taskCredential,
                    });
                  // 仲裁未决时**无条件**抑制完成：链路的分歧还没有第三方结论，
                  // 此时报「已完成」就是谎报。曾把它和审查流一起挂在
                  // `round < maxRounds` 之下，导致轮次触顶后（恰恰是仲裁最可能发生的时刻）
                  // 反而不再抑制 —— 条件写反了。
                  const arbitrationPending =
                    strandedArbitration?.status === 'pending_preliminary' ||
                    strandedArbitration?.status === 'pending_human';
                  // 审查流/方案流仍在收敛时，仅在未达轮次上限时抑制：
                  // 已达上限的链路必须由下方的熔断/仲裁分支接管，否则会被一条无人能响应的提示堵死。
                  if (
                    arbitrationPending ||
                    ((strandedReview || strandedSpec) &&
                      collaboration.round < collaboration.maxRounds)
                  ) {
                    const what = strandedArbitration
                      ? strandedArbitration.status === 'pending_preliminary'
                        ? 'ceo 初步仲裁（第一层）'
                        : '人类仲裁裁决（第二层）'
                      : strandedReview
                        ? 'Phase 3 技术可行性审查'
                        : '产品方案人类终审';
                    await bot.replyCard(
                      msg.messageId,
                      buildAlertCard({
                        title: '链路尚未收敛，本次不计为完成',
                        template: 'yellow',
                        detail: [
                          `协作任务「${collaboration.objective}」仍有未收敛的环节：${what}。`,
                          '因此本次回传未被计为任务完成，也**不会**向用户发送完成通知。',
                          strandedReview
                            ? `请 reviewer 使用 submit_tech_review（技术审查编号：${strandedReview.token}）回传裁决。`
                            : strandedArbitration?.status ===
                                'pending_preliminary'
                              ? `请 ceo-assistant 使用 submit_arbitration_verdict（仲裁编号：${strandedArbitration.token}）回传初裁。`
                              : strandedArbitration
                                ? `争议已上浮人类（仲裁编号：${strandedArbitration.token}），请在上方仲裁卡中裁决。`
                                : '请完成方案的人类终审后再继续。',
                        ].join('\n\n'),
                      }),
                      hasThread,
                    );
                    console.log(
                      `[协作] task=${collaboration.taskId} 仍有未收敛流程，抑制完成通知`,
                    );
                    return;
                  }
                  // 研发交付回执：developer 完成实施时，方案流推进到「已交付待验收」，
                  // 并把实施简报回写云文档；随后推送两段式验收卡（含打回归正）。
                  const delivered = await markDeliveredFromDevReport({
                    runtime,
                    bot,
                    taskId: collaboration.taskId,
                    fromBotId: collaboration.fromBotId,
                    credential: taskCredential,
                    summary: finalResult.answer ?? '',
                  });
                  if (delivered) {
                    await bot.replyCard(
                      msg.messageId,
                      buildDeliveryReviewCard({
                        flow: delivered,
                        devSummary: finalResult.answer,
                      }),
                      hasThread,
                    );
                  }
                  await sendResultNotification({
                    bot,
                    replyToMessageId: msg.messageId,
                    target: { openId: collaboration.ownerOpenId, name: '' },
                    text:
                      (delivered
                        ? `协作任务“${collaboration.objective}”已完成研发实施，请在上方验收卡中确认验收或打回归正。`
                        : `协作任务“${collaboration.objective}”已经完成，请查看上方结果。`) +
                      controlFlowCaveat,
                    replyInThread: hasThread,
                  });
                } else if (collaboration.round >= collaboration.maxRounds) {
                  // 发散防护网触顶 → **熔断终止**，不是仲裁。
                  // 语义分离：仲裁回答「双方谁对」，熔断回答「这条链已经跑偏了」。
                  // 若此处仍走仲裁，人类会被要求在一次本无收敛趋势的争论中选边，
                  // 而 3 轮辩证界也会被 16 跳的链路额度淹没。
                  await circuitBreakChain({
                    runtime,
                    bot,
                    replyToMessageId: msg.messageId,
                    replyInThread: hasThread,
                    ownerOpenId: collaboration.ownerOpenId,
                    taskId: collaboration.taskId,
                    objective: collaboration.objective,
                    lastResult: finalResult.answer,
                    round: collaboration.round,
                    maxRounds: collaboration.maxRounds,
                    reason: `链路已消耗全部 ${collaboration.maxRounds} 跳额度仍未收敛`,
                  });
                } else {
                  await collaborationService.dispatch({
                    senderConfig: config,
                    senderBot: bot,
                    replyToMessageId: msg.messageId,
                    targetBotId: collaboration.reportToBotId,
                    taskId: collaboration.taskId,
                    ownerOpenId: collaboration.ownerOpenId,
                    ownerUnionId: collaboration.ownerUnionId,
                    reportToBotId: collaboration.reportToBotId,
                    objective: collaboration.objective,
                    instruction: [
                      `${botRuntimes.get(config.id)?.identity.name ?? config.id} 已完成当前协作任务，下面是它的结果：${
                        unhandledTerminal
                          ? `（注意：本轮有一次控制流工具调用【${unhandledTerminal.toolName}】未被承接，其意图可能未被执行）`
                          : ''
                      }`,
                      finalResult.answer,
                      '请基于这份结果继续组织后续工作：仍需其他成员参与时使用 dispatch_task 继续派发；已经可以交付时，直接向用户汇总结论。',
                    ].join('\n\n'),
                    expectedOutput:
                      '继续推进原任务，或在已经完成时向用户给出最终结论。',
                    // 分级与升级计数必须随链路透传，否则下游回填会丢失 M/L 级上下文而绕过 Phase 3
                    tier: collaboration.tier,
                    escalations: collaboration.escalations,
                    originMessageId:
                      collaboration.originMessageId ?? msg.messageId,
                    round: collaboration.round + 1,
                    maxRounds: collaboration.maxRounds,
                    negotiationRound: collaboration.negotiationRound,
                    negotiationMaxRounds: collaboration.negotiationMaxRounds,
                    workspaceDir: session.workspaceDir,
                  });
                }
              }
            } catch (error) {
              const message = (error as Error).message;
              console.error('[协作] 派发失败:', message);
              await bot.reply(
                msg.messageId,
                `协作派发失败：${message}`,
                hasThread,
              );
            }
          }
        })
        .catch(async (error) => {
          clearInterval(progressHeartbeat);
          // 失败路径同样必须复核：recon 完全可能「先写坏文件、再崩溃/超时/被熔断」，
          // 若只在成功分支检查，破坏既成事实而上游只收到一句"执行异常"，无人归因。
          const failedReconOutcome = await runReconGuard();
          if (
            failedReconOutcome === 'violated' ||
            failedReconOutcome === 'unverifiable'
          ) {
            return;
          }
          if (run.signal.aborted) {
            console.log('[CLI] 任务已取消');
            await cardUpdater.finish(
              buildTaskCard({
                title: taskCardTitle,
                status: 'cancelled',
                detail:
                  activeRun.cancelMode === 'close'
                    ? '本次任务已停止，当前会话已经关闭。'
                    : isCompacting
                      ? '整理已停止，当前 CLI 会话没有改变。'
                      : '本次任务已停止。你可以继续在当前话题里提问。',
                progress: progress.snapshot(),
              }),
            );
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: senderRuntime?.identity ?? {
                openId: ownerOpenId,
                name: '',
              },
              text: '任务已停止，请查看上方状态。',
              replyInThread: hasThread,
            });
            return;
          }
          const message = (error as Error).message;
          console.error('[CLI] 执行失败:', message);
          const isSilentTimeout = message.includes('STEP_TIMEOUT');
          const isCircuitBroken = message.includes('RUNAWAY_CIRCUIT_BROKEN');

          // 失败路径的**同款**探针：成功分支有的判定，失败分支必须有。
          // 此前「调了终结工具又崩了」完全不可见（result 随异常丢失，探针又只写在成功分支）——
          // 与本仓已记录在案的「不变式检查只写成功分支」是同一类结构性缺陷。
          // 已被宿主规则拒绝的调用（RBAC、提审校验失败）不在此重复告警：失败卡已经说明了原因。
          const rejectedTerminalTool = readTerminalToolRejected(error);
          // 工具调用有两条来源：CLI 自己 reject 时挂在异常上的附件，
          // 以及宿主自己在 `.then` 里抛错时留在闭包里的「最近一次完成轮次」。
          const failedRoundToolCalls =
            readObservedToolCalls(error) ?? lastRoundToolCalls;
          const failedUnhandledTerminal = !isCompacting
            ? detectUnhandledTerminalCall({
                toolCalls: failedRoundToolCalls,
                handledToolNames: rejectedTerminalTool
                  ? [rejectedTerminalTool]
                  : [],
                skillGatedToolNames: skillGatedTerminalTools({
                  grillMeEnabled: config.skills.includes('grill-me'),
                  managesProductSpec,
                }),
                rbacDeniedToolNames,
              })
            : undefined;
          // 失败路径**只认「入参校验失败」这一种成因**。
          // 「入参合规但未承接」在本轮以失败收场时，无法区分「宿主规则拒绝」（原因已写在失败卡上）
          // 与「宿主在承接之前就死了」（超时/熔断/守卫拦截），据此发卡会把人类引向
          // 「去查角色职责与编号是否有效」——而真相与这些毫无关系。
          // M13 计次同样只对 schema 生效：误报三次会直接导出一份假的 DC 反模式候选。
          if (failedUnhandledTerminal?.cause === 'schema') {
            console.warn(
              `[控制流告警] 会话 ${session.id} 失败轮次中检测到未被承接的控制流工具调用: ${failedUnhandledTerminal.toolName}（成因: ${failedUnhandledTerminal.cause}）`,
            );
            recordFriction(
              'CONTROL_FLOW_UNHANDLED',
              `[控制流未承接·失败路径] cause=${failedUnhandledTerminal.cause} tool=${failedUnhandledTerminal.toolName} role=${config.role}(${config.id}) | 本轮失败: ${message} | ${failedUnhandledTerminal.detail}`,
              session.workspaceDir ? basename(session.workspaceDir) : undefined,
            );
            // 附加告警卡：发送失败不得阻断后面的失败卡与上游异常回告
            try {
              await bot.replyCard(
                msg.messageId,
                buildAlertCard({
                  title: '控制流工具调用异常提示',
                  template: 'yellow',
                  detail: `${config.role} (${config.id}) ${failedUnhandledTerminal.detail}（本轮执行随后失败，因此该调用是否已产生后果尚未确认）`,
                }),
                hasThread,
              );
            } catch (alertError) {
              console.warn(
                `[控制流告警] 卡片发送失败: ${(alertError as Error).message}`,
              );
            }
          }

          if (isSilentTimeout || isCircuitBroken) {
            // 触发死循环熔断或3分钟静默强杀时，向话题发送红色告警卡片
            await bot.replyCard(
              msg.messageId,
              buildAlertCard({
                title: isSilentTimeout
                  ? '单步执行超时熔断告警'
                  : '工具调用死循环熔断告警',
                template: 'red',
                detail: isSilentTimeout
                  ? 'CLI 单步执行超过 3 分钟（180 秒）无任何输出，系统已执行静默强杀保护以防止僵死。'
                  : '检测到连续 3 次相同工具、相同参数并产生相同错误，系统已主动触发硬熔断阻断死循环。',
                stderrSnippet: message,
              }),
              hasThread,
            );
          }

          await cardUpdater.finish(
            buildTaskCard({
              title: taskCardTitle,
              status: 'failed',
              detail: isCompacting
                ? '上下文整理失败，当前 CLI 会话没有改变。'
                : isSilentTimeout
                  ? '单步执行超时（180s 静默强杀），任务已终止。'
                  : isCircuitBroken
                    ? '死循环识别触发硬熔断，任务已终止。'
                    : '执行没有完成。你可以调整指令后，在当前话题里重试。',
              technicalDetail: message,
              progress: progress.snapshot(),
            }),
          );
          if (collaboration) {
            try {
              await collaborationService.dispatch({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: msg.messageId,
                targetBotId: collaboration.reportToBotId,
                taskId: collaboration.taskId,
                ownerOpenId: collaboration.ownerOpenId,
                ownerUnionId: collaboration.ownerUnionId,
                reportToBotId: collaboration.reportToBotId,
                objective: collaboration.objective,
                instruction: [
                  `【协作执行异常通知】`,
                  `${botRuntimes.get(config.id)?.identity.name ?? config.id} 在执行协作任务“${collaboration.objective}”时发生错误：`,
                  message,
                  '请评估是否需要调整指令后重新派发，或向用户汇报当前异常。',
                ].join('\n\n'),
                expectedOutput: '评估失败原因并决定重试或汇报用户。',
                tier: collaboration.tier,
                escalations: collaboration.escalations,
                originMessageId: collaboration.originMessageId ?? msg.messageId,
                round: collaboration.round + 1,
                maxRounds: collaboration.maxRounds,
                // 失败回传同样要透传辩证计数：漏传会让下游提示词按缺省渲染「辩证第 1/3 轮」，
                // 使接收方误判对抗已重置（可观测性失真而非门禁失效，但仍是失真）。
                negotiationRound: collaboration.negotiationRound,
                negotiationMaxRounds: collaboration.negotiationMaxRounds,
                workspaceDir: session.workspaceDir,
              });
            } catch (dispatchError) {
              console.error(
                '[协作] 失败状态回传失败:',
                (dispatchError as Error).message,
              );
              // 失败回传本身失败 = 上游永远等不到这条链的结局，属最隐蔽的断链，
              // 必须留下可聚合的痕迹（人类已在下方失败卡上被告知，此处只补归因）。
              recordFriction(
                'SUBPROCESS_ESCAPE',
                `[失败回传] 无法回传异常: ${(dispatchError as Error).message}`,
              );
            }
          } else {
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: senderRuntime?.identity ?? {
                openId: ownerOpenId,
                name: '',
              },
              text: '任务执行失败，请查看上方错误信息。',
              replyInThread: hasThread,
            });
          }
        })
        .finally(async () => {
          clearInterval(progressHeartbeat);
          sessionRunawayDetectors.delete(session.id);
          if (activeRuns.get(session.id)?.controller === run) {
            activeRuns.delete(session.id);
          }
          try {
            await markSessionIdle(sessions, session.id);
          } catch (error) {
            console.error('[会话] 保存空闲状态失败:', (error as Error).message);
          }
        })
        .catch((error) => {
          console.error('[任务] 回传或收尾失败:', (error as Error).message);
        });
    },
  });
  const identity = await startedBot.getIdentity();
  const botRuntime = { config, bot: startedBot, identity };
  botRuntimes.set(config.id, botRuntime);
  persistBotIdentities();
  // 订阅对账取代无条件订阅：启动时若无活跃方案流就不订阅，
  // 避免「重启一次就多一份永不撤销的评论监听」随文档量线性累积。
  if (config.skills.includes('lark-drive')) {
    await reconcileDocumentSubscription(runtime, config.id);
  }
  console.log(
    `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
  );
}

function scheduleDocumentComment(
  config: BotConfig,
  bot: Bot,
  comment: IncomingDocumentComment,
): void {
  if (!comment.mentionedBot) return;
  const flow = productSpecFlows.findCommentRoutableByDocument(
    config.id,
    comment.fileToken,
  );
  if (!flow) {
    console.log(
      `[产品评论] 忽略未关联方案的评论 file=${comment.fileToken}`,
    );
    return;
  }
  // 划词评论双代币自愈登记：若收到的是底层 Docx obj_token 且方案尚未记录，自动回填持久化
  if (
    !flow.objToken &&
    flow.request.deliveryMode === 'lark-doc' &&
    comment.fileToken !== documentToken(flow.request.documentUrl)
  ) {
    productSpecFlows.setObjToken(flow.token, comment.fileToken);
  }
  // 停滞休眠档位：订阅仍在（零 API 成本），但**本地忽略**事件。
  // 这样既保住了「保留查阅入口与就绪状态」，又不再产生 LLM 往返与队列查找。
  // 人类在话题里的任意交互会触发热激活，休眠随之中止。
  if (flow.quarantined) {
    console.log(
      `[产品评论] flow=${flow.token} 处于停滞休眠，本次评论已忽略（交互可热激活）`,
    );
    return;
  }

  const eventKey =
    comment.eventId ||
    [comment.fileToken, comment.commentId, comment.replyId].join(':');
  if (processedDocumentCommentEvents.has(eventKey)) return;
  rememberDocumentCommentEvent(eventKey);

  const workingReaction = bot
    .setDocumentCommentWorking(comment, true)
    .then(() => true)
    .catch((error) => {
      console.warn(
        '[产品评论] 添加处理中表情失败，继续执行:',
        (error as Error).message,
      );
      return false;
    });
  const previous =
    documentCommentQueues.get(flow.sessionId) ?? Promise.resolve();
  const queued = Promise.all([
    previous.catch(() => undefined),
    workingReaction,
  ]).then(async ([, reactionAdded]) => {
    try {
      await runProductDocumentComment({
        runtime,
        bot,
        flow,
        comment,
      });
    } finally {
      if (reactionAdded) {
        await bot.setDocumentCommentWorking(comment, false).catch((error) => {
          console.warn(
            '[产品评论] 移除处理中表情失败:',
            (error as Error).message,
          );
        });
      }
    }
  });
  documentCommentQueues.set(flow.sessionId, queued);
  void queued
    .catch((error) => {
      console.error('[产品评论] 处理失败:', (error as Error).message);
      return bot
        .replyToDocumentComment(
          comment,
          `这条评论暂时没有处理完成：${(error as Error).message}`,
        )
        .catch((replyError) => {
          console.error('[产品评论] 回写失败:', (replyError as Error).message);
        });
    })
    .finally(() => {
      if (documentCommentQueues.get(flow.sessionId) === queued) {
        documentCommentQueues.delete(flow.sessionId);
      }
    });
}

function rememberDocumentCommentEvent(eventKey: string): void {
  processedDocumentCommentEvents.add(eventKey);
  if (
    processedDocumentCommentEvents.size <=
    MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS
  )
    return;
  const oldest = processedDocumentCommentEvents.values().next().value;
  if (oldest) processedDocumentCommentEvents.delete(oldest);
}

await Promise.all(
  botConfigs.map((config) => startConfiguredBot(config, collaborationService)),
);

await scheduler.start();
startScheduleFileWatcher({ scheduler, filePath: scheduleFilePath });
startScheduleApi({
  scheduler,
  scheduleStore,
  runStore: scheduleRunStore,
  port: Number(process.env.SCHEDULE_API_PORT ?? 3101),
  token: process.env.SCHEDULE_API_TOKEN,
});

// 统一调度引擎注册系统内置任务（消灭游离 setInterval，在 /schedules 与管理大盘中可观测可控）
scheduler.ensureBuiltinTask({
  id: 'sys-arbitration-sweep',
  rule: { kind: 'interval', everyMs: 5 * 60 * 1000 },
  prompt: '执行仲裁超时巡检与三层状态机流转',
  targetBotId: harnessOsConfig.teamLeaderId,
  chatId: 'system',
  creatorOpenId: 'system',
});
scheduler.ensureBuiltinTask({
  id: 'sys-lifecycle-sweep',
  rule: { kind: 'cron', expression: '0 4 * * *', timezone: 'Asia/Shanghai' },
  prompt: '执行方案生命周期 7 天停滞休眠与 14 天静默归档巡检',
  targetBotId: 'product',
  chatId: 'system',
  creatorOpenId: 'system',
});
scheduler.ensureBuiltinTask({
  id: 'sys-scratch-hygiene-sweep',
  rule: { kind: 'cron', expression: '0 3 * * *', timezone: 'Asia/Shanghai' },
  prompt:
    '执行工作区清理巡检：自动扫描当前工作区 .scratch/ 下超过 7 天无改动的临时目录，移送至 .scratch/.archive/ 并生成封存清单，根治本地目录无限腐烂。',
  targetBotId: 'developer',
  workspace: '.',
  chatId: 'system',
  creatorOpenId: 'system',
});
scheduler.ensureBuiltinTask({
  id: 'sys-mistake-book-audit',
  rule: { kind: 'cron', expression: '0 18 * * 5', timezone: 'Asia/Shanghai' },
  prompt:
    '执行代码库错题本配额巡检：确定性读取 CLAUDE.md，统计「活跃免疫条目」行数（上限 35 条硬门禁）。当条目数 ≥30 时主动生成内化告警，督促将成熟经验通过单测/架构代码吸收后退役，杜绝规则无限膨胀。',
  targetBotId: 'developer',
  workspace: '.',
  chatId: 'system',
  creatorOpenId: 'system',
});
scheduler.ensureBuiltinTask({
  id: 'sys-wiki-alignment-sweep',
  rule: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Shanghai' },
  prompt:
    '执行知识库与云文档对账巡检（每周一 09:00）：\n' +
    '1. [前置空间探针与安全跳过] 检查当前工作区配置（如 bots.json 或环境变量）中是否声明了有效的 wikiSpaceId 或 wikiSpaceUrl；若未开通或未配置知识空间，必须幂等安全跳过（输出「当前工作区未开通/未配置 Wiki 空间，跳过对账」），严禁盲发 API 请求；若凭证失效需报告鉴权告警；\n' +
    '2. [对账执行] 仅在空间有效时扫描飞书云空间，检查是否存在未挂载至 Wiki 目录树的孤岛 PRD，对账已交付方案生命周期。',
  targetBotId: 'product',
  chatId: 'system',
  creatorOpenId: 'system',
});
void sweepArbitrations({ runtime });
void sweepLifecycles({ runtime });
console.log(
  `[统一调度] 系统守护任务已注册至 Scheduler：仲裁巡检 (5m)、生命周期巡检 (Daily 04:00)、工作区清理巡检 (Daily 03:00)、错题本配额巡检 (Weekly Fri 18:00)、Wiki 对账巡检 (Weekly Mon 09:00)`,
);
