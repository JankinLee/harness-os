import { buildScheduleRunCard } from '../im/card.js';
import type { ScheduledRun } from '../core/schedule-run-store.js';
import type { ScheduledTask } from '../core/schedule.js';
import type { AppRuntime } from './runtime.js';

/** `chatId: 'system'` 是内置守护任务的占位地址，不是任何可投递的会话。 */
const SYSTEM_CHAT_ID = 'system';

/**
 * 调度任务强制交付回执（Mandatory Delivery Receipt）
 *
 * 存在理由：定时任务在**凭空合成**的会话地址里跑，没有任何入站消息可回复，
 * 于是它执行完只会留下一行 `console.log`。09-17 的生产复盘里，
 * 一条链在后台静默跑完、上游却只收到"已完成"——人无从知晓它到底做了什么。
 * 宿主必须**自己**把结论推给绑定的会话，而不是指望模型在 prompt 里被叮嘱一句
 * "如果任务要求推送，请自行推送"。
 *
 * 三条硬约束：
 * 1. **成功与失败两条分支都必须送达** —— 只写成功分支等于没写（失败恰恰最需要被看见）；
 * 2. **本函数绝不抛错** —— 通知失败不得污染运行记录，更不得把成功的执行改判为失败；
 * 3. **不猜** —— 没有答案正文就如实写"本轮无正文结论产出"，不编造摘要。
 */
export async function deliverScheduleReceipt(options: {
  runtime: AppRuntime;
  task: ScheduledTask;
  run: ScheduledRun;
  answer?: string;
  durationMs?: number;
}): Promise<void> {
  const { runtime, task, run } = options;

  if (!task.chatId || task.chatId === SYSTEM_CHAT_ID) return;

  const botRuntime = runtime.botRuntimes.get(task.targetBotId);
  if (!botRuntime) {
    console.warn(
      `[定时回执] 目标成员未在运行中，无法投递回执: ${task.targetBotId} (task=${task.id})`,
    );
    return;
  }

  try {
    await botRuntime.bot.sendCardToChat(
      task.chatId,
      buildScheduleRunCard(run, {
        taskPrompt: task.prompt,
        targetBotId: task.targetBotId,
        targetRole: botRuntime.config.role,
        durationMs: options.durationMs,
        answer: options.answer,
      }),
    );
    console.log(
      `[定时回执] 已投递 task=${task.id} run=${run.id} status=${run.status} -> ${task.chatId}`,
    );
  } catch (error) {
    // 降级但不静默：回执投递失败本身是需要被人知道的运维事实。
    console.error(
      `[定时回执] 投递失败 task=${task.id} run=${run.id}: ${(error as Error).message}`,
    );
  }
}
