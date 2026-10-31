#!/usr/bin/env node
/**
 * Claude Code PreToolUse 原生 Hook 脚本：
 * 在执行任何 Bash、Write、Edit 工具前，从 stdin 读取 tool_input。
 * 如果检测到高危未审批模式，以非零状态码 exit 1 强杀拦截！
 *
 * 注：本脚本自包含完整高危规则，零外部依赖，确保原生 node 直接运行绝不发生模块寻址崩溃。
 */

const HIGH_RISK_PATTERNS = [
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
  {
    pattern: /(?:>>|>)\s*(?:\S*\/)?\.env(\.|\b)/i,
    reason: '检测到直接重定向篡改或覆盖生产/本地 .env 凭证配置文件命令',
  },
];

function inspectExecution(toolName, input) {
  if (!input || typeof input !== 'object') {
    return { blocked: false };
  }

  // 1. Bash 命令硬拦截
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
      if (pattern.test(command)) {
        return {
          blocked: true,
          reason: `[物理硬防御拦截] 拒绝未审批的破坏性 Shell 命令: ${reason} (命令: "${command}")。必须先调用 request_approval 发起审批卡，等待人工拍板放行！`,
        };
      }
    }
  }

  // 2. Write / Edit 文件硬拦截：严禁未审批直接修改或覆盖 .env 等敏感配置文件
  if (toolName === 'Write' || toolName === 'Edit') {
    const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
    const normalized = rawPath.replace(/\\/g, '/').toLowerCase();
    const fileName = normalized.split('/').pop() || '';
    if (fileName === '.env' || fileName.startsWith('.env.')) {
      return {
        blocked: true,
        reason: `[物理硬防御拦截] 拒绝直接篡改生产/本地关键凭证配置文件: "${rawPath}"。必须先调用 request_approval 获得用户人工审批！`,
      };
    }
  }

  return { blocked: false };
}

async function main() {
  try {
    let inputJson = '';
    for await (const chunk of process.stdin) {
      inputJson += chunk;
    }

    if (!inputJson.trim()) {
      process.exit(0);
    }

    const payload = JSON.parse(inputJson);
    const toolName = payload.tool || payload.tool_name || payload.name;
    const toolInput = payload.tool_input || payload.input || payload.parameters || {};

    if (!toolName) {
      process.exit(0);
    }

    // 审批放行通行证检测
    if (process.env.HARNESS_OS_APPROVAL_GRANTED === 'true') {
      process.exit(0);
    }

    const check = inspectExecution(toolName, toolInput);
    if (check.blocked) {
      console.error(check.reason);
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    // 容错兜底：非语法阻止正常退出
    process.exit(0);
  }
}

main();
