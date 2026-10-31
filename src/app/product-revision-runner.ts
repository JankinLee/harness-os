import type { Bot } from '../im/lark.js';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildAlertCard,
  buildProductSpecApprovalCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from '../im/card.js';
import type { BotConfig } from '../core/bot-registry.js';
import type { ProductSpecFlow } from '../core/product-spec.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import { getCliAdapter } from '../cli/registry.js';
import { executeCli } from './cli-execution.js';
import { sendResultNotification } from './notification-service.js';
import { handOffToTechReview } from './product-spec-routing.js';
import { markSessionIdle } from './session-view.js';
import type { AppRuntime } from './runtime.js';
import { assertProductSpecDocuments } from './product-spec-documents.js';
import { ensureProductSpecSubmission } from './product-spec-submission.js';
import { mergeToolCallLists } from './terminal-tool-submission.js';
import { TERMINAL_CONTROL_TOOLS } from '../cli/app-tools.js';
import { findRelayRequest } from '../core/collaboration.js';
import { reconcileDocumentSubscription } from './lifecycle-runner.js';

export function formatProductSpecRevisionPrompt(
  flow: ProductSpecFlow,
  revisionNotes: string,
): string {
  const documentInfo =
    flow.request.deliveryMode === 'lark-doc'
      ? `【飞书云文档】：${flow.request.documentUrl}`
      : [
          `【Spec 路径】：${flow.request.specPath}`,
          `【Tickets 路径】：${flow.request.ticketsPath}`,
          flow.request.issuesPath ? `【Issues 路径】：${flow.request.issuesPath}` : '',
        ]
          .filter(Boolean)
          .join('\n');

  return [
    '用户驳回了当前的产品方案，并提出了以下修改意见：',
    `【方案标题】：${flow.request.title}`,
    documentInfo,
    `【用户修改意见】：\n${revisionNotes}`,
    '请根据用户的修改意见重新审查并修改产品方案（修改现有文档或重新组织），完成后必须调用 request_spec_approval 重新提交新的产品方案供用户确认。',
  ].join('\n\n');
}

