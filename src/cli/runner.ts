import { killCli, spawnCli } from './spawn-cli.js';
import { promptInputForPlatform } from './types.js';
import { createInterface } from 'node:readline';
import type {
  CliAdapter,
  CliEvent,
  CliExecutionEnv,
  CliRunResult,
} from './types.js';
import {
  RunawayDetector,
  type RunawayVerdict,
  type ToolInvocation,
} from '../core/runaway-detector.js';
import { inspectToolExecution } from '../core/high-risk-guard.js';
import { attachObservedToolCalls } from './failure-metadata.js';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SILENT_TIMEOUT_MS = 5 * 60 * 1000; // 300 秒（5 分钟）静默强杀，为重型单测、构建与深度思考留足安全边距

/** 剔除显式 undefined 的键：spawn 的 env 是字符串字典，undefined 会被当成字面量 "undefined" */
function dropUndefined(env: CliExecutionEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function envTimeoutMs(adapter: CliAdapter): number | undefined {
  const raw =
    process.env[`${adapter.id.toUpperCase()}_TIMEOUT_MS`] ??
    process.env.CLI_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envSilentTimeoutMs(adapter: CliAdapter): number | undefined {
  const raw =
    process.env[`${adapter.id.toUpperCase()}_SILENT_TIMEOUT_MS`] ??
    process.env.CLI_SILENT_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  silentTimeoutMs?: number;
  stopToolNames?: string[];
  /** 必须携带角色身份，见 CliExecutionEnv 的说明 */
  env: CliExecutionEnv;
  onEvent?: (event: CliEvent) => void;
  /** 循环检测信号回调（warning / critical / breaker 分级上报，供摩擦沉淀与告警使用） */
  onRunaway?: (verdict: RunawayVerdict) => void;
  /** 可选注入的会话级检测器实例（跨轮次持久化） */
  detector?: RunawayDetector;
}

export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = envTimeoutMs(adapter) ?? DEFAULT_TIMEOUT_MS,
    silentTimeoutMs = envSilentTimeoutMs(adapter) ?? DEFAULT_SILENT_TIMEOUT_MS,
    stopToolNames = [],
    env,
    onEvent,
    onRunaway,
  } = options;
  // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
  const promptInput = promptInputForPlatform(process.platform);
  const useStdin = promptInput === 'stdin';
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput)
    : adapter.buildArgs(prompt, promptInput);

  return new Promise((resolve, reject) => {
    // 固定用 `['pipe','pipe','pipe']`，让 stdin 始终可写（spawnCli 返回类型按字面量收窄）。
    const child = spawnCli(adapter.command, args, {
      cwd,
      signal,
      // 合并时**剔除 undefined 值**：`{...env}` 里若带一个显式 undefined 的键
      // （例如历史行的 HARNESS_OS_OWNER_OPEN_ID 为空），Node 会把它当字符串送进子进程，
      // 于是下游读到的是 "undefined" 这个**看起来像身份的值**而不是"没有值"。
      env: { ...process.env, ...dropUndefined(env) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stdin 模式下把 prompt 写入子进程；否则 prompt 已在命令行参数里，stdin 直接收口。
    if (child.stdin) {
      if (useStdin) child.stdin.end(prompt, 'utf8');
      else child.stdin.end();
    }
    // spawn 的 signal 选项只杀直接子进程（cmd 外壳），Windows 下 claude.exe/codex.exe 会变孤儿；
    // 额外监听 abort 用 killCli 连进程树一起清。
    signal?.addEventListener('abort', () => killCli(child), { once: true });
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let observedAnswer: string | undefined;
    let observedStats: CliRunResult['stats'];
    const observedToolCalls = new Map<
      string,
      NonNullable<CliRunResult['toolCalls']>[number]
    >();
    let finalResult: CliRunResult | undefined;
    let stoppedByToolCall:
      | NonNullable<CliRunResult['toolCalls']>[number]
      | undefined;
    let resultError: Error | undefined;
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let silentTimedOut = false;
    let circuitBroken = false;

    // 检测器必须是本实例的局部状态（每次 runCli 一个），绝不能是模块级单例：
    // 进程内多会话交错写入同一窗口会让 a,b,a,b 型乒乓被对方的条目打断，直接漏检。
    const runawayDetector = options.detector ?? new RunawayDetector();
    const activeToolCalls = new Map<string, { toolName: string; input: unknown }>();
    // 以 toolUseId 关联调用起点（工具名 + 参数）与终点（成败 + 结果摘要）。
    // 只有两端都拿到才记录判定 —— 「同样的输入 + 同样的输出」才是无进展的物理证据。
    const pendingInvocations = new Map<string, ToolInvocation>();

    const reportRunaway = (verdict: RunawayVerdict): void => {
      if (verdict.level === 'none') return;
      onRunaway?.(verdict);
      if (verdict.level !== 'breaker') {
        console.warn(
          `[循环检测] ${verdict.level} p=${verdict.period} c=${verdict.cycles}: ${verdict.reason}（${verdict.signature}）`,
        );
      }
    };

    let silentTimer: NodeJS.Timeout | undefined;
    const resetSilentTimer = () => {
      if (silentTimer) clearTimeout(silentTimer);
      if (silentTimeoutMs > 0) {
        silentTimer = setTimeout(() => {
          silentTimedOut = true;
          killCli(child);
        }, silentTimeoutMs);
        silentTimer.unref?.();
      }
    };
    resetSilentTimer();

    const timer = setTimeout(() => {
      timedOut = true;
      killCli(child);
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      if (silentTimer) clearTimeout(silentTimer);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      // 失败路径同样要能回答「本轮调过哪些控制流工具」：`result` 随异常一起丢失，
      // 若不把已观测到的调用挂到异常上，「调了终结工具又崩了」在宿主侧完全不可见
      // （这与「不变式检查只写在成功分支」是同一类结构性缺陷）。
      const observed = new Map<string, { toolName: string; input: unknown }>();
      for (const [toolUseId, call] of observedToolCalls) {
        observed.set(toolUseId, { toolName: call.toolName, input: call.input });
      }
      if (stoppedByToolCall) {
        observed.set(stoppedByToolCall.toolUseId, {
          toolName: stoppedByToolCall.toolName,
          input: stoppedByToolCall.input,
        });
      }
      reject(attachObservedToolCalls(error, [...observed.values()]));
    };

    lines.on('line', (line) => {
      resetSilentTimer();
      const events = adapter.parseEvents(line);
      // 预扫本批事件：带原始参数（tool_call）的调用 id 用「工具名 + 真实参数」建指纹；
      // 其余工具在 Claude 适配器里只有 tool_start 的粗粒度 detail，用它兜底 ——
      // 否则循环检测只能看见 harness_os 自己的 MCP 工具，对 Read/Bash 的原地打转完全失明。
      const richToolIds = new Set(
        events
          .filter((event) => event.type === 'tool_call')
          .map((event) => event.toolUseId),
      );
      for (const event of events) {
        onEvent?.(event);
        if ('sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId;
        }
        if (event.type === 'error') {
          resultError = new Error(event.message);
          continue;
        }
        if (event.type === 'tool_start') {
          // 已有富信息（tool_call）的 id 不重复登记，避免同一次调用被计两次
          if (!richToolIds.has(event.toolUseId)) {
            pendingInvocations.set(event.toolUseId, {
              toolName: event.toolName,
              input: { detail: event.detail ?? event.label },
              contentDigest: event.contentDigest,
            });
          }
          continue;
        }
        if (event.type === 'tool_call') {
          observedToolCalls.set(event.toolUseId, event);
          activeToolCalls.set(event.toolUseId, {
            toolName: event.toolName,
            input: event.input,
          });
          pendingInvocations.set(event.toolUseId, {
            toolName: event.toolName,
            input: event.input,
          });

          // 高危物理防御硬拦截（内核内环）：若检测到未审批的高危破坏性命令，直接物理阻断强杀
          // 只认**本次执行**的环境变量，不读宿主 process.env：
          // 宿主进程的环境由 dotenv 从 `.env` 载入，一旦那里出现 HARNESS_OS_APPROVAL_GRANTED=true，
          // 就成了一个对所有会话、所有操作永久生效的"总开关"，整套高危硬拦截会静默失效。
          // 授权必须是"某一次执行、某一个操作"的，不能是"这台机器"的。
          const isApproved = env.HARNESS_OS_APPROVAL_GRANTED === 'true';
          if (!isApproved) {
            const isReadonly = env.HARNESS_OS_LOCK_MODE === 'read';
            const guardCheck = inspectToolExecution(event.toolName, event.input, { readonly: isReadonly });
            if (guardCheck.blocked) {
              resultError = new Error(guardCheck.reason);
              killCli(child);
              continue;
            }
          }

          if (!stoppedByToolCall && stopToolNames.includes(event.toolName)) {
            stoppedByToolCall = {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
            };
            const pending = pendingInvocations.get(event.toolUseId);
            const verdict = runawayDetector.record({
              toolName: event.toolName,
              input: event.input,
              contentDigest: pending?.contentDigest,
              failed: false,
            });
            reportRunaway(verdict);
            if (verdict.level === 'breaker' && !circuitBroken) {
              circuitBroken = true;
            }
            killCli(child);
          }
          continue;
        }
        if (event.type === 'tool_end') {
          const pending = activeToolCalls.get(event.toolUseId);
          const invocation = pendingInvocations.get(event.toolUseId);
          pendingInvocations.delete(event.toolUseId);
          if (event.failed) observedToolCalls.delete(event.toolUseId);

          // 先记录、后检测：判定不依赖「上一次调用是否成功」这类隐式顺序契约。
          // 成功同样入窗（而不是清空历史）——否则 a,b,a,b 型乒乓永远攒不满阈值。
          // 幽灵 tool_end（没有对应 tool_start/tool_call，例如子进程中途被杀）：
          // 拿不到工具名与参数，无法建指纹，只能丢弃 —— 这是**刻意**的，
          // 但必须留下痕迹，否则「一次调用整个不可见」会在排查循环问题时无声无息。
          if (!invocation) {
            console.warn(
              `[循环检测] 收到无对应调用起点的 tool_end(${event.toolUseId})，本次不参与判定`,
            );
          }
          // 无论是否参与判定都要释放：这张表此前从不清理，随一次 run 单调增长
          activeToolCalls.delete(event.toolUseId);

          if (invocation) {
            const verdict = runawayDetector.record({
              ...invocation,
              input: pending?.input ?? invocation.input,
              failed: event.failed === true,
              resultDigest:
                'resultDigest' in event
                  ? (event.resultDigest as string | undefined)
                  : undefined,
            });
            reportRunaway(verdict);
            if (verdict.level === 'breaker' && !circuitBroken) {
              circuitBroken = true;
              killCli(child);
            }
          }
          continue;
        }
        if (event.type === 'result') {
          if (event.answer) observedAnswer = event.answer;
          if (event.stats) observedStats = event.stats;
          if (!observedAnswer) continue;
          finalResult = {
            answer: observedAnswer,
            sessionId: event.sessionId ?? observedSessionId,
            ...(observedStats ? { stats: observedStats } : {}),
          };
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (silentTimedOut) {
        fail(new Error(`STEP_TIMEOUT: ${adapter.displayName} 单步执行超过 3 分钟无输出，已被静默强杀`));
        return;
      }
      if (circuitBroken) {
        fail(new Error(`RUNAWAY_CIRCUIT_BROKEN: ${adapter.displayName} 连续 3 次相同工具参数错误，触发死循环硬熔断`));
        return;
      }
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`));
        return;
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (stoppedByToolCall) {
        settled = true;
        finish();
        // **必须无条件并入 `stoppedByToolCall`**：它正是本轮被终结的那次调用。
        // 原实现只在「整批再无其它观测」时才用它兜底，而 `tool_end(failed)` 会把
        // 失败的调用从 observedToolCalls 里删掉（见上方 tool_end 分支），
        // 于是「同一批里既有普通工具、又有被 MCP 校验拒绝/被宿主 kill 的终结调用」时，
        // 那次终结调用会**整条消失**：宿主既不派发、也不报错、也不告警，
        // 而模型正文很可能写着「已派发」——静默丢弃的最恶劣形态。
        // 这与 `fail()` 的合并是同一件事的两条路径，不能只修一条。
        const allByUseId = new Map<string, { toolUseId: string; toolName: string; input: unknown }>();
        for (const call of observedToolCalls.values()) {
          allByUseId.set(call.toolUseId, {
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            input: call.input,
          });
        }
        allByUseId.set(stoppedByToolCall.toolUseId, stoppedByToolCall);
        const allToolCalls = [...allByUseId.values()];
        resolve({
          answer: observedAnswer ?? '',
          sessionId: observedSessionId,
          toolCalls: allToolCalls,
        });
        return;
      }
      if (silentTimedOut) {
        return fail(new Error(`STEP_TIMEOUT: ${adapter.displayName} 单步执行超过 3 分钟无输出，已被静默强杀`));
      }
      if (circuitBroken) {
        return fail(new Error(`RUNAWAY_CIRCUIT_BROKEN: ${adapter.displayName} 连续 3 次相同工具参数错误，触发死循环硬熔断`));
      }
      if (timedOut) {
        return fail(new Error(`${adapter.displayName} 执行超时`));
      }
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      if (resultError) return fail(resultError);
      if (code !== 0) {
        return fail(
          new Error(
            stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
          ),
        );
      }
      if (!finalResult) {
        // 韧性兜底：如果进程正常退出且已记录有效工具调用，将其降级为有效完成，防止空尾帧抛错断链
        if (observedToolCalls.size > 0) {
          finalResult = {
            answer: observedAnswer ?? '',
            sessionId: observedSessionId,
            toolCalls: [...observedToolCalls.values()].map((call) => ({
              toolUseId: call.toolUseId,
              toolName: call.toolName,
              input: call.input,
            })),
            ...(observedStats ? { stats: observedStats } : {}),
          };
          settled = true;
          finish();
          return resolve(finalResult);
        }
        return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
      }
      if (observedToolCalls.size > 0) {
        finalResult.toolCalls = [...observedToolCalls.values()].map((call) => ({
          toolUseId: call.toolUseId,
          toolName: call.toolName,
          input: call.input,
        }));
      }
      settled = true;
      finish();
      resolve(finalResult);
    });
  });
}

