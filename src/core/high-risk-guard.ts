export interface GuardAnalysisResult {
  blocked: boolean;
  reason?: string;
  matchedPattern?: string;
}

const HIGH_RISK_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /\brm\s+.*(-[a-zA-Z0-9]*r[a-zA-Z0-9]*f|-[a-zA-Z0-9]*f[a-zA-Z0-9]*r|--recursive)\b/i,
    reason: '检测到 rm -rf / rm -r -f 物理级递归强制删除命令',
  },
  {
    pattern: /\brm\s+(-[a-zA-Z0-9]*[rf][a-zA-Z0-9]*\s+|--recursive\s+|--force\s+)/i,
    reason: '检测到 rm 物理级递归删除命令',
  },
  {
    pattern: /\brmdir\s+\/s(\s+\/q)?/i,
    reason: '检测到 Windows rmdir /s 递归删除目录命令',
  },
  {
    pattern: /\bgit\s+push\b.*(--force|-f)\b/i,
    reason: '检测到 git push --force 破坏性强推分支命令',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: '检测到 git reset --hard 破坏性回滚工作区命令',
  },
  {
    pattern: /\bgit\s+clean\s+(-[a-zA-Z0-9]*[fdx][a-zA-Z0-9]*)/i,
    reason: '检测到 git clean 破坏性硬清理未跟踪文件命令',
  },
  {
    pattern: /\b(kill\s+-9|taskkill\s+\/f)\b/i,
    reason: '检测到 kill -9 / taskkill /f 物理强杀进程命令',
  },
  {
    pattern: /\b(drop\s+(database|table)|truncate\s+table)\b/i,
    reason: '检测到破坏性数据库 DDL/清空命令 (DROP / TRUNCATE)',
  },
  {
    pattern: /\b(mkfs|dd\s+if=)\b/i,
    reason: '检测到底层文件系统格式化或磁盘覆盖高危命令',
  },
  // 注：.env / bots.json / config/*.json 的重定向写入已由下方 PROTECTED_CONFIG_WRITE_PATTERNS
  // 统一覆盖（含更完整的生产配置面与更准确的提示），此处不再保留仅覆盖 .env 的旧规则，
  // 避免两条重叠规则中较弱的一条先行命中并遮蔽更准确的提示。
];

/**
 * 受保护的生产配置识别（唯一真源）。
 *
 * 这些文件承载凭证、团队编制、工作区映射与运行时旋钮；其中 `config/bots.json` 与 `.env`
 * 均已被 .gitignore 排除，**不在版本控制的可回滚保护伞内**，一旦被无感知改动将无法回溯。
 * 因此任何写入都必须经人类审批，禁止静默变更。
 */
export function protectedConfigLabel(rawPath: string): string | undefined {
  if (!rawPath) return undefined;
  const normalized = rawPath.replace(/\\/g, '/').toLowerCase();
  const fileName = normalized.split('/').pop() || '';
  if (fileName === '.env' || fileName.startsWith('.env.')) {
    return '生产凭证配置 (.env)';
  }
  if (fileName === 'bots.json' || fileName === 'bots.example.json') {
    return '团队编制与工作区生产配置 (bots.json)';
  }
  if (/(^|\/)config\/[^/]+\.json$/.test(normalized)) {
    return 'config/ 目录下的生产配置';
  }
  return undefined;
}

/** 受保护路径的通用匹配片段（同时覆盖 .env 系列、bots.json 与 config/*.json） */
const PROTECTED_PATH_ALT = [
  String.raw`(?:[^\s'"|;&]*[\\/])?(?:\.env(?:\.[A-Za-z0-9_-]+)?|bots\.json)`,
  String.raw`[^\s'"|;&]*[\\/]config[\\/][^\s'"|;&]+\.json`,
].join('|');