export async function continueProductRevisionFlow(options: {
  runtime: AppRuntime;
  bot: Bot;
  config: BotConfig;
  flow: ProductSpecFlow;
  run: AbortController;
  defaultDeliveryMode: 'local' | 'lark-doc';
  revisionNotes: string;
}): Promise<void> {
  const { bot, config, flow, run, runtime, defaultDeliveryMode, revisionNotes } =
    options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session) throw new Error('产品方案对应的会话已经失效');

  const adapter = getCliAdapter(session.cliId);
  const progress = new TaskProgressTracker(
    Date.now,
    runtime.contextWindows.get(session.id),
    false,
  );

  const replyTargetId = flow.originalMessageId || flow.cardMessageId;
  let progressCardMessageId: string | undefined;

  if (replyTargetId) {
    progressCardMessageId = await bot.replyCard(
      replyTargetId,
      buildTaskCard({
        title: adapter.displayName,
        status: 'running',
        detail: '正在根据修改意见重新调整产品方案',
        progress: progress.snapshot(),
        abortSessionId: session.id,
      }),
      flow.replyInThread,
    );
  }

  const cardUpdater = progressCardMessageId
    ? new ThrottledCardUpdater((card) =>
        bot.updateCard(progressCardMessageId!, card),
      )
    : undefined;

  const renderProgress = () => {
    if (!cardUpdater) return;
    const snapshot = progress.snapshot();
    cardUpdater.push(
      buildTaskCard({
        title: adapter.displayName,
        status: 'running',
        detail: snapshot.current || '正在修改产品方案',
        progress: snapshot,
        abortSessionId: session.id,
      }),
    );
  };
  const heartbeat = setInterval(renderProgress, 1_000);
  heartbeat.unref();

  try {
    const revisionPrompt = formatProductSpecRevisionPrompt(flow, revisionNotes);
    const result = await executeCli(
      adapter,
      revisionPrompt,
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
      // 角色身份必须下发，否则 MCP 侧 `checkToolRbac(undefined, …)` 直接放行
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

    const submission = await ensureProductSpecSubmission({
      result,
      defaultDeliveryMode,
      promptText: revisionPrompt,
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
          // 重试轮同样是独立 CLI 执行，角色身份不能只在首轮下发
          { HARNESS_OS_BOT_ID: config.id },
          {
            holderId: `session:${session.id.slice(0, 8)}`,
          },
        ),
    });

    // 与 index.ts / clarification-runner 的同名路径保持同一条不变式：
    // 修正轮的产物**并集**回首轮事实，而不是整份替换 —— 否则首轮里已成功的
    // relay 调用会随替换一起消失，下面这张「转发未生效」的告警卡将永远发不出来
    // （「同类缺陷只修一半」是本仓已记录在案的形态：三处调用点必须同时改）。
    const mergedToolCalls = mergeToolCallLists(
      result.toolCalls,
      submission.result.toolCalls,
    );

    // 同 clarification-runner：本续流不支持 relay_to_peer，必须显式告警而非静默丢弃
    if (findRelayRequest(mergedToolCalls)) {
      const alertCard = buildAlertCard({
        title: '协作转发未生效',
        template: 'yellow',
        detail:
          '检测到在本轮方案修订流程中调用了 relay_to_peer，但该续流不支持转发。请在本话题中重新发起该转发请求。',
      });
      if (cardUpdater) {
        await cardUpdater.finish(alertCard);
      } else if (replyTargetId) {
        await bot.replyCard(replyTargetId, alertCard, flow.replyInThread);
      }
      return;
    }

    const { request: productSpecRequest } = submission;
    if (!productSpecRequest) {
      throw new Error('产品方案修改未产出有效的提审请求');
    }
    if (submission.result.sessionId) {
      await runtime.sessions.setCliSessionId(
        session.id,
        submission.result.sessionId,
      );
    }
    if (submission.result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(
        session.id,
        submission.result.stats.contextWindowTokens,
      );
    }
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

    const nextFlow = runtime.productSpecFlows.create({
      taskId: flow.taskId,
      botId: config.id,
      sessionId: session.id,
      ownerOpenId: flow.ownerOpenId,
      ownerUnionId: flow.ownerUnionId,
      collaboration: flow.collaboration,
      // 凭据必须优先取**链路凭据**，与 clarification-runner 的同名路径保持一致：
      // 续流轮的 flow.originalMessageId 可能是本轮投递消息（甚至缺失），
      // 用作凭据会造成静默不匹配，并把「无凭据」这一状态继续传播给下游（含技术审查流）。
      originalMessageId:
        flow.collaboration?.originMessageId ?? flow.originalMessageId,
      cardMessageId: progressCardMessageId ?? flow.cardMessageId,
      replyInThread: flow.replyInThread,
      request: productSpecRequest,
      objToken,
    });
    // 活跃方案流出现 → 恢复云文档评论订阅。
    // **必须在 create 之后**：先对账会算出「此刻没有活跃流」而退订，
    // 紧接着创建的这份 flow 就永远收不到云文档评论事件（空存储时必然发生）。
    await reconcileDocumentSubscription(runtime, config.id);

    // 修订回填同样必须经过技术审查门禁，且复用同一审查流以保留 3 轮收敛上限
    const handoff = replyTargetId
      ? await handOffToTechReview({
          runtime,
          config,
          bot,
          replyToMessageId: replyTargetId,
          tierContext: flow.collaboration,
          specFlow: nextFlow,
          workspaceDir: session.workspaceDir,
          replyInThread: flow.replyInThread,
        })
      : undefined;
    if (handoff) {
      const handoffCard = buildTaskCard({
        title: adapter.displayName,
        status: 'success',
        detail: `修订方案已重新提交 Phase 3 技术可行性审查（第 ${handoff.round}/${handoff.maxRounds} 轮）。`,
      });
      // cardUpdater 在飞书未返回 message_id 时为 undefined，此处必须与下方人类终审卡分支同构地兜底
      if (cardUpdater) {
        await cardUpdater.finish(handoffCard);
      } else if (replyTargetId) {
        await bot.replyCard(replyTargetId, handoffCard, flow.replyInThread);
      }
      return;
    }

    if (cardUpdater) {
      await cardUpdater.finish(buildProductSpecApprovalCard(nextFlow));
    } else if (replyTargetId) {
      await bot.replyCard(
        replyTargetId,
        buildProductSpecApprovalCard(nextFlow),
        flow.replyInThread,
      );
    }

    const specNotification = productSpecRequest.warning
      ? `${productSpecRequest.warning}。修改后的产品方案已重新生成，请查看确认卡。`
      : '修改后的产品方案已重新生成，请查看确认卡。';

    if (replyTargetId) {
      await sendResultNotification({
        bot,
        replyToMessageId: replyTargetId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: specNotification,
        replyInThread: flow.replyInThread ?? false,
      });
    }
  } catch (error) {
    clearInterval(heartbeat);
    if (cardUpdater) {
      await cardUpdater.finish(
        buildTaskCard({
          title: adapter.displayName,
          status: 'failed',
          detail: '重修产品方案失败',
          technicalDetail: (error as Error).message,
        }),
      );
    }
    throw error;
  } finally {
    if (runtime.activeRuns.get(session.id)?.controller === run) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}
