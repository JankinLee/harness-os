/**
 * 执行异常上的**结构化成因**附件。
 *
 * 为什么不能只靠 message 判断成因：本仓已经因为「按文案归因」踩过坑
 * （探针把 schema 校验失败说成「技能未启用」，人按文案去查配置）。
 * 成因必须是**结构化事实**，由产生它的那一层显式标注。
 */

const OBSERVED_TOOL_CALLS = 'harnessOsObservedToolCalls';
const TERMINAL_TOOL_REJECTED = 'harnessOsTerminalToolRejected';

export interface ObservedToolCall {
  toolName: string;
  input: unknown;
}

/**
 * 把本轮**已观测到的工具调用**挂到异常上。
 *
 * 失败路径此前拿不到任何工具调用（`result` 随异常一起丢失），于是
 * 「调了终结工具又崩了」完全不可见。CLI 层在 reject 时补齐这份事实，
 * 宿主才能在失败分支跑与成功分支**同一份**判定。
 */
export function attachObservedToolCalls(
  error: Error,
  calls: readonly ObservedToolCall[],
): Error {
  if (calls.length === 0) return error;
  // 观测设施**永不抛出**：本函数在事件回调（fail）里被调用，
  // 若因异常对象不可扩展而抛出，会把一次普通的执行失败升级成宿主未捕获异常。
  try {
    (error as Error & Record<string, unknown>)[OBSERVED_TOOL_CALLS] = [...calls];
  } catch {
    // 挂不上附件只是少一份归因，不该影响失败本身的传播
  }
  return error;
}

export function readObservedToolCalls(error: unknown): ObservedToolCall[] | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as Error & Record<string, unknown>)[OBSERVED_TOOL_CALLS];
  return Array.isArray(value) ? (value as ObservedToolCall[]) : undefined;
}

/**
 * 标记「本轮之所以失败，正是因为某个终结型控制工具的调用被宿主拒绝」。
 *
 * 这类失败的原因**已经写在失败卡上**（例如「只有 CEO 助理可以调用 dispatch_task」
 * 或「产品方案提审参数校验失败: …」）。失败路径的探针据此跳过，避免同一件事
 * 被两张卡重复告警 —— 告警泛滥会把真正需要人看见的信号淹掉。
 */
export function markTerminalToolRejected(error: Error, toolName: string): Error {
  try {
    (error as Error & Record<string, unknown>)[TERMINAL_TOOL_REJECTED] = toolName;
  } catch {
    // 同上：标记失败只会让探针多发一张卡，不该影响失败本身的传播
  }
  return error;
}

export function readTerminalToolRejected(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as Error & Record<string, unknown>)[TERMINAL_TOOL_REJECTED];
  return typeof value === 'string' ? value : undefined;
}
