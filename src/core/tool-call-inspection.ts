import type { ZodType } from 'zod';

/**
 * 终结型控制工具调用的**统一**检验结果。
 *
 * `find*` 只回答「拿到了什么」；本结构额外回答两个下游必须区分的问题：
 * · `hasCall` —— 模型**是否调用过**（哪怕入参不合法）。
 *   「没调」与「调错了」是两种完全不同的处置：前者是模型没做，后者是宿主没接住。
 * · `lastError` —— 最近一次调用的 schema 校验失败原因，用于**回传给模型自我修正**
 *   （此前仅 `request_spec_approval` 一条路径具备该能力，其余 7 个终结工具只有
 *   `find*`，于是模型收不到纠正提示、人只看到一张归因错位的告警卡）。
 */
export interface ToolCallInspection<T> {
  request?: T;
  hasCall: boolean;
  lastError?: string;
}

/** 只依赖 `issues[].path/message` 的**结构最小面**，不绑定具体 zod 版本形态 */
export interface ParseFailureLike {
  issues: ReadonlyArray<{
    path?: ReadonlyArray<PropertyKey>;
    message: string;
  }>;
}

export type SafeParseLike<T> =
  | { success: true; data: T }
  | { success: false; error: ParseFailureLike };

/**
 * 从后往前查找某个终结型工具的调用并校验入参。
 *
 * 语义（与既有 `inspectProductSpecRequest` 完全一致，此处收敛为唯一实现）：
 * · 命中**任一**成功解析的调用即返回（优先最近的）；
 * · 全部失败时置 `hasCall` 并记录**最近一次**失败原因 —— 修正提示要指出上次错在哪，
 *   而不是最早那次（旧实现逐条覆写，留下的是最早一条）。
 *
 * 为什么必须是唯一实现：本仓已有「手工枚举的同类清单必然随工具增加而静默失效」的
 * 前车之鉴（两处适配器白名单漏项）。8 个终结工具若各写一遍解析循环，
 * 迟早漂移出 8 套标准。
 */
export function inspectToolCall<T>(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
  toolName: string,
  schema: ZodType<T>,
): ToolCallInspection<T> {
  let hasCall = false;
  let lastError: string | undefined;

  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== toolName) continue;
    hasCall = true;
    const parsed = schema.safeParse(call.input) as SafeParseLike<T>;
    if (parsed.success) return { request: parsed.data, hasCall: true };
    if (lastError === undefined) {
      lastError = formatParseError(parsed.error, call.input);
    }
  }

  return { request: undefined, lastError, hasCall };
}

/** 把一次 schema 校验失败渲染成人/模型都能读的一行，并在超长时带出实测长度与建议压缩目标 */
export function formatParseError(error: ParseFailureLike, input?: unknown): string {
  return error.issues
    .map((issue) => {
      const fieldPath = (issue.path ?? []).join('.') || 'root';
      const maxMatch = issue.message.match(/<=(\d+)/) || issue.message.match(/at most (\d+)/i);
      if (maxMatch && maxMatch[1] && input && typeof input === 'object') {
        let actualVal: unknown = input;
        for (const p of issue.path ?? []) {
          if (actualVal && typeof actualVal === 'object' && p in (actualVal as Record<string, unknown>)) {
            actualVal = (actualVal as Record<string, unknown>)[p as string];
          }
        }
        if (typeof actualVal === 'string') {
          const limit = Number(maxMatch[1]);
          const actualLen = actualVal.length;
          const diff = actualLen - limit;
          const suggest = Math.floor(limit * 0.9);
          return `${fieldPath}: 超长 (实测 ${actualLen} 字 / 上限 ${limit} 字，需压缩 ≥${diff} 字，建议 ≤${suggest} 字)`;
        }
      }
      return `${fieldPath}: ${issue.message}`;
    })
    .join('; ');
}
