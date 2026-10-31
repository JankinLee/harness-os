import type { ZodType } from 'zod';
import type { CliRunResult } from '../cli/types.js';
import { ApprovalRequestSchema, inspectApprovalRequest } from '../core/approval.js';
import {
  ClarificationRequestSchema,
  inspectClarificationRequest,
} from '../core/clarification.js';
import {
  ArbitrationVerdictSchema,
  DispatchTaskRequestSchema,
  EscalationRequestSchema,
  RelayRequestSchema,
  SubmitTechReviewRequestSchema,
  inspectArbitrationVerdict,
  inspectDispatchTaskRequest,
  inspectEscalationRequest,
  inspectRelayRequest,
  inspectTechReviewSubmission,
} from '../core/collaboration.js';
import {
  ProductSpecRequestSchema,
  inspectProductSpecRequest,
} from '../core/product-spec.js';
import type { ToolCallInspection } from '../core/tool-call-inspection.js';

type ToolCalls = Array<{ toolName: string; input: unknown }> | undefined;

export interface TerminalToolForm {
  toolName: string;
  /** 反漂移测试用：`template` 必须能通过本 schema 校验，否则测试失败 */
  schema: ZodType<unknown>;
  inspect: (toolCalls: ToolCalls) => ToolCallInspection<unknown>;
  /** **只含必填字段**的最小合法入参示例（可选字段刻意不给，避免模型照抄后改写语义，如 tier） */
  template: string;
  /**
   * 是否参与「入参纠错重试」，缺省为 `true`（默认让新登记的工具获得纠错能力）。
   * 显式置 `false` 表示该工具已有更丰富的专属处置，纠错重试不得重复介入；
   * 但它仍留在清单里，供**成因归因**（探针）与反漂移测试共用同一份事实。
   */
  repairable?: boolean;
}

/**
 * 需要「入参纠错」的终结型控制工具清单。
 *
 * 为什么 `request_spec_approval` **不在此列**：它已有更丰富的专属处置
 * （`ensureProductSpecSubmission`：显式提审事实校验、入参格式纠错重试、deliveryMode 降级告警、失败即抛错），
 * 放进这里会导致同一轮被重试两次。两条路径互斥且以本文档为准。
 *
 * 清单必须与 `TERMINAL_CONTROL_TOOLS` 保持同源意识：新增终结工具时，
 * 要么在此登记（获得纠错能力），要么显式说明为何不需要 —— 漏登记会退化成
 * 「调用被静默丢弃且模型收不到纠正提示」，这正是本仓反复踩过的形态。
 */
export const TERMINAL_TOOL_FORMS: readonly TerminalToolForm[] = [
  {
    // 不参与纠错重试：`ensureProductSpecSubmission` 已实现更强的处置
    // （显式提审事实校验 + deliveryMode 降级告警 + 失败即抛错），重复介入会让同一轮重试两次。
    toolName: 'request_spec_approval',
    schema: ProductSpecRequestSchema,
    inspect: inspectProductSpecRequest,
    template: JSON.stringify(
      {
        deliveryMode: 'local',
        title: '<方案标题>',
        summary: '<方案摘要>',
        specPath: '.scratch/<feature>/spec.md',
        ticketsPath: '.scratch/<feature>/tickets.md',
      },
      null,
      2,
    ),
    repairable: false,
  },
  {
    toolName: 'request_clarification',
    schema: ClarificationRequestSchema,
    inspect: inspectClarificationRequest,
    template: JSON.stringify(
      {
        questions: [
          {
            id: 'q1',
            prompt: '把这里换成本次真正要问用户的问题，或直接删除本示例',
            options: [
              { id: 'a', label: '把这里换成选项 A' },
              { id: 'b', label: '把这里换成选项 B' },
            ],
          },
        ],
      },
      null,
      2,
    ),
  },
  {
    toolName: 'dispatch_task',
    schema: DispatchTaskRequestSchema,
    inspect: inspectDispatchTaskRequest,
    template: JSON.stringify(
      {
        targetBotId: 'product',
        objective: '<一句话协作目标>',
        instruction: '<交给对方的完整要求>',
      },
      null,
      2,
    ),
  },
  {
    toolName: 'relay_to_peer',
    schema: RelayRequestSchema,
    inspect: inspectRelayRequest,
    template: JSON.stringify(
      {
        targetBotId: 'product',
        instruction: '<交给下一位成员的要求>',
      },
      null,
      2,
    ),
  },
  {
    toolName: 'submit_tech_review',
    schema: SubmitTechReviewRequestSchema,
    inspect: inspectTechReviewSubmission,
    template: JSON.stringify(
      {
        flowToken: '<技术审查编号>',
        verdict: 'rejected',
      },
      null,
      2,
    ),
  },
  {
    toolName: 'submit_arbitration_verdict',
    schema: ArbitrationVerdictSchema,
    inspect: inspectArbitrationVerdict,
    template: JSON.stringify(
      {
        flowToken: '<仲裁编号>',
        verdict: 'abstain',
        reasoning: '<裁决理由>',
      },
      null,
      2,
    ),
  },
  {
    toolName: 'request_escalation',
    schema: EscalationRequestSchema,
    inspect: inspectEscalationRequest,
    template: JSON.stringify(
      {
        reason: '<复杂度超出预期的理由>',
        suggestedTier: 'M',
      },
      null,
      2,
    ),
  },
  {
    toolName: 'request_approval',
    schema: ApprovalRequestSchema,
    inspect: inspectApprovalRequest,
    template: JSON.stringify(
      {
        operation: '<操作名称>',
        detail: '<具体要执行什么>',
        impact: '<影响范围>',
        rollback: '<回滚方式>',
      },
      null,
      2,
    ),
  },
];

