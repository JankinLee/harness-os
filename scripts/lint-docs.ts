import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * docs/ 目录白名单规范检查器
 *
 * 核心目的：
 * 捍卫“瘦宿主”物理空间防线，严禁业务功能 PRD、临时讨论草案物理堆积在 docs/ 导致 Git 下水道化与 Context Rot。
 *
 * 准入白名单规则：
 * 1. SYSTEM_BLUEPRINT* (系统全局蓝图)
 * 2. SYSTEM_EVOLUTION_DIALECTICS* (系统认知溯源与演化辩证录)
 * 3. SCHEMA* (机器通用协议与规范)
 * 4. ADR-* (不可逆架构决策记录 Architecture Decision Records)
 * 5. archive/* (历史归档文件)
 */

const DOCS_DIR = join(process.cwd(), 'docs');

const ALLOWED_PATTERNS = [
  /^SYSTEM_BLUEPRINT.*\.md$/,
  /^SYSTEM_EVOLUTION_DIALECTICS.*\.md$/,
  /^SCHEMA.*\.md$/,
  /^ADR-.*\.md$/,
  /^ARCHITECTURE\.md$/,
  /^SETUP\.md$/,
  /^LESSONS\.md$/,
  /^METHODOLOGY\.md$/,
  /^ROADMAP\.md$/,
];

async function scanDirectory(dir: string, baseDir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    // archive/ 目录完全豁免，仅用于历史归档
    if (relPath.startsWith('archive/') || relPath === 'archive') {
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await scanDirectory(fullPath, baseDir);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files;
}

export async function lintDocs(): Promise<{ passed: boolean; violations: string[] }> {
  try {
    const files = await scanDirectory(DOCS_DIR, DOCS_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const isAllowed = ALLOWED_PATTERNS.some((pattern) => pattern.test(file));
      if (!isAllowed) {
        violations.push(file);
      }
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { passed: true, violations: [] };
    }
    throw error;
  }
}

// CLI 执行入口
if (process.argv[1]?.endsWith('lint-docs.ts') || process.argv[1]?.endsWith('lint-docs.js')) {
  lintDocs().then(({ passed, violations }) => {
    if (passed) {
      console.log('✅ [lint-docs] docs/ 目录纯洁度检查通过，无违规业务 PRD。');
      process.exit(0);
    } else {
      console.error('❌ [lint-docs] 发现违规文件物理堆积在 docs/ 目录中：');
      for (const v of violations) {
        console.error(`   - docs/${v}`);
      }
      console.error('\n【治理铁律】：');
      console.error('1. docs/ 仅允许存放系统全局蓝图 (SYSTEM_BLUEPRINT*)、演进辩证 (SYSTEM_EVOLUTION_DIALECTICS*)、机器协议 (SCHEMA*)、架构决策 (ADR-*) 与公开说明 (ARCHITECTURE/SETUP/LESSONS/METHODOLOGY/ROADMAP)；');
      console.error('2. 业务功能需求（PRD）必须使用飞书云文档 (lark-doc) 或隔离在 .scratch/<feature>/ 局部工作区；');
      console.error('3. 历史废弃蓝图请移步 docs/archive/。\n');
      process.exit(1);
    }
  }).catch((err) => {
    console.error('💥 [lint-docs] 检查过程发生异常:', err);
    process.exit(1);
  });
}
