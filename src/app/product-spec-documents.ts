import { readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { LocalProductSpecRequest } from '../core/product-spec.js';

async function isMarkdownFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0 && filePath.endsWith('.md');
  } catch {
    return false;
  }
}

async function directoryHasMarkdown(
  dirPath: string,
  excludeFileName?: string,
): Promise<boolean> {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory()) return false;
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        (!excludeFileName || entry.name.toLowerCase() !== excludeFileName.toLowerCase()),
    );
  } catch {
    return false;
  }
}

/**
 * 自适应双模门禁断言：
 * 1. specPath 校验与智能容错；
 * 2. ticketsPath 支持单文件（如 tickets.md）或包含切片的目录（如 issues/）双模解析；
 * 3. 当传入单文件 tickets.md 但同级存在 issues/ 目录时，自适应收录 issuesPath 兼容并包，绝不粗暴中断；
 * 4. 当路径略有偏差时（如省略 .md 或指定单文件但实际为切片目录），执行自愈互补。
 */
export async function assertProductSpecDocuments(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<void> {
  const missing: string[] = [];

  // 1. 验证 specPath 并支持扩展名容错
  let resolvedSpecPath = resolve(workspaceDir, request.specPath);
  let specValid = await isMarkdownFile(resolvedSpecPath);
  if (!specValid) {
    if (!request.specPath.endsWith('.md') && (await isMarkdownFile(`${resolvedSpecPath}.md`))) {
      request.specPath = `${request.specPath}.md`;
      resolvedSpecPath = resolve(workspaceDir, request.specPath);
      specValid = true;
    }
  }
  if (!specValid) {
    try {
      const info = await stat(resolvedSpecPath);
      if (!info.isFile() || info.size === 0) {
        missing.push(`Spec: ${request.specPath}`);
      }
    } catch {
      missing.push(`Spec: ${request.specPath}`);
    }
  }

  // 2. 双模自适应解析 ticketsPath
  let resolvedTicketsPath = resolve(workspaceDir, request.ticketsPath);
  let isSingleFile = await isMarkdownFile(resolvedTicketsPath);
  let isDirectory = !isSingleFile && (await directoryHasMarkdown(resolvedTicketsPath, 'spec.md'));

  // 智能自愈互补（Self-Healing / Adaptive Fallback）
  if (!isSingleFile && !isDirectory) {
    // 场景 A：传入单文件 tickets.md，但实际只有 issues/ 切片目录
    const siblingIssues = resolve(dirname(resolvedTicketsPath), 'issues');
    if (await directoryHasMarkdown(siblingIssues)) {
      request.ticketsPath = relative(workspaceDir, siblingIssues).replace(/\\/g, '/');
      resolvedTicketsPath = siblingIssues;
      isDirectory = true;
    } else {
      // 场景 B：传入 issues 目录，但实际只有 tickets.md 单文件
      const siblingTicketsMd = resolve(dirname(resolvedTicketsPath), 'tickets.md');
      if (await isMarkdownFile(siblingTicketsMd)) {
        request.ticketsPath = relative(workspaceDir, siblingTicketsMd).replace(/\\/g, '/');
        resolvedTicketsPath = siblingTicketsMd;
        isSingleFile = true;
      } else if (await isMarkdownFile(`${resolvedTicketsPath}.md`)) {
        request.ticketsPath = `${request.ticketsPath}.md`;
        resolvedTicketsPath = resolve(workspaceDir, request.ticketsPath);
        isSingleFile = true;
      }
    }
  }

  if (!isSingleFile && !isDirectory) {
    missing.push(`Tickets: ${request.ticketsPath}`);
  } else {
    // 3. 关联同级产物：若主产物为单文件 tickets.md，探测并收录同级 issues 切片目录
    if (isSingleFile) {
      const siblingIssuesDir = resolve(dirname(resolvedTicketsPath), 'issues');
      if (await directoryHasMarkdown(siblingIssuesDir)) {
        request.issuesPath = relative(workspaceDir, siblingIssuesDir).replace(/\\/g, '/');
      }
    } else if (isDirectory) {
      // 若主产物为切片目录，探测同级是否存在汇总 tickets.md
      const siblingTicketsFile = resolve(dirname(resolvedTicketsPath), 'tickets.md');
      if (await isMarkdownFile(siblingTicketsFile)) {
        request.issuesPath = request.ticketsPath;
      } else {
        request.issuesPath = undefined;
      }
    }
  }

  if (missing.length) {
    throw new Error(
      [
        '产品方案尚未完整写入工作区，不能展示。',
        ...missing.map((item) => `- ${item}`),
      ].join('\n'),
    );
  }
}

