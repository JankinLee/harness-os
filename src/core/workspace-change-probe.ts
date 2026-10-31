import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 工作区「是否被改动」的物理指纹 */
export interface WorkspaceFingerprint {
  /** 目标目录不是 git 仓库时无法判定 —— 明确标记，而不是谎报「未改动」 */
  isRepository: boolean;
  /** 状态条目（形如 ` M src/a.ts`、`?? src/new.ts`），反映路径集合的变化 */
  entries: string[];
  /**
   * 已跟踪文件的**内容指纹**（`git diff HEAD` 的哈希）。
   *
   * 为什么不能只看 `git status --porcelain`：它只输出「状态码 + 路径」，
   * 一个**本来就脏**的文件被再次改写时，前后输出逐字节相同 ——
   * 于是「recon 改写了既有脏文件」会被判成「没有改动」而放行。
   */
  contentDigest: string;
}

export interface WorkspaceMutation {
  /** 是否发生了实质改动 */
  mutated: boolean;
  /** 新增或内容变化的条目（供回告人类时展示） */
  changes: string[];
  /** 无法判定（非 git 仓库 / git 调用失败 / 内容过大）：**不得**当作未改动 */
  inconclusive: boolean;
  /** 无法判定的原因（供告警文案使用） */
  inconclusiveReason?: string;
}

const MAX_DIFF_BUFFER = 16 * 1024 * 1024;

/**
 * `git diff HEAD` 为空（工作区完全干净）时的 SHA-1 指纹常量。
 * 用于区分「工作区被清理干净」与「已跟踪文件发生二次篡改」。
 */
export const EMPTY_CONTENT_DIGEST = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

/**
 * 读取工作区的物理变更指纹。
 *
 * 用途：把「这次执行到底是只读调研还是真的改了东西」从**声明**降级为**物理事实**。
 * 声明（`intent: 'recon'`）可被模型自我合理化绕过，而工作区的前后差异不能。
 *
 * 刻意不看被 gitignore 的目录（如 `.scratch/`）：那类产物不污染主线，不构成越权实现。
 */
export async function readWorkspaceFingerprint(
  workspaceDir: string,
): Promise<WorkspaceFingerprint> {
  try {
    const { stdout: inside } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: workspaceDir, timeout: 10_000, windowsHide: true },
    );
    if (inside.trim() !== 'true') {
      return { isRepository: false, entries: [], contentDigest: '' };
    }
    // -uall：把未跟踪目录展开到文件级，避免「新目录里塞满文件」只报一行而看不出爆炸半径
    const [{ stdout: statusOut }, { stdout: diffOut }] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain', '-uall'], {
        cwd: workspaceDir,
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: MAX_DIFF_BUFFER,
      }),
      // 与 HEAD 的全量差异（含已暂存），内容一变哈希就变；纯读取，不写任何对象
      execFileAsync('git', ['diff', 'HEAD'], {
        cwd: workspaceDir,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: MAX_DIFF_BUFFER,
      }),
    ]);
    const entries = [
      ...new Set(
        statusOut
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ].sort();
    const contentDigest = createHash('sha1').update(diffOut).digest('hex');
    return { isRepository: true, entries, contentDigest };
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`[工作区探针] 无法读取 ${workspaceDir} 的 git 状态:`, message);
    // 缓冲区溢出属于「读不全」，绝不能降级成「没改动」——那会把一次越权洗成干净
    return {
      isRepository: false,
      entries: [],
      contentDigest: '',
    };
  }
}

/**
 * 比对前后指纹，判定本次执行是否改动了工作区（纯函数，可穷举测试）。
 *
 * 三种判定：
 * - 任一侧不是 git 仓库（含读取失败/超出缓冲）→ `inconclusive`，**不得**当成未改动；
 * - 状态条目新增，或已跟踪内容哈希变化 → `mutated`；
 * - 仅条目消失（执行把原本的脏改动清理干净）→ 不算越权改动。
 */
export function diffWorkspaceFingerprint(
  before: WorkspaceFingerprint,
  after: WorkspaceFingerprint,
): WorkspaceMutation {
  if (!before.isRepository || !after.isRepository) {
    return {
      mutated: false,
      changes: [],
      inconclusive: true,
      inconclusiveReason: '目标工作区不是 git 仓库（或 git 读取失败），无法用变更探针复核',
    };
  }
  const beforeSet = new Set(before.entries);
  const changes = after.entries.filter((entry) => !beforeSet.has(entry));
  // 内容哈希变化必须单独判定：同一个脏文件被再次改写时条目集合不变。
  // 特别注意：若执行把工作区清理干净（after 指纹变为 EMPTY_CONTENT_DIGEST 或 ''，
  // 且未引入新增未跟踪/修改条目），属于合法的清理恢复，绝不得误判为越权突变。
  const isAfterClean =
    after.contentDigest === EMPTY_CONTENT_DIGEST || after.contentDigest === '';
  const contentChanged =
    before.contentDigest !== after.contentDigest && !isAfterClean;
  if (contentChanged) {
    changes.unshift(
      `已跟踪文件内容发生变化（内容指纹 ${before.contentDigest.slice(0, 8)} → ${after.contentDigest.slice(0, 8)}）`,
    );
  }
  return { mutated: changes.length > 0, changes, inconclusive: false };
}
