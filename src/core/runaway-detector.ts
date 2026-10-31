import { createHash } from 'node:crypto';

export interface ToolInvocation {
  toolName: string;
  input: unknown;
  /** 物理载荷哈希签名（用于判定重复，与展示用的 input/detail 解耦） */
  contentDigest?: string;
  /**
   * 结果的归一化前摘要（失败时为错误摘要）。
   * 「同样的输入 + 同样的输出 = 没有进展」是轮询无进展判定的物理依据——
   * 只看输入会把合法的幂等读（反复读同一个文件）误判为死循环。
   */
  resultDigest?: string;
  failed?: boolean;
}

export type RunawayLevel = 'none' | 'warning' | 'critical' | 'breaker';

export interface RunawayVerdict {
  level: RunawayLevel;
  /** 检测到的周期：1 = 相同重复，2/3 = 类乒乓（a,b 或 a,a,b） */
  period: number;
  /** 该周期已重复的轮数 */
  cycles: number;
  fingerprint: string;
  /** 供人阅读与摩擦沉淀使用的签名（已归一化） */
  signature: string;
  reason?: string;
}

interface WindowEntry {
  fingerprint: string;
  signature: string;
  failed: boolean;
}

/**
 * 波动值归一化表。
 *
 * **必须在算指纹前剥离这些值**，否则「轮询无进展」永远不会触发：
 * 每次轮询的时间戳、耗时、自增 id、绝对路径都在变，
 * 未归一化时同一个「无进展的轮询」会产生两个不同指纹，看起来像有进展。
 */
