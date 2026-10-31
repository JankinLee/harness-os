import type { Bot } from '../im/lark.js';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildAlertCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from '../im/card.js';
import type { BotConfig } from '../core/bot-registry.js';
import {
  findClarificationRequest,
  formatClarificationAnswers,
  type ClarificationFlow,
} from '../core/clarification.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import { getCliAdapter } from '../cli/registry.js';
import { executeCli } from './cli-execution.js';
import { sendResultNotification } from './notification-service.js';
import { markSessionIdle } from './session-view.js';
import type { AppRuntime } from './runtime.js';
import { TERMINAL_CONTROL_TOOLS } from '../cli/app-tools.js';
import { assertProductSpecDocuments } from './product-spec-documents.js';
import { ensureProductSpecSubmission } from './product-spec-submission.js';
import { mergeToolCallLists } from './terminal-tool-submission.js';
import { handOffToTechReview } from './product-spec-routing.js';
import { findRelayRequest } from '../core/collaboration.js';
import { reconcileDocumentSubscription } from './lifecycle-runner.js';

export async function continueClarificationFlow(options: {
  runtime: AppRuntime;
  bot: Bot;
  config: BotConfig;
  flow: ClarificationFlow;
  run: AbortController;
  defaultDeliveryMode: 'local' | 'lark-doc';
}): Promise<void> {
  const { bot, config, flow, run, runtime, defaultDeliveryMode } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session) throw new Error('需求澄清对应的会话已经失效');

  const adapter = getCliAdapter(session.cliId);
  const progress = new TaskProgressTracker(
    Date.now,
    runtime.contextWindows.get(session.id),
    false,
  );
  const progressCardMessageId = await bot.replyCard(
    flow.originalMessageId,
    buildTaskCard({
      title: adapter.displayName,
      status: 'running',
      detail: '正在基于你的选择整理需求',
      progress: progress.snapshot(),
      abortSessionId: session.id,
    }),
    flow.replyInThread,
  );
  if (!progressCardMessageId) {
    throw new Error('飞书没有返回需求整理进度卡片的 message_id');
  }

  const cardUpdater = new ThrottledCardUpdater((card) =>
    bot.updateCard(progressCardMessageId, card),
  );
  const renderProgress = () => {
    const snapshot = progress.snapshot();
    cardUpdater.push(
      buildTaskCard({
        title: adapter.displayName,
        status: 'running',
        detail: snapshot.current || '正在整理需求',
        progress: snapshot,
        abortSessionId: session.id,
      }),
    );
  };
  const heartbeat = setInterval(renderProgress, 1_000);
  heartbeat.unref();

  try {
    const result = await executeCli(
      adapter,
      formatClarificationAnswers(flow),
      session.workspaceDir,
      session.cliSessionId,
      run.signal,
      [...TERMINAL_CONTROL_TOOLS],
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
      // 角色身份必须随每次 CLI 执行下发：漏传会让 MCP 侧
      // `checkToolRbac(undefined, …)` 命中 `!botId → allowed`，
      // 整条澄清续跑路径上所有工具都**不受角色门禁约束**（含 schedule_manage）。
      // 同族路径（index.ts:672 / approval-runner:86 / scheduled-task-runner）均已在案。
      { HARNESS_OS_BOT_ID: config.id },
      {
        holderId: `session:${session.id.slice(0, 8)}`,
      },
    );
    clearInterval(heartbeat);
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }

    // 溢出告警：本续流不支持协作转发，若模型在此调用 relay_to_peer，
    // CLI 会被 terminate 且结果被静默丢弃。必须显式告知，杜绝无声断链。
    if (findRelayRequest(result.toolCalls)) {
      await cardUpdater.finish(
        buildAlertCard({
          title: '协作转发未生效',
          template: 'yellow',
          detail:
            '检测到在本轮澄清流程中调用了 relay_to_peer，但该续流不支持转发。请在本话题中重新发起该转发请求。',
        }),
      );
      return;
    }

    const nextRequest = config.skills.includes('grill-me')
      ? findClarificationRequest(result.toolCalls)
      : undefined;
    if (nextRequest) {
      const nextFlow = runtime.clarificationFlows.create({
        taskId: flow.taskId,
        botId: config.id,
        sessionId: session.id,
        ownerOpenId: flow.ownerOpenId,
        ownerUnionId: flow.ownerUnionId,
        collaboration: flow.collaboration,
        originalMessageId: flow.originalMessageId,
        cardMessageId: progressCardMessageId,
        replyInThread: flow.replyInThread,
        request: nextRequest,
      });
      await cardUpdater.finish(buildClarificationCard({ flow: nextFlow }));
      await sendResultNotification({
        bot,
        replyToMessageId: flow.originalMessageId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: `还需要确认 ${nextRequest.questions.length} 个问题，请在上方卡片中选择。`,
        replyInThread: flow.replyInThread,
      });
      return;
    }

    const managesProductSpec =
      config.skills.includes('to-spec') || config.skills.includes('lark-doc');
    if (managesProductSpec) {
      const submission = await ensureProductSpecSubmission({
        result,
        defaultDeliveryMode,
        promptText: formatClarificationAnswers(flow),
        retry: (retryPrompt, resultSessionId) =>
          executeCli(
            adapter,
            retryPrompt,
            session.workspaceDir,
            resultSessionId ?? session.cliSessionId,
            run.signal,
            [...TERMINAL_CONTROL_TOOLS],
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
            { HARNESS_OS_BOT_ID: config.id },
          ),
      });
      // 与 index.ts 的同名路径保持同一条不变式：修正轮的产物**并集**回首轮事实，
      // 而不是整份替换 —— 否则首轮里已成功的终结调用会随替换一起消失
      // （「同类缺陷只修一半」是本仓已记录在案的形态）。
      const mergedResult = {
        ...submission.result,
        answer: result.answer || submission.result.answer,
        toolCalls: mergeToolCallLists(
          result.toolCalls,
          submission.result.toolCalls,
        ),
      };

      // retry 轮同样可能产出 relay 调用：上面只检查了首轮 result，
      // 若 retry 轮发出 relay，CLI 会被 terminate 且结果被静默丢弃（与本文件顶部同一类缺陷）
      if (findRelayRequest(mergedResult.toolCalls)) {
        await cardUpdater.finish(
          buildAlertCard({
            title: '协作转发未生效',
            template: 'yellow',
            detail:
              '检测到在方案提审重试轮中调用了 relay_to_peer，但该续流不支持转发。请在本话题中重新发起该转发请求。',
          }),
        );
        return;
      }

      const { request: productSpecRequest } = submission;
      if (mergedResult.sessionId) {
        await runtime.sessions.setCliSessionId(
          session.id,
          mergedResult.sessionId,
        );
      }
      if (mergedResult.stats?.contextWindowTokens) {
        runtime.contextWindows.set(
          session.id,
          mergedResult.stats.contextWindowTokens,
        );
      }
      if (productSpecRequest) {
        if (productSpecRequest.deliveryMode === 'local') {
          await assertProductSpecDocuments(
            session.workspaceDir,
            productSpecRequest,
          );
        }
        let objToken: string | undefined;
        if (
          productSpecRequest.deliveryMode === 'lark-doc' &&
          bot.resolveDocumentObjToken
        ) {
          objToken = await bot.resolveDocumentObjToken(
            productSpecRequest.documentUrl,
          );
        }
        const productSpecFlow = runtime.productSpecFlows.create({
          taskId: flow.taskId,
          botId: config.id,
          sessionId: session.id,
          ownerOpenId: flow.ownerOpenId,
          ownerUnionId: flow.ownerUnionId,
          collaboration: flow.collaboration,
          // 任务凭据必须优先取链路凭据：澄清回合可能由召回/续派触发，
          // 此时 flow.originalMessageId 是本轮投递消息而非任务发起消息，用作凭据会造成静默不匹配
          originalMessageId:
            flow.collaboration?.originMessageId ?? flow.originalMessageId,
          cardMessageId: progressCardMessageId,
          replyInThread: flow.replyInThread,
          request: productSpecRequest,
          objToken,
        });
        // 活跃方案流出现 → 恢复云文档评论订阅。
        // **必须在 create 之后**：先对账会算出「此刻没有活跃流」而退订，
        // 紧接着创建的这份 flow 就永远收不到云文档评论事件（空存储时必然发生）。
        await reconcileDocumentSubscription(runtime, config.id);
        // 澄清回填是方案提交的高频路径，必须与技术审查入口共用同一门禁，否则 Phase 3 会被绕过
        const handoff = await handOffToTechReview({
          runtime,
          config,
          bot,
          replyToMessageId: flow.originalMessageId,
          tierContext: flow.collaboration,
          specFlow: productSpecFlow,
          workspaceDir: session.workspaceDir,
          replyInThread: flow.replyInThread,
        });
        if (handoff) {
          await cardUpdater.finish(
            buildTaskCard({
              title: adapter.displayName,
              status: 'success',
              detail: `方案已提交 Phase 3 技术可行性对抗审查（第 ${handoff.round}/${handoff.maxRounds} 轮），等待 ${handoff.devName} 穿刺结论。`,
            }),
          );
          return;
        }
        await cardUpdater.finish(buildProductSpecApprovalCard(productSpecFlow));
        const specNotification = productSpecRequest.warning
          ? `${productSpecRequest.warning}。产品方案已生成，请查看上方确认卡。`
          : '产品方案已生成，请查看上方确认卡。';
        await sendResultNotification({
          bot,
          replyToMessageId: flow.originalMessageId,
          target: { openId: flow.ownerOpenId, name: '' },
          text: specNotification,
          replyInThread: flow.replyInThread,
        });
        return;
      }
    }

    await cardUpdater.finish(
      buildTaskCard({
        title: adapter.displayName,
        status: 'success',
        detail: '需求已经整理完成',
        progress: progress.snapshot(),
        answer: result.answer,
        stats: result.stats,
      }),
    );
    if (answerNeedsContinuation(result.answer)) {
      for (const chunk of splitLongText(answerContinuation(result.answer))) {
        await bot.reply(flow.originalMessageId, chunk, flow.replyInThread);
      }
    }
    await sendResultNotification({
      bot,
      replyToMessageId: flow.originalMessageId,
      target: { openId: flow.ownerOpenId, name: '' },
      text: '需求澄清已完成，请查看上方结果。',
      replyInThread: flow.replyInThread,
    });
  } catch (error) {
    clearInterval(heartbeat);
    const aborted = run.signal.aborted;
    await cardUpdater.finish(
      buildTaskCard({
        title: adapter.displayName,
        status: aborted ? 'cancelled' : 'failed',
        detail: aborted
          ? '需求整理已停止。你可以继续在当前话题里补充。'
          : '需求整理没有完成。请在当前话题里重试。',
        technicalDetail: aborted ? undefined : (error as Error).message,
        progress: progress.snapshot(),
      }),
    );
  } finally {
    clearInterval(heartbeat);
    if (runtime.activeRuns.get(session.id)?.controller === run) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}
