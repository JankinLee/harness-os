import { fileURLToPath } from 'node:url';

export const CLARIFICATION_TOOL_NAME = 'request_clarification';
export const PRODUCT_SPEC_TOOL_NAME = 'request_spec_approval';
export const DISPATCH_TASK_TOOL_NAME = 'dispatch_task';
export const REQUEST_APPROVAL_TOOL_NAME = 'request_approval';
export const SCHEDULE_MANAGE_TOOL_NAME = 'schedule_manage';
export const ESCALATION_TOOL_NAME = 'request_escalation';
export const TECH_REVIEW_TOOL_NAME = 'submit_tech_review';
export const RELAY_TOOL_NAME = 'relay_to_peer';
export const ARBITRATION_VERDICT_TOOL_NAME = 'submit_arbitration_verdict';

/**
 * 具备“流程终结”或“状态机流转”语义的终结型控制流工具列表。
 * 一旦 Bot 成功调用此类工具，宿主应主动截断 CLI 子进程，即刻转入对应飞书卡片与状态机，
 * 避免子进程发起冗余的尾部 LLM Turn 导致挂起或空帧断链。
 */
export const TERMINAL_CONTROL_TOOLS = [
  REQUEST_APPROVAL_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  CLARIFICATION_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  ESCALATION_TOOL_NAME,
  TECH_REVIEW_TOOL_NAME,
  RELAY_TOOL_NAME,
  ARBITRATION_VERDICT_TOOL_NAME,
] as const;

/**
 * 需要把原始入参转发给宿主的 harness_os MCP 工具集合。
 *
 * 从 `TERMINAL_CONTROL_TOOLS` **派生**，不再逐个声明 `CLAUDE_*_TOOL_NAME` 常量：
 * 那份手工常量表曾漏掉 relay_to_peer / request_escalation / submit_tech_review /
 * submit_arbitration_verdict，使它们在 Claude 引擎下永不发出 tool_call——
 * 宿主既看不到调用（静默丢弃），也不会触发「未承接」告警（该探针同样依赖 tool_call）。
 */
export const FORWARDED_APP_TOOL_NAMES: readonly string[] = [
  ...TERMINAL_CONTROL_TOOLS,
  SCHEDULE_MANAGE_TOOL_NAME,
];

/** 把引擎侧的 MCP 工具全名（`mcp__harness_os__relay_to_peer`）映射回宿主工具名 */
export function appToolNameOf(mcpToolName: string): string | undefined {
  const prefix = 'mcp__harness_os__';
  if (!mcpToolName.startsWith(prefix)) return undefined;
  const bare = mcpToolName.slice(prefix.length);
  return FORWARDED_APP_TOOL_NAMES.includes(bare) ? bare : undefined;
}

/**
 * 只读调研（recon）工单必须被禁止的**写入类工具**。
 *
 * 这是 recon 的**事前**防线：声明（`intent: 'recon'`）可被自我合理化绕过，
 * 事后 git 熔断只能报案、不能回滚。把写工具放进 stop 列表后，
 * 模型一旦请求它们，CLI 会在工具真正执行前被截断。
 *
 * 刻意**不包含** `Bash`：dev 做探查必须用 shell（git log / ls / grep），
 * 而 shell 的读写无法靠工具名区分——那一层交给「读锁 + 事后内容指纹」兜底。
 */
export const READONLY_FORBIDDEN_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
] as const;

function serverInvocation(): { command: string; args: string[] } {
  const runningFromTypeScript = import.meta.url.endsWith('.ts');
  const server = fileURLToPath(
    new URL(
      runningFromTypeScript
        ? '../mcp/app-tools-server.ts'
        : '../mcp/app-tools-server.js',
      import.meta.url,
    ),
  );
  if (!runningFromTypeScript) {
    return { command: process.execPath, args: [server] };
  }
  const tsxCli = fileURLToPath(
    new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  );
  return { command: process.execPath, args: [tsxCli, server] };
}

export function claudeAppToolArgs(): string[] {
  const invocation = serverInvocation();
  return [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        harness_os: {
          type: 'stdio',
          command: invocation.command,
          args: invocation.args,
        },
      },
    }),
  ];
}

export function codexAppToolArgs(): string[] {
  const invocation = serverInvocation();
  return [
    '-c',
    `mcp_servers.harness_os.command=${JSON.stringify(invocation.command)}`,
    '-c',
    `mcp_servers.harness_os.args=${JSON.stringify(invocation.args)}`,
  ];
}