const VOLATILE_PATTERNS: Array<[RegExp, string]> = [
  // ISO / 斜杠日期时间
  [/\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\d{4}[-/]\d{2}[-/]\d{2}/g, '<date>'],
  // 纯时间
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>'],
  // 耗时 / 体积 / token 数
  [
    /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|s|sec|seconds?|min|minutes?|h|hours?|B|KB|MB|GB|TB|bytes?|tokens?|it\/s)\b/gi,
    '<metric>',
  ],
  // UUID
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  // 长十六进制（各种内部 id）
  [/\b[0-9a-f]{12,64}\b/gi, '<hexid>'],
  // 绝对路径（Windows 盘符 / POSIX 多级）
  [/[A-Za-z]:\\[^\s"'`|]+/g, '<path>'],
  [/(?:^|[\s"'`(])\/(?:[^\s"'`/|]+\/)+[^\s"'`|]*/g, '<path>'],
  // 文件:行号 —— 必须**锚定在路径样式的词元之后**。
  // 曾写成裸的 `/:\d+\b/`，它会吃掉任意冒号后的数字，把 `{"port":3000}` 与
  // `{"port":8080}` 压成同一指纹 —— 那不是「无进展」，是误判。
  [/([A-Za-z0-9_@.-]+[\\/][A-Za-z0-9_@.-]*):\d+/g, '$1:<line>'],
  // 毫秒时间戳 / 自增 id（长数字，≥6 位）。
  // `\b` 在引号与数字之间同样成立，因此 `"123456"` 与 `123456` 行为一致——
  // 曾有规则只对**无引号**的数字生效，使同一逻辑值因 JSON 引号有无而判定相反。
  [/\b\d{6,}\b/g, '<num>'],
];

/**
 * 归一化的**已知边界**（诚实声明，避免被当成万无一失）：
 * - 6 位以下的裸数字不归一（`rows 1234` 与 `rows 9876` 仍不同）：把它们一并抹平
 *   会把「端口 3000 与 8080」这类真实差异误判为无进展，代价高于漏检；
 * - 数组中的元素差异（`[1,2,3]` 与 `[4,5,6]`）同理不归一。
 * 两处的取舍方向一致：**宁可漏检，不可误判**——误判会杀掉正常任务，
 * 漏检只是回到「没有循环检测」的既有水位。
 */

/** 剥离波动值，使「本质相同的调用」产生相同文本 */
export function normalizeVolatileTokens(text: string): string {
  let output = text;
  for (const [pattern, token] of VOLATILE_PATTERNS) {
    output = output.replace(pattern, token);
  }
  return output.replace(/\s+/g, ' ').trim();
}

/** 键序稳定的 JSON 序列化：`{a:1,b:2}` 与 `{b:2,a:1}` 必须得到同一指纹 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** 计算一次工具调用的确定性指纹（工具名 + 归一化参数 + 归一化结果 + 成败） */
export function fingerprintToolInvocation(invocation: ToolInvocation): string {
  const inputSignature = normalizeVolatileTokens(
    (invocation.contentDigest ?? stableStringify(invocation.input)).split('\\').join('/'),
  );
  const payload = [
    invocation.toolName,
    inputSignature,
    normalizeVolatileTokens((invocation.resultDigest ?? "").split("\\").join("/")),
    invocation.failed ? "failed" : "ok",
  ].join("");
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

/** 供人阅读的签名（与指纹同源，但不做哈希） */
export function describeToolInvocation(invocation: ToolInvocation): string {
  const args = normalizeVolatileTokens(stableStringify(invocation.input));
  const result = normalizeVolatileTokens(invocation.resultDigest ?? '');
  return [
    invocation.toolName,
    args.slice(0, 160),
    result ? `→ ${result.slice(0, 160)}` : '',
    invocation.failed ? '(失败)' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * 分级阈值。
 *
 * period=1（相同调用连续重复）比 period=2/3（类乒乓）是**更强**的信号：
 * 连续三次一模一样（含结果）几乎不可能是正常行为，因此熔断阈值保持 3，
 * 与既有的「连续 3 次相同错误即熔断」安全行为一致，不放松既有护栏。
 * 乒乓需要一个来回才构成一个完整周期，故阈值按周期数计（2/3/4）。
 */
const THRESHOLDS: Record<number, { warning: number; critical: number; breaker: number }> = {
  1: { warning: 2, critical: 3, breaker: 3 },
  2: { warning: 2, critical: 3, breaker: 4 },
  3: { warning: 2, critical: 3, breaker: 4 },
};

const DETECTABLE_PERIODS = [1, 2, 3] as const;
const LEVEL_RANK: Record<RunawayLevel, number> = {
  none: 0,
  warning: 1,
  critical: 2,
  breaker: 3,
};

/**
 * 循环检测器：归一化指纹 + 周期滑窗 + 分级响应。
 *
 * 三条硬约束（均为对旧实现的根因修正）：
 *
 * 1. **必须是实例，不能是模块单例**：进程级可变状态会让多会话交错写入同一窗口。
 * 2. **先记录、后检测**：旧实现的 `currentHash` 隐含了「必须先失败再成功」的顺序契约，
 *    调用方一旦不按该顺序调用就会静默失效。
 * 3. **成功不再清空窗口**：旧实现在任何一次成功时把历史清零，
 *    使 a,b,a,b 这类交替模式**永远无法累积到阈值**（每一次成功都把证据抹掉）。
 *    成功的正确语义是「作为一个条目参与判定」，而不是「删除历史」。
 */
export class RunawayDetector {
  private readonly window: WindowEntry[] = [];
  private readonly windowSize: number;

  constructor(options: { windowSize?: number } = {}) {
    this.windowSize = options.windowSize ?? 24;
  }

  /** 记录一次工具调用并返回本次判定（先记录、后检测） */
  record(invocation: ToolInvocation): RunawayVerdict {
    const fingerprint = fingerprintToolInvocation(invocation);
    this.window.push({
      fingerprint,
      signature: describeToolInvocation(invocation),
      failed: invocation.failed === true,
    });
    if (this.window.length > this.windowSize) {
      this.window.splice(0, this.window.length - this.windowSize);
    }
    return this.detect();
  }

  /** 评估当前窗口（不改变状态） */
  peek(): RunawayVerdict {
    return this.detect();
  }

  getWindowSize(): number {
    return this.window.length;
  }

  /** 当前窗口尾部连续相同调用的次数（兼容旧 API 语义） */
  getConsecutiveCount(): number {
    return this.countTrailingCycles(1);
  }

  getLastError(): { toolName: string; signature: string } | undefined {
    const last = this.window[this.window.length - 1];
    return last ? { toolName: last.signature.split(' ')[0] ?? '', signature: last.signature } : undefined;
  }

  /** 尾部按周期 p 构成的完整轮数（1 表示未构成重复） */
  private countTrailingCycles(period: number): number {
    const n = this.window.length;
    if (n <= period) return 1;
    let matched = 0;
    for (let index = n - period - 1; index >= 0; index -= 1) {
      if (
        this.window[index]!.fingerprint !==
        this.window[index + period]!.fingerprint
      ) {
        break;
      }
      matched += 1;
    }
    if (matched < period) return 1;
    return Math.floor(matched / period) + 1;
  }

  /** 尾部长为 `period * cycles` 的窗口内是否出现过失败 */
  private trailingCycleHasFailure(period: number, cycles: number): boolean {
    const span = period * cycles;
    const start = Math.max(0, this.window.length - span);
    for (let index = this.window.length - 1; index >= start; index -= 1) {
      if (this.window[index]!.failed) return true;
    }
    return false;
  }

  private detect(): RunawayVerdict {
    let best: RunawayVerdict = {
      level: 'none',
      period: 1,
      cycles: 0,
      fingerprint: '',
      signature: '',
    };

    for (const period of DETECTABLE_PERIODS) {
      const cycles = this.countTrailingCycles(period);
      const threshold = THRESHOLDS[period]!;
      let level: RunawayLevel = 'none';
      if (cycles >= threshold.breaker) level = 'breaker';
      else if (cycles >= threshold.critical) level = 'critical';
      else if (cycles >= threshold.warning) level = 'warning';
      if (level === 'none') continue;

      const hasFailure = this.trailingCycleHasFailure(period, cycles);
      // 纯成功重复（generic_repeat）降级为**纯提示**，永不熔断：
      // 它不携带失败事实，反复读同一个文件完全可能是合法幂等探查。
      // 只有携带失败事实的重复才允许升级为 breaker —— 那才是真正的原地打转。
      if (!hasFailure && level === 'breaker') level = 'critical';

      // 同级时优先报告更小的周期（相同重复比乒乓更值得关注）
      if (LEVEL_RANK[level] > LEVEL_RANK[best.level]) {
        const tail = this.window[this.window.length - 1];
        best = {
          level,
          period,
          cycles,
          fingerprint: tail?.fingerprint ?? '',
          signature: tail?.signature ?? '',
          reason: [
            period === 1
              ? `同一工具调用（含结果）已连续重复 ${cycles} 次`
              : `检测到周期为 ${period} 的往复模式（已重复 ${cycles} 轮）`,
            hasFailure
              ? '且期间产生过相同失败，判定为无进展死循环'
              : '但期间均无失败，按「幂等重复」降级为提示，不触发熔断',
          ].join('，'),
        };
      }
    }

    return best;
  }
}
