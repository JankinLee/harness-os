import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

/**
 * 特性归档备忘录生成与软移送结果
 */
export interface ScratchArchivalResult {
  archived: boolean;
  sourceDir: string;
  targetDir?: string;
  manifestPath?: string;
  error?: string;
}

/**
 * 物理软归档特性草稿目录（Soft Archival · 彻底消除 Context Rot 与空间膨胀）
 *
 * 契约规则：
 * 1. 仅当特性达成终态时调用，严禁在研发或验收期间提前调用；
 * 2. 严格校验物理隔离边界，严禁越界或操作 .scratch 根目录自身；
 * 3. 先原子移送目录，再在目标归档区生成《特性归档备忘（Archive Manifest）》，杜绝失败污染源工作区；
 * 4. 原子移送至 .scratch/.archive/<date>_<feature>/。
 *
 * 契约里**没有**"清理中间临时文件"这一条，且不应加上：本函数只做软移送。
 * 旧注释曾承诺"自动物理清理无价值的中间临时堆栈"，但没有任何代码实现它，
 * 归档结果里还带着一个恒为空的 `cleanedFiles` 字段 —— 一份写给读者看的承诺，
 * 与一条永远为空的字段，比不写更糟（人据此以为归档会顺带清垃圾）。
 */
export function archiveScratchFeature(featureDir: string): ScratchArchivalResult {
  const resolvedDir = resolve(featureDir);
  if (!existsSync(resolvedDir)) {
    return { archived: false, sourceDir: featureDir };
  }

  // 严格物理边界：检查路径层级中是否包含 .scratch，且不能是 .scratch 根目录自身或已在 .archive 目录中
  const parts = resolvedDir.split(/[\\/]/);
  const scratchIdx = parts.lastIndexOf('.scratch');
  if (scratchIdx === -1 || scratchIdx === parts.length - 1) {
    return { archived: false, sourceDir: featureDir };
  }

  const scratchBase = parts.slice(0, scratchIdx + 1).join(join('a', 'b').slice(1, -1));
  const relativeSub = relative(scratchBase, resolvedDir).replaceAll('\\', '/');
  if (relativeSub.startsWith('.archive') || relativeSub.includes('/.archive')) {
    return { archived: false, sourceDir: featureDir };
  }

  try {
    // 1. 构造归档目标目录（循环冲突防撞）
    const featureName = relativeSub.replace(/\//g, '_');
    // 用**本地**日历日，不用 toISOString 的 UTC 日：宿主的定时与人的认知都锚在 Asia/Shanghai，
    // UTC 日会让 00:00–08:00 之间归档的目录被贴上"昨天"的日期，与归档备忘里的事实自相矛盾。
    const now = new Date();
    const dateStr = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');
    let archiveDir = join(scratchBase, '.archive', `${dateStr}_${featureName}`);
    let collisionIdx = 1;
    while (existsSync(archiveDir)) {
      archiveDir = join(scratchBase, '.archive', `${dateStr}_${featureName}_${collisionIdx}`);
      collisionIdx++;
    }

    // 2. 先执行目录原子移送（若重命名失败，源目录绝不提前产生虚假已归档清单）
    mkdirSync(dirname(archiveDir), { recursive: true });
    renameSync(resolvedDir, archiveDir);

    // 3. 移送成功后，在目标归档区写入归档备忘清单
    const manifestContent = [
      `# 特性归档备忘（Archive Manifest）`,
      `- 原始工作区: \`${featureDir}\``,
      `- 归档时间: ${new Date().toISOString()}`,
      `- 归档目标路径: \`${archiveDir}\``,
      `- 状态: 终态封存（防御 Context Rot）`,
      '',
    ].filter(Boolean).join('\n');

    const manifestPath = join(archiveDir, 'ARCHIVE_MANIFEST.md');
    writeFileSync(manifestPath, manifestContent, 'utf8');

    console.log(`[生命周期] 特性目录已物理移送归档: ${featureDir} -> ${archiveDir}`);
    return {
      archived: true,
      sourceDir: featureDir,
      targetDir: archiveDir,
      manifestPath,
    };
  } catch (error) {
    console.warn(`[生命周期] 特性软归档降级失败: ${(error as Error).message}`);
    return {
      archived: false,
      sourceDir: featureDir,
      error: (error as Error).message,
    };
  }
}
