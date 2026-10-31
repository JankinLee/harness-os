import type { CardJson } from '../im/card.js';
import {
  diffWorkspaceFingerprint,
  type WorkspaceFingerprint,
} from '../core/workspace-change-probe.js';

export type ReconGuardOutcome =
  | 'skipped'
  | 'clean'
  | 'violated'
  | 'unverifiable';

export interface ReconGuardDeps {
  /** 本次执行的 cwd（协作跳为链路工作区，否则为会话工作区） */
  executionCwd: string;
  /** 持锁后采集的基准指纹；缺省表示本次不是 recon，直接跳过 */
  baseline: WorkspaceFingerprint | undefined;
  readFingerprint: (workspaceDir: string) => Promise<WorkspaceFingerprint>;
  /** 是否回复在话题线程内；告警必须与同一路径上其余告警落在同一位置 */
  inThread?: boolean;
  /** 向话题推送告警卡 */
  replyCard: (card: CardJson, inThread: boolean) => Promise<void>;
  /** 收口进度卡（越权时把运行中的进度卡替换为熔断卡） */
  finishCard: (card: CardJson) => Promise<void>;
  /** 把否定结论回告上游派发方 */
  reportToUpstream: (options: {
    reason: string;
    changes: string[];
  }) => Promise<void>;
  buildAlert: (options: {
    title: string;
    level: 'yellow' | 'red';
    detail: string;
  }) => CardJson;
  recordFriction: (details: string) => void;
}

/**
 * 只读调研的**物理复核**（唯一实现，`index.ts` 只在两条路径上调用它）。
 *
 * 抽成独立模块的理由：这段逻辑此前是 `index.ts` 里的内联闭包，
 * 导致它成为「纯函数单测全绿、接线却零覆盖」的盲区 —— 而它恰恰是
 * 「先写坏文件、再触发熔断或静默超时」这条绕过路径上的唯一拦截点。
 *
 * 声明（`intent: 'recon'`）可被模型自我合理化绕过，工作区的前后差异不能。
 */
export async function verifyReconMutation(
  deps: ReconGuardDeps,
): Promise<ReconGuardOutcome> {
  if (!deps.baseline) return 'skipped';

  const mutation = diffWorkspaceFingerprint(
    deps.baseline,
    await deps.readFingerprint(deps.executionCwd),
  );

  if (mutation.inconclusive) {
    // 无法判定 ≠ 未改动：既要让人看见，也要让上游知道结论未被复核
    // 用 deps.inThread 而非写死 false：写死会让线程内的告警落到主话题，
    // 与同一路径上其余告警位置不一致，且让 deps 的该参数成为死参。
    await deps.replyCard(
      deps.buildAlert({
        title: '只读调研无法复核',
        level: 'yellow',
        detail: `目标工作区 \`${deps.executionCwd}\` ${mutation.inconclusiveReason ?? '无法判定'}。本次结果请按「未经物理复核」对待。`,
      }),
      deps.inThread ?? false,
    );
    await deps.reportToUpstream({
      reason: `本次只读调研**无法完成物理复核**：${mutation.inconclusiveReason ?? '环境不支持 git 变更探针'}`,
      changes: [],
    });
    // 与越权分支一样收口进度卡：否则它会永远停在 running，
    // 人类看到的是一张"还在跑"的卡而进程早已结束。
    await deps.finishCard(
      deps.buildAlert({
        title: '只读调研无法复核 · 已收口',
        level: 'yellow',
        detail: `无法用变更探针确认本次调研是否只读（${mutation.inconclusiveReason ?? '环境不支持'}）。结论已按「未经物理复核」回告上游。`,
      }),
    );
    return 'unverifiable';
  }

  if (!mutation.mutated) return 'clean';

  // M13：伪装调研的实现是典型同类阻碍，计次沉淀后 ≥3 次会自动提炼公理候选
  deps.recordFriction(
    `声明 recon 却改动工作区 ${mutation.changes.length} 处：${mutation.changes.slice(0, 5).join('; ')}`,
  );
  await deps.finishCard(
    deps.buildAlert({
      title: '只读调研越权 · 已熔断',
      level: 'red',
      detail: `本工单声明为只读调研，但执行后工作区发生 ${mutation.changes.length} 处变更，已判定为越权实现并熔断：\n${mutation.changes.slice(0, 10).join('\n')}`,
    }),
  );
  await deps.reportToUpstream({
    reason:
      '声明为只读调研（intent=recon）的工单在执行后**改动了工作区**，已按越权实现熔断。',
    changes: mutation.changes,
  });
  return 'violated';
}
