import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { JsonProductSpecFlowStore } from '../core/product-spec-store.js';
import { archiveScratchFeature } from './scratch-archiver.js';
import {
  ARCHIVE_DIR_NAME,
  SCRATCH_STALE_DAYS,
  formatBytes,
  formatScratchSurvey,
  probeScratchOrphans,
  type ScratchSurvey,
} from './scratch-survey.js';

const SCRATCH_ROOT = '.scratch';
const SPEC_FLOW_FILE = join('data', 'product-spec-flows.json');

/**
 * 「仍在飞」的定义：方案还没走完，它持有的工作区目录就不是垃圾。
 *
 * 刻意**不含** `delivered` —— 方案已交付意味着工作已经做完，
 * 目录可以归档（生命周期的 14 天自动归档本来就会收走它）。
 * 把 delivered 也算作"持有"，会让最常见的清理场景被硬拦住。
 * 这份定义**同时**供对账探针与归档守卫使用：两处必须同源，否则工具会先告诉你"保留"、
 * 再在你的归档命令上放行。
 */
const HOLDING_LIFECYCLES = new Set(['pending', 'in_development']);

interface HoldingReference {
  /** 方案流持有的工作区相对路径，如 `.scratch/foo/spec.md` */
  path: string;
  lifecycle: string;
  token: string;
}

/**
 * 收集"当前仍被在飞方案流持有"的工作区路径。
 *
 * 读盘失败一律降级为"没有在飞引用"——宁可多报候选（人类会看），
 * 不可少报（滞留会继续堆积且无人知晓）。但降级必须**留痕**：
 * 静默地返回空集会让所有在飞目录都被列成归档候选，反而诱导人去归档正在用的东西。
 */
function collectHoldingReferences(flowFile = SPEC_FLOW_FILE): HoldingReference[] {
  if (!existsSync(flowFile)) {
    console.warn(
      `[.scratch 对账] 未找到方案流文件 ${flowFile}：本次对账无法识别"在飞"目录，` +
        '所有候选均需人工复核。',
    );
    return [];
  }
  try {
    const flows = new JsonProductSpecFlowStore(flowFile).listAll();
    return flows
      .filter((flow) => flow.lifecycle !== undefined && HOLDING_LIFECYCLES.has(flow.lifecycle))
      // lark-doc 模式的方案没有本地工作区，天然不持有 .scratch 目录。
      .map((flow) => ({
        path: flow.request.deliveryMode === 'local' ? flow.request.specPath : undefined,
        lifecycle: flow.lifecycle as string,
        token: flow.token,
      }))
      .filter((ref): ref is HoldingReference => typeof ref.path === 'string' && ref.path.length > 0);
  } catch (error) {
    console.warn(
      `[.scratch 对账] 读取方案流失败，按无在飞引用处理（候选需人工复核）: ${(error as Error).message}`,
    );
    return [];
  }
}

