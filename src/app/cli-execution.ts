import { basename } from 'node:path';
import { runCli } from '../cli/runner.js';
import type { CliAdapter, CliExecutionEnv } from '../cli/types.js';
import { RunawayDetector, type RunawayVerdict } from '../core/runaway-detector.js';
import { recordFriction } from './friction-recorder.js';
import {
  DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS,
  type LockHolderContext,
  type LockMode,
  type OnLockWaiting,
  WorkspaceLockManager,
} from '../core/workspace-lock-manager.js';

export interface ExecuteCliOptions {
  holderId?: string;
  holderContext?: LockHolderContext;
  mode?: LockMode;
  lockTimeoutMs?: number;
  onWaiting?: OnLockWaiting;
  /** 持锁回调；允许异步，使调用方能在**拿到锁之后**采集工作区基准（如 git 指纹） */
  onLockAcquired?: () => void | Promise<void>;
  /** 循环检测分级信号；缺省时落到摩擦沉淀（M13），使同类打转可被自动归因 */
  onRunaway?: (verdict: RunawayVerdict) => void;
  /** 注入的检测器实例（会话级） */
  detector?: RunawayDetector;
}

/**
 * 循环检测信号的默认落点：摩擦沉淀（M13，共享单例）。
 *
 * 所有执行路径（首轮、澄清、修订、审批续跑、定时任务）都会经过 executeCli，
 * 因此把落点放在这一层，既能让每条路径自动获得摩擦归因，
 * 又避免在 7 个调用点各写一遍 —— 复制出来的落点迟早会漂移成 7 套标准。
 */
function makeRunawayFrictionRecorder(workspaceDir: string): (verdict: RunawayVerdict) => void {
  const workspaceKey = basename(workspaceDir);
  return (verdict: RunawayVerdict) => {
    recordFriction(
      'RUNAWAY_CIRCUIT_BROKEN',
      [
        `level=${verdict.level}`,
        `period=${verdict.period}`,
        `cycles=${verdict.cycles}`,
        verdict.reason ?? '',
        `signature=${verdict.signature}`,
      ].join(' | '),
      workspaceKey,
    );
  };
}

export async function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  stopToolNames: string[],
  onEvent: Parameters<typeof runCli>[0]['onEvent'],
  env: CliExecutionEnv,
  options?: ExecuteCliOptions,
) {
  const lockManager = WorkspaceLockManager.getInstance();
  const rawHolderId =
    options?.holderId ??
    (sessionId ? `session:${sessionId.slice(0, 8)}` : `cli:${adapter.id}`);

  // 严格依据外部显式契约决定锁模式，废除基于 Prompt 关键词的启发式正则猜测；缺省默认互斥写锁以守住物理单写边界
  const detectedMode = options?.mode ?? 'write';
  const timeoutMs =
    options?.lockTimeoutMs ?? DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS;

  const holderContext: LockHolderContext = options?.holderContext ?? {
    id: rawHolderId,
    mode: detectedMode,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  // 申请工作区排队锁（支持读写分离），并在 finally 中确保原子释放
  return lockManager.runWithLock(
    workspaceDir,
    holderContext,
    async () => {
      await options?.onLockAcquired?.();
      return runCli({
        adapter,
        prompt,
        cwd: workspaceDir,
        sessionId,
        signal,
        stopToolNames,
        env: {
          ...env,
          ...(holderContext.mode === 'read' ? { HARNESS_OS_LOCK_MODE: 'read' } : {}),
        },
        detector: options?.detector,
        onRunaway: options?.onRunaway ?? makeRunawayFrictionRecorder(workspaceDir),
        onEvent: (event) => {
          // 心跳保活：在 CLI 输出事件（stdout、tool_start、tool_end）时，刷新持锁时间戳
          lockManager.touch(workspaceDir, holderContext.id);
          onEvent?.(event);
        },
      });
    },
    timeoutMs,
    options?.onWaiting,
    signal,
  );
}


