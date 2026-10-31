import { normalize, resolve } from 'node:path';

export type ReleaseLock = () => void;
export type LockMode = 'read' | 'write';

export interface LockHolderContext {
  id: string;
  mode?: LockMode;
  botId?: string;
  botRole?: string;
  taskSubject?: string;
  chatId?: string;
  threadId?: string;
  startedAt?: number;
  lastActivityAt?: number;
  renewCount?: number;
}

export interface LockWaitingDetailedInfo {
  holderId: string;
  holderContext?: LockHolderContext;
  queuePosition: number;
  timeoutMs: number;
  elapsedMs?: number;
  isHolderActive?: boolean;
  renewCount?: number;
  mode?: LockMode;
}

// 兼容既有类型与回调
export type LockWaitingInfo = LockWaitingDetailedInfo;
export type OnLockWaiting = (info: LockWaitingDetailedInfo) => void;

export const DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS = 300_000;
export const ADAPTIVE_CHECK_WINDOW_MS = 240_000; // 240s 触发活跃度自适应检测
export const HEARTBEAT_ACTIVE_THRESHOLD_MS = 60_000; // 过去 60s 内有心跳视为健康活跃
export const ADAPTIVE_EXTENSION_MS = 300_000; // 自适应延长 300s (5分钟)
export const MAX_AUTO_RENEW_COUNT = 2; // 最多自动续期 2 次

interface LockWaiter {
  holderContext: LockHolderContext;
  resolve: (release: ReleaseLock) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
  enqueuedAt: number;
  renewCount: number;
  onWaiting?: OnLockWaiting;
  signal?: AbortSignal;
  onAbort?: () => void;
  workspaceKey: string;
}

interface ActiveLocks {
  readers: Map<string, LockHolderContext>; // holderId -> Context
  writer?: LockHolderContext;
}

