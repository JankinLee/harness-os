import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * .scratch 滞留资产的**只读**探针（Zero Token · 确定性 · 单次调用）
 *
 * 为什么是"探针"而不是"清扫器"：
 * 1. 规则无法等价于语义 —— `mtime` 无法区分"被放弃"与"被暂时挂起"。
 *    任何自动物理删除都会误伤战略资产，且不可逆（模式 10 强门禁）。
 * 2. 因此机器只负责**产出候选**（人类心智带宽不够翻全盘），
 *    裁决权与执行权交给人类 + 软归档（rename 天然可逆）。
 * 3. 严禁常驻守护进程：本模块只在被显式调用时读盘，不 tick、不写盘、不联网。
 *
 * 与既有归档链路的关系：`archiveSpecFlow` 是"状态机 → 文件"的单向寻址，
 * 只有挂上 ProductSpecFlow 的目录才可能被归档；Ad-hoc 排查目录对状态机**完全不可知**，
 * 于是永久滞留。本探针补的是反方向的对账：文件 → 状态。
 */

/** 归档destination目录名，与 scratch-archiver 保持一致 */
export const ARCHIVE_DIR_NAME = '.archive';

/** 判定停滞的默认租期（天）。7 天无任何物理改动视为冷资产。 */
export const SCRATCH_STALE_DAYS = 7;

const DAY_MS = 86_400_000;

export interface ScratchDirReport {
  /** 相对 `.scratch` 的目录名，即 `pnpm harness-os scratch archive <name>` 的入参 */
  name: string;
  path: string;
  fileCount: number;
  sizeBytes: number;
  /** 目录内最新的 mtime；空目录为 null */
  lastActivityAt: string | null;
  /** 距今天数；空目录为 null */
  staleDays: number | null;
  /**
   * linked   —— 被某条活跃方案流（pending/in_development/delivered）引用，有主
   * orphan   —— 未被任何活跃流引用（Ad-hoc 排查目录、已终结但未归档的半成品）
   * empty    —— 空目录
   */
  classification: 'linked' | 'orphan' | 'empty';
  suggested: 'keep' | 'archive';
  reason: string;
}

export interface ScratchSurvey {
  root: string;
  /** 根目录是否存在。必须与"扫到了但没东西"分开表达 —— 两者对操作者的含义完全相反。 */
  rootExists: boolean;
  scannedAt: string;
  staleAfterDays: number;
  dirs: ScratchDirReport[];
  /** `.scratch` 根下的散落文件：违反 `.scratch/<feature>/` 纪律的直接证据 */
  strayFiles: string[];
  archived: { dirs: number; sizeBytes: number };
  totals: { dirs: number; files: number; sizeBytes: number; archiveCandidates: number };
}

function walk(dir: string): { fileCount: number; sizeBytes: number; latest: number } {
  let fileCount = 0;
  let sizeBytes = 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // 符号链接不跟随：避免把仓外内容算进体积，也避免成环。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const nested = walk(full);
      fileCount += nested.fileCount;
      sizeBytes += nested.sizeBytes;
      latest = Math.max(latest, nested.latest);
      continue;
    }
    if (!entry.isFile()) continue;
    fileCount += 1;
    try {
      const stat = statSync(full);
      sizeBytes += stat.size;
      latest = Math.max(latest, stat.mtimeMs);
    } catch {
      // 文件在扫描途中被移走：跳过而不是中断整次对账。
    }
  }
  return { fileCount, sizeBytes, latest };
}

/**
 * 反向对账：扫描 `.scratch` 真实目录，比对"被活跃方案流引用的路径"集合。
 * 纯读操作 —— 不创建、不移动、不删除任何东西。
 */
