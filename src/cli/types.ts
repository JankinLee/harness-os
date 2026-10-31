export type CliId = 'claude' | 'codex';

export type CliPromptInput = 'argument' | 'stdin';

/** Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。 */
export function promptInputForPlatform(
  platform: NodeJS.Platform,
): CliPromptInput {
  return platform === 'win32' ? 'stdin' : 'argument';
}

export type CliCompactPlan =
  | {
      protocol: 'claude-stream-json';
      command: string;
      args: string[];
      prompt: string;
    }
  | {
      protocol: 'codex-app-server';
      command: string;
      args: string[];
      sessionId: string;
    };

/**
 * CLI 子进程的环境变量（宿主每次执行都必须构造并下发）。
 *
 * `HARNESS_OS_BOT_ID` 是**必需**字段，这是刻意的类型级硬约束：
 * MCP 侧的门禁在身份缺失时拒绝受限工具，而"忘记下发身份"在本仓真的发生过五次
 * （澄清续跑 / 文档评论 / 方案修订首轮与重试 / 定时任务），每一次都静默把整条角色门禁关掉。
 * 做成必需字段后，新增调用点在**编译期**就漏不掉 —— 而不是靠事发后的人工审计去发现。
 */
export interface CliExecutionEnv {
  HARNESS_OS_BOT_ID: string;
  HARNESS_OS_CHAT_ID?: string;
  HARNESS_OS_OWNER_OPEN_ID?: string;
  HARNESS_OS_APPROVAL_GRANTED?: string;
  HARNESS_OS_APPROVED_OPERATION?: string;
  [key: string]: string | undefined;
}

export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export interface CliSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool_start';
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
      /** 物理载荷哈希签名（取前 16 位），用于精准判断连续相同调用而与人读展示 detail 解耦 */
      contentDigest?: string;
    }
  | {
      type: 'tool_end';
      toolUseId: string;
      failed: boolean;
      /**
       * 结果的**有界原始摘要**（未经归一化）。
       * 循环检测需要「同样的输入 + 同样的输出」才能判定无进展——
       * 只看输入会把合法的幂等读取误判为死循环。归一化在检测器内统一完成。
       */
      resultDigest?: string;
    }
  | { type: 'context'; usedTokens: number }
  | {
      type: 'tool_call';
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | { type: 'result'; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: 'error'; message: string; sessionId?: string };

export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string, promptInput: CliPromptInput): string[];
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[];
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan;
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
  toolCalls?: Array<{
    toolUseId: string;
    toolName: string;
    input: unknown;
  }>;
}
