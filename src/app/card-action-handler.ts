import type { Bot, CardAction, CardActionResponse } from '../im/lark.js';
import {
  buildApprovalContinuingCard,
  buildDeliveryReviewCard,
  buildProductSpecArchivedCard,
  buildApprovalDecidedCard,
  buildArbitrationResolvedCard,
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildProductSpecRevisionCard,
  buildResumeCard,
} from '../im/card.js';
import type { BotConfig, ProductDeliveryMode } from '../core/bot-registry.js';
import { isClarificationOwner } from '../core/clarification.js';
import { isArbitrationOwner } from '../core/collaboration.js';
import { isProductSpecOwner, type ProductSpecFlow } from '../core/product-spec.js';
import { resumeAfterArbitration } from './arbitration-runner.js';
import { archiveSpecFlow } from './lifecycle-runner.js';
import { selectStaleDelivered } from '../core/product-spec.js';
import type { ApprovalFlow } from '../core/approval.js';
import { requestTaskAbort } from '../core/task-abort.js';
import { getCliAdapter } from '../cli/registry.js';
import { listNativeCliSessions } from '../cli/native-sessions.js';
import { WorkspaceLockManager } from '../core/workspace-lock-manager.js';
import { GitWorktreeManager } from '../core/git-worktree-manager.js';
import { continueClarificationFlow } from './clarification-runner.js';
import { continueApprovalFlow } from './approval-runner.js';
import { continueProductRevisionFlow } from './product-revision-runner.js';
import type { CollaborationService } from './collaboration-service.js';
import type { AppRuntime } from './runtime.js';

export async function scheduleApprovalContinuation(options: {
  runtime: AppRuntime;
  config: BotConfig;
  flow: ApprovalFlow;
  bot: Bot;
}): Promise<void> {
  const { runtime, config, flow, bot } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || session.status === 'closed') {
    throw new Error('对应的 CLI 会话已经失效。');
  }
  if (session.status === 'active') {
    throw new Error('当前会话仍在执行，请稍后重试。');
  }
  await runtime.sessions.transition(session.id, 'active');
  const run = new AbortController();
  runtime.activeRuns.set(session.id, {
    controller: run,
    ownerOpenId: flow.ownerOpenId,
  });
  queueMicrotask(() => {
    void continueApprovalFlow({
      runtime,
      bot,
      config,
      flow,
      run,
    }).catch((error) => {
      console.error('[审批] 继续执行失败:', (error as Error).message);
    });
  });
}

export async function scheduleProductRevisionContinuation(options: {
  runtime: AppRuntime;
  config: BotConfig;
  flow: ProductSpecFlow;
  bot: Bot;
  revisionNotes: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
}): Promise<void> {
  const {
    runtime,
    config,
    flow,
    bot,
    revisionNotes,
    defaultProductDeliveryMode,
  } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || session.status === 'closed') {
    throw new Error('对应的产品会话已经失效。');
  }
  if (session.status === 'active') {
    throw new Error('当前会话仍在执行，请稍后重试。');
  }
  await runtime.sessions.transition(session.id, 'active');
  const run = new AbortController();
  runtime.activeRuns.set(session.id, {
    controller: run,
    ownerOpenId: flow.ownerOpenId,
  });
  queueMicrotask(() => {
    void continueProductRevisionFlow({
      runtime,
      bot,
      config,
      flow,
      run,
      defaultDeliveryMode: defaultProductDeliveryMode,
      revisionNotes,
    }).catch((error) => {
      console.error('[方案修改] 继续执行失败:', (error as Error).message);
    });
  });
}

