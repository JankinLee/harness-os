import { executeCli } from './cli-execution.js';
import { getCliAdapter } from '../cli/registry.js';
import { buildBotPrompt, type BotConfig } from '../core/bot-registry.js';
import type { AppRuntime } from './runtime.js';
import type { ScheduledTask } from '../core/schedule.js';
import { markSessionIdle } from './session-view.js';
import { checkLarkAuthStatus, sendAuthPatrolAlert } from '../core/lark-auth-probe.js';

/**
 * 组装调度任务的完整 prompt。
 *
 * 必须被导出并被测试**直接消费**：此前测试是在测试文件里**手抄**这段文本的，
 * 于是 prompt 一改，测试仍然全绿，而它声称守护的「前 2000+ tokens 静态前缀不变」
 * 早已在生产里失真 —— 断言与实现各说各话。
 *
 * KV Cache 保护契约：彻底剥离前置动态时间戳，动态运行元信息一律压到末尾附录。
 */
export function buildScheduledTaskPrompt(options: {
  target: BotConfig;
  task: ScheduledTask;
  scheduledFor: string;
  teamContext: string;
  defaultProductDeliveryMode: 'local' | 'lark-doc';
}): string {
  return buildBotPrompt(
    options.target,
    [
      options.task.prompt,
      '直接执行任务要求。执行结束后，宿主会自动把本轮结论作为交付回执卡片推送到本任务绑定的会话，你**无需**再自行推送回执；' +
        '但若任务本身要求把具体产物交付给指定的人或群，请自行完成。',
      '\n---\n[定时任务运行元信息]\n' +
        `计划触发时间：${options.scheduledFor}\n` +
        '运行模式：无人值守定时调度（现场无人类会话；不要在后台向空气提问，遇阻请基于已有上下文自主收敛并如实交付结论）。',
    ].join('\n\n'),
    options.teamContext,
    options.defaultProductDeliveryMode,
  );
}

export interface ScheduledTaskOutcome {
  sessionId?: string;
  /** 模型本轮的最终结论文本 —— 交付回执的正文来源 */
  answer?: string;
  durationMs: number;
}

export async function runScheduledTaskDirectly(options: {
  runtime: AppRuntime;
  task: ScheduledTask;
  scheduledFor: string;
  defaultProductDeliveryMode: 'local' | 'lark-doc';
}): Promise<ScheduledTaskOutcome> {
  const { runtime, task, scheduledFor } = options;
  const target = runtime.teamRegistry.get(task.targetBotId);
  if (!target) {
    throw new Error(`定时任务目标成员未注册或未启用: ${task.targetBotId}`);
  }

  // 工作区隔离支持：若任务指定了 workspace 则使用它，否则使用 target.workspaceDir
  let workspaceDir = target.workspaceDir;
  if (task.workspace) {
    workspaceDir = await runtime.workspaceResolver.resolveAndEnsure(
      task.workspace,
      target.workspaceDir,
    );
  }

  const messageAddress = {
    messageId: `scheduled-${task.id}`,
    chatId: task.chatId,
    threadId: `scheduled-${task.id}`,
    rootId: '',
  };
  const resolved = await runtime.sessions.resolve(
    messageAddress,
    target.defaultCliId,
    target.id,
    workspaceDir,
    runtime.workspaceResolver.getAlias(workspaceDir),
  );
  let { session } = resolved;
  if (resolved.isNew && session.status === 'creating') {
    session = await runtime.sessions.transition(session.id, 'idle');
  }
  if (session.status === 'active') {
    throw new Error('目标 bot 当前会话仍在执行');
  }
  await runtime.sessions.transition(session.id, 'active');

  const prompt = buildScheduledTaskPrompt({
    target,
    task,
    scheduledFor,
    teamContext: runtime.teamRegistry.contextFor(target.id),
    defaultProductDeliveryMode: options.defaultProductDeliveryMode,
  });
  const adapter = getCliAdapter(session.cliId);
  const run = new AbortController();
  const startedAt = Date.now();
  try {
    const result = await executeCli(
      adapter,
      prompt,
      workspaceDir,
      session.cliSessionId,
      run.signal,
      [],
      (event) => {
        if (event.type === 'tool_start') {
          console.log(
            `[定时] ${task.id} 开始 ${event.label}${'detail' in event && event.detail ? ` ${event.detail}` : ''}`,
          );
        }
      },
      {
        HARNESS_OS_CHAT_ID: task.chatId,
        // 角色身份必须随调度一起下发：此前漏传 HARNESS_OS_BOT_ID，
        // 导致 MCP 侧 `checkToolRbac(undefined, …)` 命中 `!botId → allowed`，
        // 无人值守的调度进程反而成了**唯一不受角色门禁约束**的执行路径。
        HARNESS_OS_BOT_ID: target.id,
        HARNESS_OS_OWNER_OPEN_ID: task.creatorOpenId,
      },
      {
        holderId: `session:${session.id.slice(0, 8)}`,
      },
    );
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    console.log(`[定时] ${task.id} 直接执行完成`);

    // 授权巡检探针（Patrol Probe）：在定时调度执行后异步主动巡检飞书凭证生命周期
    queueMicrotask(() => {
      void (async () => {
        try {
          const authStatus = await checkLarkAuthStatus();
          if (authStatus.needsAlert) {
            console.warn(`[定时巡检] 检测到飞书凭证风险: ${authStatus.reason}`);
            await sendAuthPatrolAlert(authStatus);
          }
        } catch (err) {
          console.error('[定时巡检] 凭证巡检异常:', (err as Error).message);
        }
      })();
    });

    return {
      sessionId: result.sessionId,
      answer: result.answer,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await markSessionIdle(runtime.sessions, session.id);
  }
}
