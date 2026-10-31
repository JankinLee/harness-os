import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { ScheduleRunStore } from '../core/schedule-run-store.js';
import type { ScheduleStore } from '../core/schedule-store.js';
import type { CreateScheduledTask, ScheduledTask } from '../core/schedule.js';
import type { AppRuntime } from './runtime.js';
import { dispatchScheduledTask } from './schedule-task-dispatcher.js';
import { deliverScheduleReceipt } from './schedule-delivery.js';
import { sweepArbitrations } from './arbitration-runner.js';
import { sweepLifecycles } from './lifecycle-runner.js';
import { recordFriction } from './friction-recorder.js';

const ONCE_GRACE_MS = 5 * 60 * 1000;

export class Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(
    private readonly options: {
      runtime: AppRuntime;
      scheduleStore: ScheduleStore;
      runStore: ScheduleRunStore;
      defaultProductDeliveryMode: 'local' | 'lark-doc';
      now?: () => Date;
    },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.recoverInterruptedRuns();
    for (const task of this.options.scheduleStore.list()) {
      if (task.status !== 'active') continue;
      if (task.rule.kind === 'once') {
        const runAt = new Date(task.rule.runAt).getTime();
        if (runAt <= (this.options.now?.() ?? new Date()).getTime()) {
          const skipped = this.options.runStore.create(
            task.id,
            task.rule.runAt,
          );
          if (skipped) {
            this.options.runStore.markSkipped(
              skipped.id,
              '重启时已经错过一次性任务',
            );
          }
          this.options.scheduleStore.update(task.id, { status: 'completed' });
          continue;
        }
      }
      this.schedule(task);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  list(): ScheduledTask[] {
    return this.options.scheduleStore.list();
  }

  get(id: string): ScheduledTask | undefined {
    return this.options.scheduleStore.get(id);
  }

  create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    const task = this.options.scheduleStore.create(options);
    if (task.status === 'active') this.schedule(task);
    return task;
  }

  ensureBuiltinTask(options: CreateScheduledTask & { id: string }): ScheduledTask {
    const existing = this.options.scheduleStore.get(options.id);
    if (existing) {
      if (existing.status === 'active' && !this.timers.has(options.id)) {
        this.schedule(existing);
      }
      return existing;
    }
    return this.create(options);
  }

  pause(id: string): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task || task.status !== 'active') return task;
    this.clearTimer(id);
    return this.options.scheduleStore.update(id, { status: 'paused' });
  }

  resume(id: string): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task || task.status !== 'paused') return task;
    const updated = this.options.scheduleStore.update(id, { status: 'active' });
    if (updated) this.schedule(updated);
    return updated;
  }

  delete(id: string): boolean {
    this.clearTimer(id);
    return this.options.scheduleStore.delete(id);
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        ScheduledTask,
        | 'targetBotId'
        | 'prompt'
        | 'rule'
        | 'status'
        | 'chatId'
        | 'creatorOpenId'
      >
    >,
  ): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task) return undefined;
    const updated = this.options.scheduleStore.update(id, patch);
    if (updated) {
      this.clearTimer(id);
      if (updated.status === 'active') this.schedule(updated);
    }
    return updated;
  }

  removeMany(ids: string[]): number {
    let count = 0;
    for (const id of ids) {
      if (this.delete(id)) count += 1;
    }
    return count;
  }

  removeAll(): number {
    return this.removeMany(this.list().map((task) => task.id));
  }

  async runNow(id: string): Promise<ScheduledTask | undefined> {
    const task = this.options.scheduleStore.get(id);
    if (!task) return undefined;
    await this.trigger(
      task,
      this.options.now?.()?.toISOString() ?? new Date().toISOString(),
    );
    return this.options.scheduleStore.get(id);
  }

  private schedule(task: ScheduledTask): void {
    this.clearTimer(task.id);
    const delayMs = this.nextRunDelay(task);
    if (delayMs === undefined) return;
    const updated = this.options.scheduleStore.update(task.id, {
      nextRunAt: new Date(Date.now() + delayMs).toISOString(),
    });
    if (!updated) return;
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      void this.onDue(updated);
    }, delayMs);
    timer.unref?.();
    this.timers.set(task.id, timer);
  }

  private nextRunDelay(task: ScheduledTask): number | undefined {
    const now = this.options.now?.() ?? new Date();
    if (task.rule.kind === 'once') {
      const runAt = new Date(task.rule.runAt).getTime();
      if (runAt <= now.getTime()) return undefined;
      return runAt - now.getTime();
    }
    if (task.rule.kind === 'interval') return task.rule.everyMs;

    try {
      const cron = new Cron(task.rule.expression, {
        timezone: task.rule.timezone,
      });
      const next = cron.msToNext();
      return next === null || next === undefined
        ? undefined
        : Math.max(1_000, next);
    } catch (error) {
      console.error(
        `[定时] Cron 表达式无效，已暂停任务 ${task.id}:`,
        (error as Error).message,
      );
      this.options.scheduleStore.update(task.id, { status: 'paused' });
      return undefined;
    }
  }

  private async onDue(task: ScheduledTask): Promise<void> {
    const current = this.options.scheduleStore.get(task.id);
    if (!current || current.status !== 'active') return;
    const scheduledFor = new Date().toISOString();
    await this.trigger(current, scheduledFor);

    if (current.rule.kind === 'once') {
      this.options.scheduleStore.update(current.id, { status: 'completed' });
    } else {
      const refreshed = this.options.scheduleStore.get(current.id);
      if (refreshed?.status === 'active') this.schedule(refreshed);
    }
  }

  private async trigger(
    task: ScheduledTask,
    scheduledFor: string,
  ): Promise<void> {
    if (this.options.runStore.find(task.id, scheduledFor)) return;
    const running = this.options.runStore.latestRunning(task.id);
    if (running) {
      const skipped = this.options.runStore.create(task.id, scheduledFor);
      if (skipped) {
        this.options.runStore.markSkipped(skipped.id, '上一轮仍在执行，本轮跳过');
        // 跳过也是"后果"，同样不许静默——一个永远跟不上的任务，此前只会留下无人查看的记录。
        // 但必须**边沿触发**：连续跳过只报第一跳。否则一个间隔 1 分钟、执行 5 分钟的任务
        // 会用卡片把会话刷屏，而人真正需要知道的只是"它开始跟不上了"这一件事。
        // 判定不需要任何新状态，但也不能靠下标：list 按 startedAt 倒序，
        // 一旦时钟回拨或记录被手工修过，"[1]" 就未必是"上一次"。
        // 取「除本次之外最近的一轮」，语义与排序无关。
        const settled = this.options.runStore.find(task.id, scheduledFor) ?? skipped;
        const previous = this.options.runStore
          .list(task.id)
          .find((candidate) => candidate.id !== settled.id);
        if (previous && previous.status !== 'skipped') {
          // 不传 durationMs：跳过没有"耗时"可言，渲染 0.0s 是失真。
          await deliverScheduleReceipt({
            runtime: this.options.runtime,
            task,
            run: settled,
          });
        }
      }
      return;
    }
    const run = this.options.runStore.create(task.id, scheduledFor);
    if (!run) return;
    const taskId = randomUUID().replaceAll('-', '').slice(0, 24);
    this.options.scheduleStore.update(task.id, { lastRunAt: scheduledFor });

    // 系统内置守护任务特殊直通（不消耗外部 CLI 进程）：
    if (task.id === 'sys-arbitration-sweep') {
      try {
        await sweepArbitrations({ runtime: this.options.runtime });
        this.options.runStore.markSucceeded(run.id, taskId);
        return;
      } catch (err) {
        this.options.runStore.markFailed(run.id, (err as Error).message);
        recordFriction('GATE_INTERCEPTION', `[仲裁巡检] 失败: ${(err as Error).message}`);
        return;
      }
    }
    if (task.id === 'sys-lifecycle-sweep') {
      try {
        await sweepLifecycles({ runtime: this.options.runtime });
        this.options.runStore.markSucceeded(run.id, taskId);
        return;
      } catch (err) {
        this.options.runStore.markFailed(run.id, (err as Error).message);
        recordFriction('GATE_INTERCEPTION', `[生命周期巡检] 失败: ${(err as Error).message}`);
        return;
      }
    }

    let outcome: { answer?: string; durationMs?: number } = {};
    try {
      outcome = await dispatchScheduledTask({
        runtime: this.options.runtime,
        task,
        scheduledFor,
        defaultProductDeliveryMode: this.options.defaultProductDeliveryMode,
      });
      this.options.runStore.markSucceeded(run.id, taskId);
      console.log(
        `[定时] task=${task.id} run=${run.id} -> ${task.targetBotId} succeeded`,
      );
    } catch (error) {
      this.options.runStore.markFailed(run.id, (error as Error).message);
      console.error(
        `[定时] task=${task.id} run=${run.id} 执行失败:`,
        (error as Error).message,
      );
    } finally {
      // 交付回执放在 finally 而**不是** try/catch 之后：
      // 这样「无论成功还是抛错都必达」是语言语义保证的，而不是靠代码恰好写在两条分支汇合处。
      // 历史教训：把不变式检查只写在成功分支上，会把最需要被看见的失败路径变成静默。
      // 注：只有内置巡检（sys-*）提前 return 且不回执 —— 它们的产物是状态机跃迁而非面向人的结论，
      // 且 chatId 为 'system' 占位，本就无会话可投。
      // 「跳过」是另一条提前 return 的路径，它在上面**自带**边沿触发的回执（不在本处）。
      // 重新取回 run：mark* 是**替换式**更新，局部变量 run 已经过期。
      const settledRun = this.options.runStore.find(task.id, scheduledFor) ?? run;
      await deliverScheduleReceipt({
        runtime: this.options.runtime,
        task,
        run: settledRun,
        answer: outcome.answer,
        durationMs: outcome.durationMs,
      });
    }
  }

  private recoverInterruptedRuns(): void {
    for (const task of this.options.scheduleStore.list()) {
      for (const run of this.options.runStore.list(task.id)) {
        if (run.status === 'running') {
          this.options.runStore.markFailed(run.id, '进程重启，运行中断');
        }
      }
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}