export function createCardActionHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
  collaborationService: CollaborationService;
  defaultProductDeliveryMode: ProductDeliveryMode;
}): (action: CardAction) => Promise<CardActionResponse | undefined> {
  const { runtime, config, collaborationService, defaultProductDeliveryMode } =
    options;
  return async (action) => {
    if (action.value.action === 'approve_product_spec') {
      const flowToken =
        typeof action.value.flowToken === 'string'
          ? action.value.flowToken
          : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow || !action.messageId) {
        return { toast: { type: 'error', content: '这份产品方案已经失效。' } };
      }
      if (flow.status === 'expired') {
        return {
          toast: { type: 'warning', content: '这份产品方案已经失效。' },
          card: {
            type: 'raw',
            data: buildProductSpecExpiredCard(flow),
          },
        };
      }
      if (flow.status === 'approved') {
        return {
          toast: { type: 'info', content: '产品方案已经确认。' },
          card: {
            type: 'raw',
            data: buildProductSpecApprovedCard(flow),
          },
        };
      }
      if (!isProductSpecOwner(flow, action)) {
        return {
          toast: { type: 'warning', content: '只有任务发起人可以确认。' },
        };
      }
      const approved = runtime.productSpecFlows.approve(flowToken);
      if (!approved) {
        return { toast: { type: 'warning', content: '方案状态已经更新。' } };
      }
      // Phase 4 人类放行 = 生命周期从「待确认」跃迁到「研发实施中」。
      // 审批态与生命周期必须同时推进：只改审批态会让后续的停滞/归档巡检
      // 把一份已经开工的方案当成「尚未确认」而永远不纳入生命周期管理。
      // 跃迁失败必须**中止此处**：否则工单已经发给 developer，
      // 而交付回执的门禁（要求 lifecycle === 'in_development'）会永久拒绝它，形成静默断链。
      const approvedLifecycle = runtime.productSpecFlows.transitionLifecycle(
        flowToken,
        'approved',
      );
      if (!approvedLifecycle) {
        return {
          toast: {
            type: 'error',
            content:
              '方案生命周期状态异常，已阻止派发以免形成断链。请重新发起该方案。',
          },
        };
      }
      if (approved.collaboration) {
        const flowBotRuntime =
          runtime.botRuntimes.get(approved.botId) ??
          runtime.botRuntimes.get(config.id);
        if (!flowBotRuntime) {
          return { toast: { type: 'error', content: '当前 Bot 尚未就绪。' } };
        }
        const collaboration = approved.collaboration;
        const productDescription =
          approved.request.deliveryMode === 'lark-doc'
            ? `文档 URL：${approved.request.documentUrl}`
            : [
                `Spec：${approved.request.specPath}`,
                `Tickets：${approved.request.ticketsPath}`,
                approved.request.issuesPath
                  ? `Issues：${approved.request.issuesPath}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n');
        try {
          await collaborationService.dispatch({
            senderConfig: flowBotRuntime.config,
            senderBot: flowBotRuntime.bot,
            replyToMessageId: action.messageId,
            targetBotId: collaboration.reportToBotId,
            taskId: collaboration.taskId,
            ownerOpenId: approved.ownerOpenId,
            ownerUnionId: approved.ownerUnionId,
            reportToBotId: collaboration.reportToBotId,
            objective: `产品方案已确认：${approved.request.title}`,
            instruction: [
              `${config.role} 已经完成产品方案，用户确认通过。`,
              `方案标题：${approved.request.title}`,
              `方案摘要：${approved.request.summary}`,
              productDescription,
              `确认记录：${approved.approvedAt ?? ''}`,
              '请基于这份已确认方案继续组织后续工作：需要开发者实现时，使用 dispatch_task 把方案交给 developer。',
            ].join('\n\n'),
            expectedOutput:
              '继续推进原任务，或在已经完成时向用户给出最终结论。',
            // Phase 4 人类放行也是一次链路跳转：漏传 tier 会让下游方案提交被判定为非 M/L 级而跳过 Phase 3，
            // 漏传 escalations 则会让升级预算被静默清零，漏传凭据则会让后续方案提交被误判为另一个任务。
            tier: collaboration.tier,
            escalations: collaboration.escalations,
            originMessageId:
              collaboration.originMessageId ?? action.messageId,
            round: collaboration.round + 1,
            maxRounds: collaboration.maxRounds,
            // 辩证轮数沿链透传（放行不重置对抗进度），两组计数不可互相顶替
            negotiationRound: collaboration.negotiationRound,
            negotiationMaxRounds: collaboration.negotiationMaxRounds,
            workspaceDir:
              runtime.sessions.get(approved.sessionId)?.workspaceDir ??
              config.workspaceDir,
          });
        } catch (error) {
          return {
            toast: {
              type: 'error',
              content: `确认结果交回失败：${(error as Error).message}`,
            },
          };
        }
      }
      return {
        toast: { type: 'success', content: '产品方案已确认。' },
        card: {
          type: 'raw',
          data: buildProductSpecApprovedCard(approved),
        },
      };
    }

    if (
      action.value.action === 'reject_product_spec' ||
      action.value.action === 'request_spec_revision'
    ) {
      const flowToken =
        typeof action.value.flowToken === 'string'
          ? action.value.flowToken
          : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow || !action.messageId) {
        return { toast: { type: 'error', content: '这份产品方案已经失效。' } };
      }
      if (flow.status === 'expired') {
        return {
          toast: { type: 'warning', content: '这份产品方案已经失效。' },
          card: {
            type: 'raw',
            data: buildProductSpecExpiredCard(flow),
          },
        };
      }
      if (flow.status === 'approved') {
        return {
          toast: { type: 'info', content: '产品方案已经确认，无法退回修改。' },
          card: {
            type: 'raw',
            data: buildProductSpecApprovedCard(flow),
          },
        };
      }
      if (!isProductSpecOwner(flow, action)) {
        return {
          toast: {
            type: 'warning',
            content: '只有任务发起人可以提出修改意见。',
          },
        };
      }

      const revisionNotes =
        typeof action.formValue.revision_notes === 'string'
          ? action.formValue.revision_notes.trim()
          : typeof action.value.revision_notes === 'string'
            ? (action.value.revision_notes as string).trim()
            : '';

      if (!revisionNotes) {
        return {
          toast: {
            type: 'warning',
            content: '请填写修改意见后再退回。',
          },
        };
      }

      const session = runtime.sessions.get(flow.sessionId);
      if (!session || session.status === 'closed') {
        return {
          toast: { type: 'error', content: '对应的产品会话已经失效。' },
        };
      }
      if (session.status === 'active') {
        return {
          toast: {
            type: 'warning',
            content: '当前会话仍在执行，请稍后重试。',
          },
        };
      }

      const flowBotRuntime =
        runtime.botRuntimes.get(flow.botId) ??
        runtime.botRuntimes.get(config.id);
      if (!flowBotRuntime) {
        return { toast: { type: 'error', content: '当前 Bot 尚未就绪。' } };
      }

      const rejected = runtime.productSpecFlows.reject(flowToken, revisionNotes);
      if (!rejected) {
        return { toast: { type: 'warning', content: '方案状态已经更新。' } };
      }

      try {
        queueMicrotask(() => {
          void scheduleProductRevisionContinuation({
            runtime,
            config: flowBotRuntime.config,
            flow: rejected,
            bot: flowBotRuntime.bot,
            revisionNotes,
            defaultProductDeliveryMode,
          }).catch((error) => {
            console.error('[方案修改] 继续执行失败:', (error as Error).message);
          });
        });

        return {
          toast: {
            type: 'success',
            content: '修改意见已提交，产品经理正在重新调整方案。',
          },
          card: {
            type: 'raw',
            data: buildProductSpecRevisionCard(rejected, revisionNotes),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (
      action.value.action === 'accept_delivery' ||
      action.value.action === 'archive_spec' ||
      action.value.action === 'reject_delivery'
    ) {
      const flowToken =
        typeof action.value.flowToken === 'string'
          ? action.value.flowToken
          : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow) {
        return { toast: { type: 'error', content: '这份交付方案记录已失效。' } };
      }
      if (!isProductSpecOwner(flow, action)) {
        return {
          toast: {
            type: 'warning',
            content: '只有任务发起人可以操作。',
          },
        };
      }
      const bot = runtime.botRuntimes.get(config.id)?.bot;
      if (!bot) {
        return { toast: { type: 'error', content: '当前 bot 尚未就绪，请稍后重试。' } };
      }

      // 通道①：人工点击归档。与 /archive 命令、14 天自动归档共用同一实现，
      // 确保「释放监听」在任何通道下都必然发生（此前只有 delete，没有退订也没有生命周期）。
      if (action.value.action === 'archive_spec') {
        const ok = await archiveSpecFlow({
          runtime,
          bot,
          flow,
          channel: 'manual',
          // 卡片按钮触发 → **原地更新**原卡片；再新发一张会让同一件事出现两张卡
          deliverCard: false,
        });
        return ok
          ? {
              toast: { type: 'success', content: '方案已归档并释放监听。' },
              card: {
                type: 'raw',
                data: buildProductSpecArchivedCard(flow, '人工点击归档'),
              },
            }
          : {
              toast: {
                type: 'warning',
                content: `当前阶段（${flow.lifecycle ?? 'pending'}）无法归档。`,
              },
            };
      }

      if (action.value.action === 'accept_delivery') {
        // 幂等守卫：飞书不会作废已下发的旧卡片，重复点击会让 acceptedAt 与
        // lifecycleUpdatedAt 双双前移 —— 观察天数归零、自动归档顺延。
        if (flow.acceptedAt) {
          return {
            toast: { type: 'info', content: '这份交付已经验收过了。' },
            card: {
              type: 'raw',
              data: buildDeliveryReviewCard({
                flow,
                stage: 'accepted',
                devSummary: flow.devReport?.summary,
                testPassed: flow.devReport?.testPassed,
              }),
            },
          };
        }
        const accepted = runtime.productSpecFlows.transitionLifecycle(
          flowToken,
          'accepted',
        );
        if (!accepted) {
          return {
            toast: {
              type: 'warning',
              content: '这份方案当前不在「待验收」阶段，无法确认验收。',
            },
          };
        }
        return {
          toast: { type: 'success', content: '业务验收通过，已进入观察期。' },
          // 原地演进为「已验收·观察中」：只留二级【立即归档封存】，
          // 继续显示验收按钮会与「已验收」的文案自相矛盾。
          card: {
            type: 'raw',
            data: buildDeliveryReviewCard({
              flow: accepted,
              stage: 'accepted',
              devSummary: accepted.devReport?.summary,
              testPassed: accepted.devReport?.testPassed,
            }),
          },
        };
      }

      // 打回归正：验收未通过必须真的退回研发，而不是只弹一个 toast。
      const rejectReason =
        typeof action.formValue.reject_reason === 'string'
          ? action.formValue.reject_reason.trim()
          : '';
      if (!rejectReason) {
        return { toast: { type: 'warning', content: '请先填写打回原因。' } };
      }
      const rejected = runtime.productSpecFlows.transitionLifecycle(
        flowToken,
        'rejected',
      );
      if (!rejected) {
        return {
          toast: {
            type: 'warning',
            content: '这份方案当前不在「待验收」阶段，无法打回。',
          },
        };
      }

      const collaboration = flow.collaboration;
      if (collaboration) {
        try {
          const devRuntime = runtime.botRuntimes.get('developer');
          if (devRuntime) {
            await collaborationService.dispatch({
              senderConfig: config,
              senderBot: bot,
              replyToMessageId: action.messageId,
              targetBotId: 'developer',
              taskId: flow.taskId,
              ownerOpenId: flow.ownerOpenId,
              ownerUnionId: flow.ownerUnionId,
              reportToBotId: collaboration.reportToBotId,
              objective: `【交付验收打回归正】${flow.request.title ?? '产品方案'}`,
              instruction: [
                '人类验收未通过，本次交付被打回，请按以下原因返工：',
                rejectReason,
                '返工完成后请重新回传交付物并附验收简报。',
              ].join('\n\n'),
              expectedOutput: '返工后的交付物与更新后的验收简报。',
              tier: collaboration.tier,
              escalations: collaboration.escalations,
              originMessageId:
                collaboration.originMessageId ?? flow.originalMessageId,
              round: collaboration.round + 1,
              maxRounds: collaboration.maxRounds,
              negotiationRound: collaboration.negotiationRound,
              negotiationMaxRounds: collaboration.negotiationMaxRounds,
              workspaceDir:
                runtime.sessions.get(flow.sessionId)?.workspaceDir ??
                config.workspaceDir,
            });
          }
        } catch (error) {
          // 打回状态已落库，但返工指令没送到 —— 必须显式回告，不能让人类以为已返工
          const message = (error as Error).message;
          console.error('[交付打回] 派发失败:', message);
          await bot
            .reply(
              action.messageId,
              `打回状态已记录，但返工指令派发失败：${message}。请稍后在话题中重新指派。`,
              flow.replyInThread ?? false,
            )
            .catch(() => undefined);
          return {
            toast: { type: 'error', content: `打回已记录，但派发失败：${message}` },
          };
        }
      }

      return {
        toast: {
          type: 'success',
          // 无协作链意味着**没有任何人被派发返工**：报「已退回研发」会让人以为
          // developer 已经在干活，而方案其实只会静静停在 in_development。
          content: collaboration
            ? '已打回归正，方案退回研发阶段。'
            : '已打回归正，但本任务不在协作链中，没有可派发的 developer —— 请直接在话题里重新指派。',
        },
        // 打回同样原地更新：新发一张卡在语义上暗示「这是一件新事」，
        // 而打回只是同一件事的下一状态。
        card: {
          type: 'raw',
          data: buildDeliveryReviewCard({
            flow: rejected,
            stage: 'rejected',
            rejectReason,
            devSummary: rejected.devReport?.summary,
          }),
        },
      };
    }

    // 通道③：管理大盘批量归档超期方案。
    // 判定必须与大盘展示共用 selectStaleDelivered —— 否则会出现
    // 「大盘上看到 3 份、点下去只归档了 2 份」的错位，且无人能解释差在哪。
    if (action.value.action === 'archive_stale_specs') {
      const bot = runtime.botRuntimes.get(config.id)?.bot;
      if (!bot) {
        return { toast: { type: 'error', content: '当前 bot 尚未就绪。' } };
      }
      const stale = selectStaleDelivered(
        runtime.productSpecFlows.listAll(),
        Date.now(),
      );
      if (stale.length === 0) {
        return { toast: { type: 'info', content: '当前没有超期未验收的方案。' } };
      }
      let archivedCount = 0;
      for (const flow of stale) {
        const ok = await archiveSpecFlow({
          runtime,
          bot,
          flow,
          channel: 'dashboard',
        });
        if (ok) archivedCount += 1;
      }
      return {
        toast: {
          type: 'success',
          content: `已批量归档 ${archivedCount} 份超期方案并释放监听。`,
        },
      };
    }

    if (action.value.action === 'answer_clarification') {
      const flowToken =
        typeof action.value.flowToken === 'string'
          ? action.value.flowToken
          : '';
      const questionId =
        typeof action.value.questionId === 'string'
          ? action.value.questionId
          : '';
      const flow = runtime.clarificationFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这组澄清问题已经失效。' } };
      }
      if (!isClarificationOwner(flow, action)) {
        return {
          toast: { type: 'warning', content: '只有任务发起人可以回答。' },
        };
      }

      const question = flow.request.questions[flow.currentIndex];
      if (!question || question.id !== questionId) {
        return {
          toast: {
            type: 'warning',
            content: '问题已经更新，请按当前卡片作答。',
          },
        };
      }

      const decisionMode =
        action.value.decisionMode === 'current' ||
        action.value.decisionMode === 'remaining'
          ? action.value.decisionMode
          : undefined;
      let answered;
      if (decisionMode) {
        answered = runtime.clarificationFlows.answerWithRecommendation(
          flowToken,
          decisionMode === 'remaining',
        );
      } else {
        const custom = action.value.custom === true;
        const optionId =
          typeof action.value.optionId === 'string'
            ? action.value.optionId
            : '';
        const selectedOption = question.options.find(
          (option) => option.id === optionId,
        );
        const customAnswer =
          typeof action.formValue.custom_answer === 'string'
            ? action.formValue.custom_answer.trim()
            : '';
        const answer = custom ? customAnswer : (selectedOption?.label ?? '');
        if (!answer) {
          return {
            toast: {
              type: 'warning',
              content: custom ? '请先输入你的答案。' : '这个选项已经失效。',
            },
          };
        }
        answered = runtime.clarificationFlows.answer(
          flowToken,
          questionId,
          answer,
        );
      }
      if (!answered) {
        return {
          toast: { type: 'warning', content: '答案没有保存，请重试。' },
        };
      }
      if (!answered.complete) {
        return {
          toast: { type: 'success', content: '已记录，继续下一题。' },
          card: {
            type: 'raw',
            data: buildClarificationCard({ flow: answered.flow }),
          },
        };
      }

      const session = runtime.sessions.get(answered.flow.sessionId);
      const botRuntime = runtime.botRuntimes.get(config.id);
      if (!session || !botRuntime || session.status === 'closed') {
        return {
          toast: { type: 'error', content: '对应的 CLI 会话已经失效。' },
        };
      }
      if (session.status === 'active') {
        return {
          toast: { type: 'warning', content: '当前会话仍在执行，请稍后重试。' },
        };
      }

      try {
        await runtime.sessions.transition(session.id, 'active');
        const run = new AbortController();
        runtime.activeRuns.set(session.id, {
          controller: run,
          ownerOpenId: answered.flow.ownerOpenId,
        });
        runtime.clarificationFlows.delete(flowToken);
        queueMicrotask(() => {
          void continueClarificationFlow({
            runtime,
            bot: botRuntime.bot,
            config,
            flow: answered.flow,
            run,
            defaultDeliveryMode: defaultProductDeliveryMode,
          }).catch((error) => {
            console.error('[澄清] 继续执行失败:', (error as Error).message);
          });
        });
        return {
          toast: { type: 'success', content: '答案已收到。' },
          card: {
            type: 'raw',
            data: buildClarificationContinuingCard(answered.flow),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'decide_approval') {
      const flowToken =
        typeof action.value.flowToken === 'string'
          ? action.value.flowToken
          : '';
      const decisionMode = action.value.decision;
      const isReject = decisionMode === 'reject';
      const isScope = decisionMode === 'approve_scope';
      const decision = isReject ? 'reject' : 'approved';
      const flow = runtime.approvalFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份审批请求已经失效。' } };
      }
      if (flow.status !== 'pending') {
        return {
          toast: { type: 'info', content: '这份审批已经处理过。' },
          card: {
            type: 'raw',
            data: buildApprovalDecidedCard(flow),
          },
        };
      }
      if (new Date(flow.expiresAt).getTime() < Date.now()) {
        const expired = runtime.approvalFlows.expire(flowToken);
        const botRuntime = runtime.botRuntimes.get(config.id);
        if (expired && botRuntime) {
          try {
            await scheduleApprovalContinuation({
              runtime,
              config,
              flow: expired,
              bot: botRuntime.bot,
            });
          } catch (error) {
            console.error('[审批] 超时收束失败:', (error as Error).message);
          }
        }
        return {
          toast: { type: 'warning', content: '审批已超时，按拒绝处理。' },
          card: {
            type: 'raw',
            data: buildApprovalDecidedCard(expired ?? flow),
          },
        };
      }
      if (!action.operatorOpenId) {
        return {
          toast: { type: 'warning', content: '无法识别操作者，无法审批。' },
        };
      }
      const resolved = runtime.approvalFlows.resolve(
        flowToken,
        isReject ? 'rejected' : 'approved',
      );
      if (!resolved) {
        return { toast: { type: 'warning', content: '审批状态已经更新。' } };
      }

      const botRuntime = runtime.botRuntimes.get(config.id);
      if (!botRuntime) {
        return { toast: { type: 'error', content: '当前 Bot 尚未就绪。' } };
      }
      try {
        await scheduleApprovalContinuation({
          runtime,
          config,
          flow: resolved,
          bot: botRuntime.bot,
        });
        return {
          toast: {
            type: 'success',
            content: isReject ? '已拒绝。' : '已放行。',
          },
          card: {
            type: 'raw',
            data: buildApprovalContinuingCard(resolved),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'decide_arbitration') {
      const flowToken =
        typeof action.value.flowToken === 'string'
          ? action.value.flowToken
          : '';
      const flow = runtime.arbitrationFlows?.get(flowToken);
      // 只接受「等待人类裁决」与「停滞休眠」两态：待初裁（pending_preliminary）
      // 阶段的卡片不应存在，若出现说明状态机被绕过。
      if (
        !flow ||
        (flow.status !== 'pending_human' && flow.status !== 'suspended') ||
        !action.messageId
      ) {
        return { toast: { type: 'error', content: '这份仲裁请求已失效或已处理。' } };
      }
      // 发起人鉴权：与 approve_product_spec / answer_clarification 等处理器对齐。
      // 争议裁决会改变任务方向甚至终止任务，任何旁观者点击都能生效是不可接受的。
      if (!isArbitrationOwner(flow, action)) {
        return {
          toast: {
            type: 'warning',
            content: '只有任务发起人可以裁决这次争议。',
          },
        };
      }

      const customGuidance =
        typeof action.formValue.custom_guidance === 'string'
          ? action.formValue.custom_guidance.trim()
          : '';
      const decision = action.value.custom ? 'custom' : (action.value.decision as string);

      const resolved = runtime.arbitrationFlows?.resolve(flowToken, {
        selectedOption: decision,
        customGuidance: customGuidance || undefined,
      });

      if (!resolved) {
        return { toast: { type: 'warning', content: '仲裁状态已更新。' } };
      }

      if (decision === 'terminate') {
        // 终止即链路终结 → 级联清理关联流程，否则同话题的下个任务会命中陈旧
        // 审查流/方案流并继承其轮次预算与争议上下文。
        // 仲裁流同样必须回收：同话题的另一个任务可能存在**凭证不同因而并存**的仲裁流，
        // 漏掉它会让一条被人类明确杀死的链在 24h 后按超时策略自动复活。
        // 人类明确终止 → 连「已推到人类面前」的待办一起回收（includeHumanPending）
        runtime.techReviewFlows?.deleteByTaskId(resolved.taskId);
        runtime.arbitrationFlows?.deleteByTaskId(resolved.taskId, {
          includeHumanPending: true,
        });
        runtime.productSpecFlows.deleteByTaskId(resolved.taskId, {
          includeHumanPending: true,
        });
        console.log(
          `[仲裁流转] flow=${resolved.token} 人类终止任务，已级联清理关联流程 task=${resolved.taskId}`,
        );
        return {
          toast: { type: 'success', content: '任务已终止，关联流程已清理。' },
          card: {
            type: 'raw',
            data: buildArbitrationResolvedCard(resolved),
          },
        };
      }

      // 人类裁决与超时自动采纳共用同一实现，避免两条路径在
      // 分级/升级预算/任务凭据/双计数的继承上逐渐漂移成两套语义。
      const leaderRuntime = runtime.botRuntimes.get('ceo-assistant');
      if (!leaderRuntime) {
        // 缺 bot 时绝不返回 success：那会让人类以为任务已在推进，
        // 而实际上没有任何 Agent 收到裁决指令（本文件其余分支对缺 bot 一律返回 error）。
        return {
          toast: {
            type: 'error',
            content: 'ceo-assistant 尚未就绪，裁决未被派发。请稍后重试。',
          },
        };
      }
      {
        try {
          await resumeAfterArbitration({
            runtime,
            bot: leaderRuntime.bot,
            flow: resolved,
            decision,
            customGuidance: customGuidance || undefined,
          });
        } catch (dispatchErr) {
          // 裁决已落库但派发失败 → **必须回告人类**。
          // 此前这里只 console.error 却仍返回「裁决已生效」，
          // 人类会以为任务在推进，实际上没有任何 Agent 收到指令。
          const message = (dispatchErr as Error).message;
          console.error('[仲裁流转] 派发失败:', message);
          const replyBot = runtime.botRuntimes.get(config.id)?.bot;
          await replyBot
            ?.reply(
              action.messageId,
              `仲裁裁决已记录，但重新派发失败：${message}。任务当前**没有**在推进，请稍后重试或在话题中重新发起。`,
              resolved.replyInThread ?? false,
            )
            .catch(() => undefined);
          return {
            toast: {
              type: 'error',
              content: `裁决已记录，但派发失败：${message}`,
            },
            card: {
              type: 'raw',
              data: buildArbitrationResolvedCard(resolved),
            },
          };
        }
      }

      return {
        toast: { type: 'success', content: '人工仲裁裁决已生效。' },
        card: {
          type: 'raw',
          data: buildArbitrationResolvedCard(resolved),
        },
      };
    }

    if (action.value.action === 'resume_cli_session') {
      const agentSessionId =
        typeof action.value.agentSessionId === 'string'
          ? action.value.agentSessionId
          : '';
      const cliSessionId =
        typeof action.value.cliSessionId === 'string'
          ? action.value.cliSessionId
          : '';
      const session = runtime.sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId) {
        return { toast: { type: 'error', content: '这条会话记录已经失效。' } };
      }
      if (session.status === 'active') {
        return {
          toast: { type: 'warning', content: '当前任务结束后才能切换会话。' },
        };
      }
      if (session.status === 'closed') {
        return {
          toast: { type: 'warning', content: '当前话题的会话已经关闭。' },
        };
      }
      try {
        const cliAdapter = getCliAdapter(session.cliId);
        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
        });
        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: {
              type: 'error',
              content: '这个 CLI 会话已经不在当前工作目录中。',
            },
          };
        }
        const updated = await runtime.sessions.setCliSessionId(
          session.id,
          cliSessionId,
        );
        return {
          toast: { type: 'success', content: '已切换到选中的历史会话。' },
          card: {
            type: 'raw',
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: updated.cliSessionId,
              sessions: nativeSessions,
            }),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'extend_queue_wait') {
      const workspacePath =
        typeof action.value.workspacePath === 'string'
          ? action.value.workspacePath
          : config.workspaceDir;
      const sessionId =
        typeof action.value.sessionId === 'string'
          ? action.value.sessionId
          : '';
      const holderId =
        typeof action.value.holderId === 'string'
          ? action.value.holderId
          : sessionId
            ? `session:${sessionId.slice(0, 8)}`
            : '';

      if (!holderId) {
        return { toast: { type: 'error', content: '无法识别排队会话标识。' } };
      }

      const lockManager = WorkspaceLockManager.getInstance();
      const extended = lockManager.extendWaitTimeout(workspacePath, holderId, 300_000);
      if (extended) {
        return {
          toast: {
            type: 'success',
            content: '已成功延长排队等待保护时间 5 分钟 (+300s)。',
          },
        };
      }
      return {
        toast: {
          type: 'info',
          content: '当前任务已经开始执行或已离开队列，无需延长。',
        },
      };
    }

    if (action.value.action === 'switch_to_readonly') {
      const workspacePath =
        typeof action.value.workspacePath === 'string'
          ? action.value.workspacePath
          : config.workspaceDir;
      const sessionId =
        typeof action.value.sessionId === 'string'
          ? action.value.sessionId
          : '';
      const holderId =
        typeof action.value.holderId === 'string'
          ? action.value.holderId
          : sessionId
            ? `session:${sessionId.slice(0, 8)}`
            : '';

      if (!holderId) {
        return { toast: { type: 'error', content: '无法识别排队会话标识。' } };
      }

      const lockManager = WorkspaceLockManager.getInstance();
      const switched = lockManager.switchWaiterToRead(workspacePath, holderId);
      if (switched) {
        return {
          toast: {
            type: 'info',
            content: '已切换为共享读锁：当前前序任务正独占写入中，待其释放后将优先以只读方式并发执行。',
          },
        };
      }
      return {
        toast: {
          type: 'info',
          content: '当前任务已在执行或不在队列中。',
        },
      };
    }

    if (action.value.action === 'spawn_worktree') {
      const sessionId =
        typeof action.value.sessionId === 'string'
          ? action.value.sessionId
          : '';
      const workspacePath =
        typeof action.value.workspacePath === 'string'
          ? action.value.workspacePath
          : config.workspaceDir;

      const session = runtime.sessions.get(sessionId);
      if (!session) {
        return { toast: { type: 'error', content: '对应会话不存在或已失效。' } };
      }

      const worktreeManager = GitWorktreeManager.getInstance();
      const isGit = await worktreeManager.isGitRepo(workspacePath);
      if (!isGit) {
        return {
          toast: {
            type: 'warning',
            content: '当前工作区不是 Git 仓库，无法派生 Worktree。',
          },
        };
      }

      try {
        const worktree = await worktreeManager.createWorktree(workspacePath, sessionId);
        // 动态绑定会话的工作区目录至派生 worktree
        await runtime.sessions.setWorkspaceDir(sessionId, worktree.worktreePath);
        return {
          toast: {
            type: 'success',
            content: `已成功在独立 Worktree [${worktree.branchName}] 派生分支推进。`,
          },
        };
      } catch (err) {
        return {
          toast: {
            type: 'error',
            content: `派生 Worktree 失败: ${(err as Error).message}`,
          },
        };
      }
    }

    if (action.value.action === 'keep_worktree_pr') {
      const branchName =
        typeof action.value.branchName === 'string' ? action.value.branchName : '';
      return {
        toast: {
          type: 'info',
          content: `分支 [${branchName}] 已保留在工作树中，可作为独立 PR 提交审查。`,
        },
      };
    }

    if (action.value.action === 'rollback_worktree') {
      const branchName =
        typeof action.value.branchName === 'string' ? action.value.branchName : '';
      return {
        toast: {
          type: 'warning',
          content: `已确认放弃分支 [${branchName}] 的冲突变更并安全回滚。`,
        },
      };
    }

    if (action.value.action !== 'abort_task') return undefined;
    const sessionId =
      typeof action.value.sessionId === 'string' ? action.value.sessionId : '';
    const adminOpenIds = new Set<string>();
    if (process.env.OWNER_OPEN_ID) adminOpenIds.add(process.env.OWNER_OPEN_ID);
    if (process.env.ADMIN_OPEN_IDS) {
      for (const id of process.env.ADMIN_OPEN_IDS.split(',').map((s) => s.trim()).filter(Boolean)) {
        adminOpenIds.add(id);
      }
    }
    const outcome = requestTaskAbort(
      runtime.activeRuns,
      sessionId,
      action.operatorOpenId,
      adminOpenIds,
    );
    if (outcome === 'not_found') {
      return {
        toast: { type: 'info', content: '任务已经结束，无需再次停止。' },
      };
    }
    if (outcome === 'forbidden') {
      return {
        toast: {
          type: 'warning',
          content: '只有该任务的发起人可以停止它；若你确需中止，请让发起人操作。',
        },
      };
    }
    if (outcome === 'already_stopping') {
      return { toast: { type: 'info', content: '正在停止任务，请稍候。' } };
    }
    return { toast: { type: 'success', content: '已发送停止指令。' } };
  };
}
