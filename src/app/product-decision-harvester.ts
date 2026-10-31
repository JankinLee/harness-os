import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 从工作区 review 目录中自动提取最近一份裁决文档的决策摘要（<decision_summary> 结构段）。
 *
 * 赋予宿主写入权（M13 architectural 层根因消除）：
 * 跨轮派发/转发时，若上游未显式提供 distilledDecisionsSummary，
 * 宿主从权威裁决文档中自动派生，消灭状态机重置导致的记忆断链。
 */
export function harvestLatestDecisionSummary(workspaceDir?: string): string {
  if (!workspaceDir) return '';
  const searchDirs = [
    join(workspaceDir, '.scratch', 'review'),
    join(workspaceDir, '.scratch'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(
        (f) =>
          (f.includes('review') || f.includes('verdict') || f.includes('decision')) &&
          f.endsWith('.md'),
      );
      if (files.length === 0) continue;
      // 按文件名倒序或修改时间降序取最新一份
      files.sort().reverse();
      for (const file of files) {
        const fullPath = join(dir, file);
        const content = readFileSync(fullPath, 'utf8');
        const match = content.match(/<decision_summary>([\s\S]*?)<\/decision_summary>/i);
        if (match && match[1]?.trim()) {
          return `【裁决摘要 · 来源 ${file}】\n${match[1].trim()}`;
        }
        // 优雅降级：提取首个 H2 块
        const h2Match = content.match(/##\s+0?\.?\s*裁决([\s\S]*?)(?=##|\n---|$)/i);
        if (h2Match && h2Match[1]?.trim()) {
          return `【裁决摘要 · 来源 ${file}】\n${h2Match[1].trim().slice(0, 400)}`;
        }
      }
    } catch {
      // 容错防御：观测与派生设施永不抛出异常，失败时安全返回空字符串回退
    }
  }

  return '';
}