function lockKey(workspacePath: string): string {
  const norm = normalize(resolve(workspacePath));
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function toHolderContext(
  holder: string | LockHolderContext,
  defaultMode: LockMode = 'write',
): LockHolderContext {
  if (typeof holder === 'string') {
    return {
      id: holder,
      mode: defaultMode,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      renewCount: 0,
    };
  }
  return {
    ...holder,
    mode: holder.mode ?? defaultMode,
    startedAt: holder.startedAt ?? Date.now(),
    lastActivityAt: holder.lastActivityAt ?? Date.now(),
    renewCount: holder.renewCount ?? 0,
  };
}

export class WorkspaceLockManager {
  private static instance?: WorkspaceLockManager;
  // workspaceKey -> ActiveLocks
  private readonly activeLocks = new Map<string, ActiveLocks>();
  // workspaceKey -> LockWaiter[]
  private readonly queues = new Map<string, LockWaiter[]>();

  static getInstance(): WorkspaceLockManager {
    if (!this.instance) {
      this.instance = new WorkspaceLockManager();
    }
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = undefined;
  }

  private getOrCreateActive(key: string): ActiveLocks {
    let active = this.activeLocks.get(key);
    if (!active) {
      active = { readers: new Map() };
      this.activeLocks.set(key, active);
    }
    return active;
  }

  isLocked(workspacePath: string): boolean {
    const key = lockKey(workspacePath);
    const active = this.activeLocks.get(key);
    if (!active) return false;
    return !!active.writer || active.readers.size > 0;
  }

  getHolder(workspacePath: string): string | undefined {
    const key = lockKey(workspacePath);
    const active = this.activeLocks.get(key);
    if (!active) return undefined;
    if (active.writer) return active.writer.id;
    if (active.readers.size > 0) {
      // 优先返回第一个 reader 的 id
      return active.readers.keys().next().value;
    }
    return undefined;
  }

  getHolderContext(workspacePath: string): LockHolderContext | undefined {
    const key = lockKey(workspacePath);
    const active = this.activeLocks.get(key);
    if (!active) return undefined;
    if (active.writer) return active.writer;
    if (active.readers.size > 0) {
      return active.readers.values().next().value;
    }
    return undefined;
  }

  /**
   * 刷新锁持有者最新活动时间戳（心跳保活）
   */
  touch(workspacePath: string, holderId: string): boolean {
    const key = lockKey(workspacePath);
    const active = this.activeLocks.get(key);
    if (!active) return false;

    if (active.writer && active.writer.id === holderId) {
      active.writer.lastActivityAt = Date.now();
      return true;
    }

    const reader = active.readers.get(holderId);
    if (reader) {
      reader.lastActivityAt = Date.now();
      return true;
    }

    return false;
  }

  /**
   * 手动延长等待者的排队超时时间（如卡片中用户主动点击「继续等待」）
   */
  extendWaitTimeout(
    workspacePath: string,
    waiterHolderId: string,
    additionalMs = ADAPTIVE_EXTENSION_MS,
  ): boolean {
    const key = lockKey(workspacePath);
    const queue = this.queues.get(key);
    if (!queue) return false;

    const waiter = queue.find((w) => w.holderContext.id === waiterHolderId);
    if (!waiter) return false;

    clearTimeout(waiter.timer);
    waiter.timeoutMs += additionalMs;
    waiter.renewCount += 1;
    this.setupWaiterTimer(waiter, additionalMs);

    // 通知排队回调
    this.notifyWaiters(key);
    return true;
  }

  /**
   * 优雅将排队中的等待者切换为读锁申请模式
   */
  switchWaiterToRead(workspacePath: string, waiterHolderId: string): boolean {
    const key = lockKey(workspacePath);
    let queue = this.queues.get(key);
    let waiter = queue?.find((w) => w.holderContext.id === waiterHolderId);

    // 容错兜底：若根据传入路径未找到，遍历全量队列按 holderId 寻址，防止路径形态差异导致漏检
    if (!waiter) {
      for (const [, q] of this.queues.entries()) {
        const found = q.find((w) => w.holderContext.id === waiterHolderId);
        if (found) {
          waiter = found;
          queue = q;
          break;
        }
      }
    }

    if (!waiter || !queue) return false;

    waiter.holderContext.mode = 'read';
    // 触发调度检查，看是否可以直接获取读锁（严格使用等待者实际所在的工作区键）
    this.drainQueue(waiter.workspaceKey);
    return true;
  }

  /**
   * 申请互斥写锁（独占）
   */
  async acquire(
    workspacePath: string,
    holder: string | LockHolderContext,
    timeoutMs = DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
    onWaiting?: OnLockWaiting,
    signal?: AbortSignal,
  ): Promise<ReleaseLock> {
    return this.acquireLock(workspacePath, holder, 'write', timeoutMs, onWaiting, signal);
  }

  /**
   * 申请共享读锁（读读并发）
   */
  async acquireRead(
    workspacePath: string,
    holder: string | LockHolderContext,
    timeoutMs = DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
    onWaiting?: OnLockWaiting,
    signal?: AbortSignal,
  ): Promise<ReleaseLock> {
    return this.acquireLock(workspacePath, holder, 'read', timeoutMs, onWaiting, signal);
  }

  /**
   * 申请互斥写锁的别名
   */
  async acquireWrite(
    workspacePath: string,
    holder: string | LockHolderContext,
    timeoutMs = DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
    onWaiting?: OnLockWaiting,
    signal?: AbortSignal,
  ): Promise<ReleaseLock> {
    return this.acquireLock(workspacePath, holder, 'write', timeoutMs, onWaiting, signal);
  }

  private async acquireLock(
    workspacePath: string,
    holder: string | LockHolderContext,
    requestedMode: LockMode,
    timeoutMs = DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
    onWaiting?: OnLockWaiting,
    signal?: AbortSignal,
  ): Promise<ReleaseLock> {
    const key = lockKey(workspacePath);
    const ctx = toHolderContext(holder, requestedMode);

    if (signal?.aborted) {
      throw new Error('Task aborted');
    }

    const active = this.getOrCreateActive(key);

    // 重入检查：如果当前写锁持有者是自己，直接重入
    if (active.writer && active.writer.id === ctx.id) {
      return () => {};
    }
    // 如果自己已经持有读锁且申请的是读锁，直接重入
    if (requestedMode === 'read' && active.readers.has(ctx.id)) {
      return () => {};
    }

    const queue = this.queues.get(key) ?? [];

    // 写优先策略：
    // 若申请写锁：必须没有 writer，且没有任何 reader，且排队队列中没有等待者
    // 若申请读锁：必须没有 writer，且排队队列中没有正在等待的写锁（防止写饥饿）
    const canAcquireImmediately = () => {
      if (requestedMode === 'write') {
        return !active.writer && active.readers.size === 0 && queue.length === 0;
      }
      // read 模式
      if (active.writer) return false;
      const hasWaitingWriter = queue.some((w) => w.holderContext.mode === 'write');
      return !hasWaitingWriter;
    };

    if (canAcquireImmediately()) {
      if (requestedMode === 'write') {
        active.writer = ctx;
        return () => this.releaseWrite(key, ctx.id);
      } else {
        active.readers.set(ctx.id, ctx);
        return () => this.releaseRead(key, ctx.id);
      }
    }

    // 需要排队
    const queuePosition = queue.length + 1;
    const currentPrimaryHolder = active.writer ?? active.readers.values().next().value;

    const waitInfo: LockWaitingDetailedInfo = {
      holderId: currentPrimaryHolder ? currentPrimaryHolder.id : 'unknown',
      holderContext: currentPrimaryHolder,
      queuePosition,
      timeoutMs,
      elapsedMs: 0,
      isHolderActive: currentPrimaryHolder
        ? Date.now() - (currentPrimaryHolder.lastActivityAt ?? Date.now()) <=
          HEARTBEAT_ACTIVE_THRESHOLD_MS
        : false,
      renewCount: 0,
      mode: requestedMode,
    };

    try {
      onWaiting?.(waitInfo);
    } catch (err) {
      console.error('[WorkspaceLockManager] onWaiting 回调异常:', err);
    }

    return new Promise<ReleaseLock>((res, rej) => {
      let waiter: LockWaiter;

      const cleanup = () => {
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
      };

      const onAbort = () => {
        cleanup();
        const currentQueue = this.queues.get(key) ?? [];
        const index = currentQueue.indexOf(waiter);
        if (index !== -1) currentQueue.splice(index, 1);
        this.notifyWaiters(key);
        rej(new Error('Task aborted'));
      };

      waiter = {
        holderContext: ctx,
        resolve: (releaseFn) => {
          cleanup();
          res(releaseFn);
        },
        reject: (err) => {
          cleanup();
          rej(err);
        },
        timer: null as any, // 稍后 setupWaiterTimer 设置
        timeoutMs,
        enqueuedAt: Date.now(),
        renewCount: 0,
        onWaiting,
        signal,
        onAbort,
        workspaceKey: key,
      };

      this.setupWaiterTimer(waiter, timeoutMs);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      queue.push(waiter);
      this.queues.set(key, queue);
    });
  }

  /**
   * 为等待者装配具有自适应心跳检测的定时器
   */
  private setupWaiterTimer(waiter: LockWaiter, remainingMs: number): void {
    const key = waiter.workspaceKey;

    // 如果剩余等待时间大于 240 秒检测线，先设置定时器在 (remainingMs - 60s) 时触发自适应探测
    // 若剩余时间较短（如单元测试中的几十毫秒），直接使用 remainingMs
    const adaptiveWindow = 60_000;
    const checkPointMs =
      remainingMs > ADAPTIVE_CHECK_WINDOW_MS ? remainingMs - adaptiveWindow : remainingMs;

    waiter.timer = setTimeout(() => {
      const currentQueue = this.queues.get(key) ?? [];
      const index = currentQueue.indexOf(waiter);
      if (index === -1) return; // 已经出队

      // 如果剩余时间已经全部耗尽
      const elapsed = Date.now() - waiter.enqueuedAt;
      if (elapsed >= waiter.timeoutMs) {
        // 超时触发前，进行最后一次活跃度自适应检测
        // 只有当排队到达或超过自适应临界窗口 (240s) 且设置了长等待超时 (timeoutMs >= ADAPTIVE_CHECK_WINDOW_MS) 时，才触发阶梯自动续期
        const active = this.activeLocks.get(key);
        const currentPrimaryHolder = active?.writer ?? active?.readers.values().next().value;
        const isHolderActive = currentPrimaryHolder
          ? Date.now() - (currentPrimaryHolder.lastActivityAt ?? 0) <=
            HEARTBEAT_ACTIVE_THRESHOLD_MS
          : false;

        // 若满足自适应续期窗口条件，前序持有者在过去 60s 内保持活跃，且自动续期次数尚未耗尽
        if (
          waiter.timeoutMs >= ADAPTIVE_CHECK_WINDOW_MS &&
          elapsed >= ADAPTIVE_CHECK_WINDOW_MS &&
          isHolderActive &&
          waiter.renewCount < MAX_AUTO_RENEW_COUNT
        ) {
          waiter.renewCount += 1;
          waiter.timeoutMs += ADAPTIVE_EXTENSION_MS;
          console.log(
            `[WorkspaceLockManager] 前序任务保持活跃，自适应延长等待 300s (续期 ${waiter.renewCount}/${MAX_AUTO_RENEW_COUNT})`,
          );
          this.setupWaiterTimer(waiter, ADAPTIVE_EXTENSION_MS);
          this.notifyWaiters(key);
          return;
        }

        // 真实超时
        currentQueue.splice(index, 1);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        const holderName = currentPrimaryHolder ? currentPrimaryHolder.id : 'unknown';
        waiter.reject(
          new Error(
            `获取工作区写锁超时 (${waiter.timeoutMs}ms): ${key} 当前被 ${holderName} 持有`,
          ),
        );
        this.notifyWaiters(key);
        return;
      }

      // 到达检查点但尚未完全耗尽
      const remaining = waiter.timeoutMs - elapsed;
      this.setupWaiterTimer(waiter, remaining);
      this.notifyWaiters(key);
    }, checkPointMs);

    // 刻意不调用 unref()：等待锁的 Promise 尚未收口时，timer 必须让事件循环保持存活。
    // Node 22 的 test runner 在事件循环先于 Promise 结束时，会把整个测试标记为
    // "Promise resolution is still pending but the event loop has already resolved"；
    // 生产环境即使有其他 handle 掩盖，本质上仍是"等待被静默取消"。
  }

  private releaseWrite(key: string, holderId: string): void {
    const active = this.activeLocks.get(key);
    if (!active || active.writer?.id !== holderId) {
      return;
    }
    active.writer = undefined;
    this.drainQueue(key);
  }

  private releaseRead(key: string, holderId: string): void {
    const active = this.activeLocks.get(key);
    if (!active) return;
    active.readers.delete(holderId);
    this.drainQueue(key);
  }

  /**
   * 唤醒队列中可以被满足的等待者
   */
  private drainQueue(key: string): void {
    const active = this.getOrCreateActive(key);
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      if (!active.writer && active.readers.size === 0) {
        this.activeLocks.delete(key);
        this.queues.delete(key);
      }
      return;
    }

    // 如果当前有 writer，谁都不能获取
    if (active.writer) {
      this.notifyWaiters(key);
      return;
    }

    const first = queue[0];
    if (first.holderContext.mode === 'write') {
      // 下一个是写锁，但必须当前没有任何 reader 才能授予
      if (active.readers.size === 0) {
        const nextWriter = queue.shift()!;
        clearTimeout(nextWriter.timer);
        if (nextWriter.signal && nextWriter.onAbort) {
          nextWriter.signal.removeEventListener('abort', nextWriter.onAbort);
        }
        active.writer = nextWriter.holderContext;
        nextWriter.resolve(() => this.releaseWrite(key, nextWriter.holderContext.id));
        this.notifyWaiters(key);
      } else {
        // 还有 reader 在读，写锁继续等
        this.notifyWaiters(key);
      }
    } else {
      // 下一个是读锁，连续放行队列头部的所有读锁（直到遇到写锁）
      while (queue.length > 0 && queue[0].holderContext.mode === 'read') {
        const nextReader = queue.shift()!;
        clearTimeout(nextReader.timer);
        if (nextReader.signal && nextReader.onAbort) {
          nextReader.signal.removeEventListener('abort', nextReader.onAbort);
        }
        active.readers.set(nextReader.holderContext.id, nextReader.holderContext);
        nextReader.resolve(() => this.releaseRead(key, nextReader.holderContext.id));
      }
      this.notifyWaiters(key);
    }
  }

  private notifyWaiters(key: string): void {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    const active = this.activeLocks.get(key);
    const currentPrimaryHolder = active?.writer ?? active?.readers.values().next().value;
    const isHolderActive = currentPrimaryHolder
      ? Date.now() - (currentPrimaryHolder.lastActivityAt ?? 0) <= HEARTBEAT_ACTIVE_THRESHOLD_MS
      : false;

    for (let i = 0; i < queue.length; i++) {
      const waiter = queue[i];
      const elapsedMs = Date.now() - waiter.enqueuedAt;
      try {
        waiter.onWaiting?.({
          holderId: currentPrimaryHolder ? currentPrimaryHolder.id : 'unknown',
          holderContext: currentPrimaryHolder,
          queuePosition: i + 1,
          timeoutMs: waiter.timeoutMs,
          elapsedMs,
          isHolderActive,
          renewCount: waiter.renewCount,
          mode: waiter.holderContext.mode,
        });
      } catch (err) {
        console.error('[WorkspaceLockManager] onWaiting 回调异常:', err);
      }
    }
  }

  async runWithLock<T>(
    workspacePath: string,
    holder: string | LockHolderContext,
    operation: () => Promise<T>,
    timeoutMs = DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
    onWaiting?: OnLockWaiting,
    signal?: AbortSignal,
  ): Promise<T> {
    const mode = typeof holder === 'object' && holder.mode ? holder.mode : 'write';
    const release =
      mode === 'read'
        ? await this.acquireRead(workspacePath, holder, timeoutMs, onWaiting, signal)
        : await this.acquire(workspacePath, holder, timeoutMs, onWaiting, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