/**
 * 终结型控制工具的**参数纠错**：任一带 `hasCall` 的调用解析失败时，
 * 把 schema 错误拼进纠正提示词，让模型用正确入参重调一次。
 *
 * 为什么必须做：`find*` 返回 undefined 时，宿主此前无法区分「模型没调」与
 * 「模型调错了」——于是参数写错的下场是「既没有卡片、也没有派发，人也只看到
 * 一张让你去查技能配置的告警卡」，而真相只是 zod 报了一行 path 错误。
 * 该能力**早已存在但只给了一个工具**（`ensureProductSpecSubmission`），
 * 本模块把它推广到全族。
 *
 * 为什么重试是安全的：只在**解析失败**时触发，而解析失败意味着该调用没有
 * 产生任何副作用（卡片/派发/裁决都发生在解析成功之后）。
 */
export async function repairTerminalToolSubmissions(options: {
  result: CliRunResult;
  retry: (
    prompt: string,
    sessionId: string | undefined,
  ) => Promise<CliRunResult>;
}): Promise<CliRunResult> {
  const failures = TERMINAL_TOOL_FORMS.filter(
    (form) => form.repairable !== false,
  )
    .map((form) => ({
      form,
      inspection: form.inspect(options.result.toolCalls),
    }))
    .filter(({ inspection }) => inspection.hasCall && !inspection.request);

  if (failures.length === 0) return options.result;

  const prompt = buildCorrectionPrompt(
    failures.map(({ form, inspection }) => ({
      form,
      lastError: inspection.lastError,
    })),
  );

  let retried: CliRunResult;
  try {
    retried = await options.retry(prompt, options.result.sessionId);
  } catch (error) {
    // 纠错重试是**增强**而非前置条件：绝不因为它自己失败，就连本轮已经产出的结论一起丢掉。
    // 保留原始结果后，未被纠正的调用会照旧触发「控制流未承接」探针（带准确成因），
    // 人类因此仍然看得到真实发生的事，而不是一句无归因的失败。
    console.warn(
      `[控制流纠错] 重试失败，保留本轮原始结果: ${(error as Error).message}`,
    );
    return options.result;
  }

  // 恒等重试（recon 轮次的收口式「不重试」）无需合并，也不能合并——否则同一次调用会被记两遍。
  if (retried === options.result) return options.result;

  return {
    ...retried,
    // 正文始终以**首轮**为准：重试轮通常只回一句「已重新提交」，
    // 让它成为交付简报（devSummary）或协作指令就是失真。
    answer: options.result.answer || retried.answer,
    toolCalls: mergeToolCallLists(options.result.toolCalls, retried.toolCalls),
  };
}

/**
 * 合并「首轮」与「修正轮回」的工具调用 —— **收口实现，两处重试共用**。
 *
 * 必须并集而不是替换：同一批里可能既有失败的终结调用、又有已成功的调用，
 * 直接采用重试结果会让后者整条消失。实测「同批 relay（非法）+ request_approval（合法）」时，
 * 审批流会因替换而**彻底不被创建**（高危操作的人工门禁静默消失）。
 * 顺序上把修正轮放在末尾：查找器从后往前扫，天然优先采用修正后的值。
 */
export function mergeToolCallLists(
  original: CliRunResult['toolCalls'],
  retried: CliRunResult['toolCalls'],
): CliRunResult['toolCalls'] {
  // 去重按**对象身份**而不是按 id：唯一真实需要去重的场景是「没有重试时两侧是同一个数组」
  // （直接拼接会把每次调用记两遍）；而按 id 去重会误删跨轮里 id 恰好相同的**不同**调用
  // —— 「调用 id」是各轮独立生成的，把去重建立在它之上是把不变量寄托在生成方的随机性上。
  const seen = new Set<NonNullable<CliRunResult['toolCalls']>[number]>();
  const merged: NonNullable<CliRunResult['toolCalls']> = [];
  for (const call of [...(original ?? []), ...(retried ?? [])]) {
    if (seen.has(call)) continue;
    seen.add(call);
    merged.push(call);
  }
  return merged;
}

function buildCorrectionPrompt(
  failures: Array<{ form: TerminalToolForm; lastError?: string }>,
): string {
  const sections = failures.map(({ form, lastError }) =>
    [
      `【${form.toolName}】入参校验失败：${lastError ?? '未通过 schema 校验'}`,
      '最小合法入参示例（尖括号与示例值必须替换为真实内容）：',
      `\`\`\`json\n${form.template}\n\`\`\``,
    ].join('\n'),
  );

  return [
    '上一轮你调用了控制流工具，但入参没有通过宿主校验 —— 这些调用**并未生效**：',
    '没有生成任何卡片、没有派发任何任务、没有留下任何裁决。',
    '',
    '请针对下列每一项，用**修正后的完整入参**重新调用对应工具：',
    '',
    ...sections,
    '',
    '要求：',
    '1. 不要重做已经完成的分析、探查或文档工作，只补这一次结构化的工具调用；',
    '2. 必须**实际调用工具**，不能只在回复正文里写出参数；',
    '3. 若字段因超长校验失败，请将详细长正文写入当前工作区文件，入参字段仅保留结论摘要与文件路径，自留字符余量；',
    '4. 全部重新调用完成后，立即结束本轮。',
  ].join('\n');
}