export function probeScratchOrphans(options: {
  root: string;
  /** 活跃方案流的 `specPath`（工作区相对路径），用于判定目录"有没有主" */
  referencedPaths?: string[];
  staleAfterDays?: number;
  now?: number;
}): ScratchSurvey {
  const root = resolve(options.root);
  const staleAfterDays = options.staleAfterDays ?? SCRATCH_STALE_DAYS;
  const now = options.now ?? Date.now();
  const referenced = (options.referencedPaths ?? [])
    .map((p) => p.replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((p) => p.startsWith('.scratch/'))
    .map((p) => p.slice('.scratch/'.length));

  const dirs: ScratchDirReport[] = [];
  const strayFiles: string[] = [];
  let archivedDirs = 0;
  let archivedSize = 0;

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // 根目录不存在 ≠ 没有滞留资产：前者通常意味着"跑错目录了"或"工作区尚未建立"，
    // 若与后者同渲染，操作者会把"扫了个空"误读成"这里是干净的"。
    return {
      root,
      rootExists: false,
      scannedAt: new Date(now).toISOString(),
      staleAfterDays,
      dirs: [],
      strayFiles: [],
      archived: { dirs: 0, sizeBytes: 0 },
      totals: { dirs: 0, files: 0, sizeBytes: 0, archiveCandidates: 0 },
    };
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) {
      if (entry.isFile()) strayFiles.push(entry.name);
      continue;
    }

    const full = join(root, entry.name);
    const measured = walk(full);

    if (entry.name === ARCHIVE_DIR_NAME) {
      // 归档区自身不参与"待归档"判定，只作为存量体积被呈现。
      archivedDirs = measured.fileCount === 0 ? 0 : 1;
      archivedSize = measured.sizeBytes;
      continue;
    }

    const lastActivity = measured.latest > 0 ? measured.latest : null;
    const staleDays =
      lastActivity === null ? null : Math.max(0, Math.floor((now - lastActivity) / DAY_MS));
    const isReferenced = referenced.some(
      (p) => p === entry.name || p.startsWith(`${entry.name}/`),
    );

    let classification: ScratchDirReport['classification'];
    let suggested: ScratchDirReport['suggested'];
    let reason: string;

    if (measured.fileCount === 0) {
      classification = 'empty';
      suggested = 'archive';
      reason = '空目录，无任何产物';
    } else if (isReferenced) {
      classification = 'linked';
      suggested = 'keep';
      reason = '被活跃方案流引用，状态机仍持有它';
    } else if (staleDays !== null && staleDays >= staleAfterDays) {
      classification = 'orphan';
      suggested = 'archive';
      reason = `未纳管且 ${staleDays} 天无改动（≥ ${staleAfterDays} 天租期）`;
    } else {
      classification = 'orphan';
      suggested = 'keep';
      reason = `未纳管但在租期内（${staleDays ?? 0} 天），可能是在飞的 Ad-hoc 排查`;
    }

    dirs.push({
      name: entry.name,
      path: full,
      fileCount: measured.fileCount,
      sizeBytes: measured.sizeBytes,
      lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
      staleDays,
      classification,
      suggested,
      reason,
    });
  }

  dirs.sort((a, b) => (b.staleDays ?? -1) - (a.staleDays ?? -1));

  return {
    root,
    rootExists: true,
    scannedAt: new Date(now).toISOString(),
    staleAfterDays,
    dirs,
    strayFiles,
    archived: { dirs: archivedDirs, sizeBytes: archivedSize },
    totals: {
      dirs: dirs.length,
      files: dirs.reduce((sum, d) => sum + d.fileCount, 0),
      sizeBytes: dirs.reduce((sum, d) => sum + d.sizeBytes, 0),
      archiveCandidates: dirs.filter((d) => d.suggested === 'archive').length,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** 把对账结果渲染成人可读文本。只陈述事实，不替人类下结论。 */
export function formatScratchSurvey(survey: ScratchSurvey): string {
  if (!survey.rootExists) {
    return [
      `[.scratch 对账] ${survey.root}`,
      '  ⚠ 根目录不存在：本次**没有扫到任何东西**，这不等于"没有滞留资产"。',
      '    请确认命令是否在项目根目录执行。',
    ].join('\n');
  }
  const lines: string[] = [
    `[.scratch 对账] ${survey.root}`,
    `待归档候选: ${survey.totals.archiveCandidates} / ${survey.totals.dirs} 个目录；` +
      `在管体积 ${formatBytes(survey.totals.sizeBytes)}（${survey.totals.files} 文件）；` +
      `已归档存量 ${formatBytes(survey.archived.sizeBytes)}`,
  ];

  for (const dir of survey.dirs) {
    const mark = dir.suggested === 'archive' ? '归档?' : '保留 ';
    lines.push(
      `  ${mark} ${dir.name} — ${dir.fileCount} 文件 / ${formatBytes(dir.sizeBytes)} / ` +
        `${dir.staleDays ?? '-'} 天无改动 · ${dir.classification} · ${dir.reason}`,
    );
  }

  if (survey.strayFiles.length) {
    lines.push(
      `  散落文件 ${survey.strayFiles.length} 个（违反 .scratch/<feature>/ 纪律）: ` +
        survey.strayFiles.join(', '),
    );
  }

  if (survey.totals.archiveCandidates === 0) lines.push('  —— 无滞留资产。');
  else
    lines.push(
      '  归档是软移送（rename 至 .archive/），完全可逆；请人工确认后执行: ' +
        'pnpm harness-os scratch archive <name>',
    );

  return lines.join('\n');
}