/** 某个路径是否落在 `.scratch/<name>/` 之内（含其本身） */
function pathHoldsFeature(specPath: string, name: string): boolean {
  const normalized = specPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const prefix = `${SCRATCH_ROOT}/${name}`;
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

export function surveyScratch(
  root = SCRATCH_ROOT,
  flowFile = SPEC_FLOW_FILE,
): ScratchSurvey {
  return probeScratchOrphans({
    root,
    referencedPaths: collectHoldingReferences(flowFile).map((ref) => ref.path),
  });
}

/** 只读对账。绝不移动任何文件 —— 候选由人裁决。 */
export function runScratchStatus(
  root = SCRATCH_ROOT,
  flowFile = SPEC_FLOW_FILE,
): ScratchSurvey {
  const survey = surveyScratch(root, flowFile);
  console.log(formatScratchSurvey(survey));
  return survey;
}

export interface ScratchArchiveOutcome {
  ok: boolean;
  message: string;
  targetDir?: string;
}

/**
 * 软归档：原子 rename 至 `.scratch/.archive/<date>_<name>/`，完全可逆。
 * 这是人类**显式**的一次授权动作 —— 探针只负责把候选摆到人面前。
 *
 * 返回值而非 `process.exitCode`：退出码由 CLI 入口决定，
 * 否则单测调用本函数会把退出码泄漏给测试进程，让全绿测试以非零码收场。
 */
export function runScratchArchive(
  name?: string,
  root = SCRATCH_ROOT,
  flowFile = SPEC_FLOW_FILE,
): ScratchArchiveOutcome {
  const fail = (message: string): ScratchArchiveOutcome => {
    console.error(message);
    return { ok: false, message };
  };

  if (!name) {
    return fail('[.scratch 归档] 缺少目录名。用法: pnpm harness-os scratch archive <name>');
  }

  // 名字必须恰好是一个路径段：任何分隔符都意味着调用方想操作 `.scratch` 之外的东西。
  if (name !== name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return fail(`[.scratch 归档] 非法目录名: ${name}（只接受 .scratch 下的一级目录名）`);
  }

  const scratchBase = resolve(root);
  const target = resolve(scratchBase, name);
  if (!target.startsWith(scratchBase + sep)) {
    return fail(`[.scratch 归档] 越界: ${target} 不在 ${scratchBase} 内`);
  }

  // 与对账探针**同源**的守卫：探针说"保留"的目录，归档命令也必须拒绝。
  // 否则工具会自相矛盾——先建议保留，再照做归档，而 in_development 方案的
  // specPath 会指向一个已不存在的目录，下一次修订直接校验失败。
  const holder = collectHoldingReferences(flowFile).find((ref) => pathHoldsFeature(ref.path, name));
  if (holder) {
    return fail(
      `[.scratch 归档] 拒绝：目录 ${name} 仍被在飞方案流持有 ` +
        `(token=${holder.token} lifecycle=${holder.lifecycle}, 引用 ${holder.path})。` +
        '请先在状态机侧收口该方案（归档/终止），再归档目录。',
    );
  }

  const result = archiveScratchFeature(target);
  if (result.archived) {
    const message = `[.scratch 归档] 已软移送: ${result.sourceDir} -> ${result.targetDir}`;
    console.log(message);
    console.log(`  完全可逆：rename 回原路径即可撤回；备忘见 ${result.manifestPath}`);
    return { ok: true, message, targetDir: result.targetDir };
  }

  // 区分"本来就没有"与"移送失败"：两者的处置完全不同。
  const existed = existsSync(target);
  return fail(
    existed
      ? `[.scratch 归档] 移送失败: ${result.error ?? '目标位于受保护区域（.archive 内或 .scratch 根）'}`
      : `[.scratch 归档] 目录不存在: ${target}`,
  );
}

export interface ScratchSweepOptions {
  staleAfterDays?: number;
  dryRun?: boolean;
}

export interface ScratchSweepArchivedItem {
  name: string;
  sourceDir: string;
  targetDir: string;
  staleDays: number | null;
  fileCount: number;
  sizeBytes: number;
  manifestPath?: string;
}

export interface ScratchSweepSkippedItem {
  name: string;
  reason: string;
}

export interface ScratchSweepResult {
  ok: boolean;
  root: string;
  scannedAt: string;
  staleAfterDays: number;
  totalScanned: number;
  candidateCount: number;
  archivedCount: number;
  skippedCount: number;
  freedBytes: number;
  freedFiles: number;
  archived: ScratchSweepArchivedItem[];
  skipped: ScratchSweepSkippedItem[];
  preserved: Array<{ name: string; staleDays: number | null; classification: string; reason: string }>;
  manifestPath?: string;
  message: string;
}

/**
 * 自动巡检与批量软归档 .scratch 下停滞临时目录（≥7 天无改动且无在飞引用）
 *
 * 契约规则：
 * 1. 扫描 .scratch 下全部目录，自动识别停滞资产（默认 >= 7 天无改动）与空目录；
 * 2. 强保护边界：被在飞方案流持有的目录必须坚决跳过并留痕，绝不误伤研发中特性；
 * 3. 软移送：原子重命名至 .scratch/.archive/<date>_<name>/，完全可逆；
 * 4. 封存清单：在归档根目录统一维护/更新 SWEEP_MANIFEST.md，且各目录包含自身的 ARCHIVE_MANIFEST.md；
 * 5. 纯净测试支持：支持自定义 root 与 flowFile，支持 dryRun，杜绝单测对实际工作区的副作用。
 */
export function runScratchSweep(
  root = SCRATCH_ROOT,
  flowFile = SPEC_FLOW_FILE,
  options?: ScratchSweepOptions,
): ScratchSweepResult {
  const staleAfterDays = options?.staleAfterDays ?? SCRATCH_STALE_DAYS;
  const holdingRefs = collectHoldingReferences(flowFile);
  const survey = probeScratchOrphans({
    root,
    referencedPaths: holdingRefs.map((ref) => ref.path),
    staleAfterDays,
  });

  if (!survey.rootExists) {
    const msg = `[.scratch 巡检] 根目录不存在: ${survey.root}`;
    console.warn(msg);
    return {
      ok: true,
      root: survey.root,
      scannedAt: survey.scannedAt,
      staleAfterDays,
      totalScanned: 0,
      candidateCount: 0,
      archivedCount: 0,
      skippedCount: 0,
      freedBytes: 0,
      freedFiles: 0,
      archived: [],
      skipped: [],
      preserved: [],
      message: msg,
    };
  }

  const candidates = survey.dirs.filter((dir) => dir.suggested === 'archive');
  const preserved = survey.dirs
    .filter((dir) => dir.suggested !== 'archive')
    .map((dir) => ({
      name: dir.name,
      staleDays: dir.staleDays,
      classification: dir.classification,
      reason: dir.reason,
    }));

  if (candidates.length === 0) {
    const msg = `[.scratch 巡检] 扫描完成: 无停滞目录（在管 ${survey.dirs.length} 个目录均在租期内或有活跃引用）。`;
    console.log(msg);
    return {
      ok: true,
      root: survey.root,
      scannedAt: survey.scannedAt,
      staleAfterDays,
      totalScanned: survey.dirs.length,
      candidateCount: 0,
      archivedCount: 0,
      skippedCount: 0,
      freedBytes: 0,
      freedFiles: 0,
      archived: [],
      skipped: [],
      preserved,
      message: msg,
    };
  }

  const archived: ScratchSweepArchivedItem[] = [];
  const skipped: ScratchSweepSkippedItem[] = [];
  let freedBytes = 0;
  let freedFiles = 0;

  for (const candidate of candidates) {
    // 双重守卫：确保探针标记的候选未被活跃流引用
    const holder = holdingRefs.find((ref) => pathHoldsFeature(ref.path, candidate.name));
    if (holder) {
      skipped.push({
        name: candidate.name,
        reason: `仍被在飞方案流持有 (token=${holder.token} lifecycle=${holder.lifecycle})`,
      });
      continue;
    }

    if (options?.dryRun) {
      archived.push({
        name: candidate.name,
        sourceDir: candidate.path,
        targetDir: join(resolve(root), ARCHIVE_DIR_NAME, `[dryRun]_${candidate.name}`),
        staleDays: candidate.staleDays,
        fileCount: candidate.fileCount,
        sizeBytes: candidate.sizeBytes,
      });
      freedBytes += candidate.sizeBytes;
      freedFiles += candidate.fileCount;
      continue;
    }

    const outcome = archiveScratchFeature(candidate.path);
    if (outcome.archived && outcome.targetDir) {
      archived.push({
        name: candidate.name,
        sourceDir: outcome.sourceDir,
        targetDir: outcome.targetDir,
        staleDays: candidate.staleDays,
        fileCount: candidate.fileCount,
        sizeBytes: candidate.sizeBytes,
        manifestPath: outcome.manifestPath,
      });
      freedBytes += candidate.sizeBytes;
      freedFiles += candidate.fileCount;
    } else {
      skipped.push({
        name: candidate.name,
        reason: outcome.error ?? '软归档移送失败',
      });
    }
  }

  let manifestPath: string | undefined;
  if (archived.length > 0 && !options?.dryRun) {
    const archiveRoot = join(resolve(root), ARCHIVE_DIR_NAME);
    if (!existsSync(archiveRoot)) {
      mkdirSync(archiveRoot, { recursive: true });
    }
    manifestPath = join(archiveRoot, 'SWEEP_MANIFEST.md');

    const sweepBatchContent = [
      `## 巡检批次: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
      `- 巡检根目录: \`${survey.root}\``,
      `- 停滞判定租期: ≥ ${staleAfterDays} 天`,
      `- 扫描目录数: ${survey.dirs.length}，待归档候选: ${candidates.length}`,
      `- 成功封存: ${archived.length} 个，释放工作区: ${formatBytes(freedBytes)}（${freedFiles} 文件）`,
      `- 活跃保留: ${preserved.length} 个`,
      ...(skipped.length > 0 ? [`- 跳过目录: ${skipped.length} 个`] : []),
      '',
      '### 本次封存目录清单',
      ...archived.map(
        (item) =>
          `- **${item.name}** (${item.fileCount} 文件 / ${formatBytes(item.sizeBytes)} / ${item.staleDays ?? '-'} 天无改动)\n` +
          `  - 原始路径: \`${item.sourceDir}\`\n` +
          `  - 封存路径: \`${item.targetDir}\`\n` +
          `  - 归档备忘: \`${item.manifestPath ?? '-'}\``,
      ),
      '',
      ...(skipped.length > 0
        ? [
            '### 跳过目录清单',
            ...skipped.map((s) => `- **${s.name}**: ${s.reason}`),
            '',
          ]
        : []),
      '### 活跃保留目录',
      ...preserved.map((p) => `- \`${p.name}\` (${p.staleDays ?? '-'} 天无改动 · ${p.classification} · ${p.reason})`),
      '',
      '---',
      '',
    ].join('\n');

    const header =
      '# 工作区清理巡检封存清单（Workspace Sweep Manifest）\n\n> 本清单由自动清理巡检生成。软移送（rename）完全可逆：如需撤销封存，可将目录从归档路径重命名回原路径。\n\n';
    let fullManifest = '';
    if (existsSync(manifestPath)) {
      try {
        const existing = readFileSync(manifestPath, 'utf8');
        const batchMarker = '## 巡检批次:';
        const firstBatchIndex = existing.indexOf(batchMarker);
        const body = firstBatchIndex !== -1 ? existing.slice(firstBatchIndex) : existing;
        fullManifest = `${header}${sweepBatchContent}${body}`;
      } catch {
        fullManifest = `${header}${sweepBatchContent}`;
      }
    } else {
      fullManifest = `${header}${sweepBatchContent}`;
    }

    writeFileSync(manifestPath, fullManifest, 'utf8');
  }

  const ok = skipped.length === 0;
  const isDryRun = Boolean(options?.dryRun);
  const actionLabel = isDryRun ? '计划封存' : '成功封存';
  const freedLabel = isDryRun ? '预估释放' : '释放';
  const movePrefix = isDryRun ? '✓ 预演计划移送' : '✓ 已移送';
  const dryRunTag = isDryRun ? ' [预演模式]' : '';

  const message =
    `[.scratch 巡检${dryRunTag}] 扫描完成: 扫描 ${survey.dirs.length} 目录，${actionLabel} ${archived.length} 目录，` +
    `${freedLabel} ${formatBytes(freedBytes)}（${freedFiles} 文件），保留 ${preserved.length} 活跃目录` +
    (skipped.length > 0 ? `，跳过 ${skipped.length} 目录` : '') +
    (manifestPath ? `；封存清单: ${manifestPath}` : '');
  console.log(message);
  for (const item of archived) {
    console.log(`  ${movePrefix}: ${item.name} -> ${item.targetDir}`);
  }
  for (const item of skipped) {
    console.warn(`  ⚠ 跳过: ${item.name} (${item.reason})`);
  }

  return {
    ok,
    root: survey.root,
    scannedAt: survey.scannedAt,
    staleAfterDays,
    totalScanned: survey.dirs.length,
    candidateCount: candidates.length,
    archivedCount: archived.length,
    skippedCount: skipped.length,
    freedBytes,
    freedFiles,
    archived,
    skipped,
    preserved,
    manifestPath,
    message,
  };
}
