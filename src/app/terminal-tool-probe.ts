import { TERMINAL_CONTROL_TOOLS } from '../cli/app-tools.js';
import { TERMINAL_TOOL_FORMS } from './terminal-tool-submission.js';

export type UnhandledTerminalCause = 'schema' | 'skill' | 'rbac' | 'unroutable';

export interface UnhandledTerminalCall {
  toolName: string;
  cause: UnhandledTerminalCause;
  /** 人类可读的成因（直接进告警卡文案） */
  detail: string;
}

export interface DetectUnhandledOptions {
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined;
  /** 本轮**已被状态机承接**的终结工具 —— 与「处理分支是否已 return」无关 */
  handledToolNames: readonly string[];
  /** 因当前角色/技能配置而**根本没有处理流**的工具 */
  skillGatedToolNames: readonly string[];
  /** 被**权限真源**拒绝（角色越权）的工具 —— 与 MCP 侧共用同一份判定 */
  rbacDeniedToolNames?: readonly string[];
}

/**
 * 「终结型控制工具调用未被任何处理流承接」的**唯一判定**。
 *
 * 成功路径与失败路径共用本函数：两条路径各写一份判定，迟早演化成两套归因标准，
 * 而「不变式检查只写在成功分支」正是本仓已记录在案的形态。
 *
 * 归因三分（此前的实现在这一点上是错的 —— 两条成因共用一张卡、同一套文案，
 * 人按文案去查技能配置，而真相可能只是 zod 报了一行 path 错误）：
 * · `skill`      —— 该工具在当前角色/技能配置下没有处理流（查配置才是对的）
 * · `schema`     —— 调了，但入参没通过 schema 校验（应把错误回传给模型修正）
 * · `unroutable` —— 入参合规，但当前上下文没有可承接它的处理流
 */
export function detectUnhandledTerminalCall(
  options: DetectUnhandledOptions,
): UnhandledTerminalCall | undefined {
  const calls = options.toolCalls ?? [];
  // 归一化 MCP 前缀（`mcp__harness_os__relay_to_peer` → `relay_to_peer`）：
  // 适配器正常情况下已经归一，但探针是**最后一层兜底**，不能假设上游一定干净。
  const normalized = calls.map((call) => ({
    toolName: canonicalTerminalToolName(call.toolName) ?? call.toolName,
    input: call.input,
  }));

  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const canonical = canonicalTerminalToolName(calls[index]?.toolName ?? '');
    if (!canonical) continue;
    if (options.handledToolNames.includes(canonical)) continue;

    if (options.rbacDeniedToolNames?.includes(canonical)) {
      return {
        toolName: canonical,
        cause: 'rbac',
        detail: `调用了控制流工具【${canonical}】，但该工具不属于当前角色的职权（权限真源已拒绝，MCP 侧同样会拦截）。该调用未被执行——请按三权分立改由具备该职权的成员执行。`,
      };
    }

    if (options.skillGatedToolNames.includes(canonical)) {
      return {
        toolName: canonical,
        cause: 'skill',
        detail: `调用了控制流工具【${canonical}】，但当前角色或宿主配置未启用对应的处理流。若确需发起澄清或方案编制，请检查三权分立职责与技能配置。`,
      };
    }

    const inspection = TERMINAL_TOOL_FORMS.find(
      (form) => form.toolName === canonical,
    )?.inspect(normalized);

    if (inspection?.hasCall && !inspection.request) {
      return {
        toolName: canonical,
        cause: 'schema',
        detail: `调用了控制流工具【${canonical}】，但入参未通过校验（${inspection.lastError ?? '未通过 schema 校验'}）。该调用**没有生效**：未生成卡片、未发生派发、未留下裁决。`,
      };
    }

    return {
      toolName: canonical,
      cause: 'unroutable',
      detail: `调用了控制流工具【${canonical}】，入参合规，但当前上下文没有可承接它的处理流。请检查该工具是否属于本角色职责、以及所需的编号是否仍然有效。`,
    };
  }

  return undefined;
}

/**
 * 「因角色/技能配置而没有处理流」的工具清单 —— **唯一构造点**。
 *
 * 成功路径与失败路径共用它：两处各写一份 `!skills.includes(...)` 表达式，
 * 迟早出现「一处算上澄清、一处算上方案」的错位，而错位的那一侧会静默把
 * schema 失败误报成「技能未启用」，正是本次要修掉的归因误导。
 */
export function skillGatedTerminalTools(options: {
  grillMeEnabled: boolean;
  managesProductSpec: boolean;
}): string[] {
  return [
    !options.grillMeEnabled && 'request_clarification',
    !options.managesProductSpec && 'request_spec_approval',
  ].filter((name): name is string => Boolean(name));
}

/**
 * 宿主工具名归一：只接受**裸名**或本宿主的 MCP 前缀形式。
 *
 * 不能用无约束的 `endsWith`：第三方 MCP 的工具名只要以这 8 个名字结尾
 * （如 `mcp__other__request_approval`）就会被误判为终结工具，
 * 触发一张归因错误的黄卡与一次 M13 计次。前缀规则与 `appToolNameOf` 保持一致。
 */
export function canonicalTerminalToolName(rawName: string): string | undefined {
  // ⚠️ 这里**刻意**只列终结工具，不含 `schedule_manage` —— 看上去它"应该"与
  // `appToolNameOf`（`FORWARDED_APP_TOOL_NAMES` = 终结工具 + schedule_manage）同源，但补进去是个陷阱：
  //
  // `schedule_manage` **没有宿主处理器**（它在 MCP 子进程里直接 POST 本机 HTTP 接口执行完），
  // 因此它既不会出现在 `handledToolNames`（index.ts:1687）里，也永远不会在本探针眼里变成"已承接"。
  // 一旦把它纳入本集合，**每一次成功的定时任务创建/删除都会被判为「未承接」** ——
  // 于是从"完全静默"直接翻转为"每次都误报一张黄卡并计一次 M13 摩擦"，比静默更糟。
  //
  // 它真正的缺陷在别处：宿主**看不见** schedule_manage 的执行结果（成功与失败对它同样不可见），
  // 所以它的 schema 失败既无告警也无归因。修法是让 MCP 把执行结果回传宿主，
  // 而不是在探针的名单上做加减法。详见 CONSOLIDATED 风险清单。
  const names = TERMINAL_CONTROL_TOOLS as readonly string[];
  if (names.includes(rawName)) return rawName;
  const prefix = 'mcp__harness_os__';
  if (!rawName.startsWith(prefix)) return undefined;
  const bare = rawName.slice(prefix.length);
  return names.includes(bare) ? bare : undefined;
}