/** Bash 中对受保护配置的写操作模式：重定向覆盖、变更命令、就地编辑 */
const PROTECTED_CONFIG_WRITE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: new RegExp(String.raw`(?:>>?)\s*['"]?(?:${PROTECTED_PATH_ALT})`, 'i'),
    label: '重定向写入',
  },
  {
    pattern: new RegExp(
      String.raw`\b(?:rm|mv|cp|dd|tee|truncate|shred)\b[^|;&]*?(?:${PROTECTED_PATH_ALT})`,
      'i',
    ),
    label: '变更命令',
  },
  {
    pattern: new RegExp(String.raw`\bsed\s+-i\b[^|;&]*?(?:${PROTECTED_PATH_ALT})`, 'i'),
    label: '就地编辑',
  },
];

/** 只读并发模式下禁止的写命令族与重定向 */
const READONLY_WRITE_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: />(?!\s*\/dev\/null\b)/, reason: 'Shell 重定向写文件' },
  { pattern: /\b(rm|mv|cp|mkdir|touch|chmod|chown)\b/i, reason: '文件系统变更命令' },
  { pattern: /\bgit\s+(add|commit|checkout|reset|clean|push|pull|merge|rebase|tag)\b/i, reason: 'Git 写操作/分支变动命令' },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update)\b/i, reason: '依赖包修改命令' },
  { pattern: /\bsed\s+-i\b/i, reason: '文件就地替换修改命令' },
];

export function inspectReadonlyCommand(command: string): GuardAnalysisResult {
  for (const { pattern, reason } of READONLY_WRITE_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return {
        blocked: true,
        reason: `[只读并发防御] 当前会话持有只读共享锁，严禁在只读模式下执行写操作命令: ${reason} (命令: "${command}")。`,
        matchedPattern: pattern.source,
      };
    }
  }
  return { blocked: false };
}

export function inspectToolExecution(
  toolName: string,
  input: unknown,
  options?: { readonly?: boolean },
): GuardAnalysisResult {
  if (!input || typeof input !== 'object') {
    return { blocked: false };
  }

  const record = input as Record<string, unknown>;

  // 1. Bash 命令硬防御
  if (toolName === 'Bash') {
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (options?.readonly) {
      const readonlyCheck = inspectReadonlyCommand(command);
      if (readonlyCheck.blocked) {
        return readonlyCheck;
      }
    }
    for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
      if (pattern.test(command)) {
        return {
          blocked: true,
          reason: `[物理硬防御拦截] 拒绝未审批的破坏性 Shell 命令: ${reason} (命令: "${command}")。必须先调用 request_approval 发起审批卡，等待人工拍板放行！`,
          matchedPattern: pattern.source,
        };
      }
    }
    for (const { pattern, label } of PROTECTED_CONFIG_WRITE_PATTERNS) {
      if (pattern.test(command)) {
        return {
          blocked: true,
          reason: `[物理硬防御拦截] 检测到通过 Shell「${label}」篡改受保护的生产配置 (命令: "${command}")。此类文件不在 Git 可回滚保护伞内，禁止无感知改动，必须先调用 request_approval 获得人工审批！`,
          matchedPattern: 'PROTECTED_CONFIG_SHELL_WRITE',
        };
      }
    }
  }

  // 2. Write / Edit / NotebookEdit 硬防御：严禁未审批直接修改生产配置，只读模式严禁写工作区
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    if (options?.readonly) {
      return {
        blocked: true,
        reason: `[只读并发防御] 当前会话持有只读共享锁，严禁在只读模式下调用 ${toolName} 修改工作区文件。`,
        matchedPattern: 'READONLY_FORBIDDEN_TOOL',
      };
    }
    const rawPath =
      typeof record.file_path === 'string'
        ? record.file_path
        : typeof record.notebook_path === 'string'
          ? record.notebook_path
          : '';
    const label = protectedConfigLabel(rawPath);
    if (label) {
      return {
        blocked: true,
        reason: `[物理硬防御拦截] 拒绝直接篡改${label}: "${rawPath}"。该文件不受 Git 版本控制保护，禁止无感知改动，必须先调用 request_approval 获得用户人工审批！`,
        matchedPattern: 'PROTECTED_CONFIG_FILE',
      };
    }
  }

  return { blocked: false };
}
