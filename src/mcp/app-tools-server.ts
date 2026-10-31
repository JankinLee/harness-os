import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClarificationRequestSchema } from '../core/clarification.js';
import { ProductSpecRequestSchema } from '../core/product-spec.js';
import {
  ArbitrationVerdictSchema,
  DispatchTaskRequestSchema,
  EscalationRequestSchema,
  RelayRequestSchema,
  SubmitTechReviewRequestSchema,
} from '../core/collaboration.js';
import { ScheduleManageRequestSchema } from '../core/schedule.js';
import { ApprovalRequestSchema } from '../core/approval.js';
import {
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  ESCALATION_TOOL_NAME,
  TECH_REVIEW_TOOL_NAME,
  RELAY_TOOL_NAME,
  ARBITRATION_VERDICT_TOOL_NAME,
} from '../cli/app-tools.js';

const server = new McpServer({
  name: 'harness-os',
  version: '1.0.0',
});

async function callScheduleManage(input: unknown): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const chatId = process.env.HARNESS_OS_CHAT_ID;
  const creatorOpenId = process.env.HARNESS_OS_OWNER_OPEN_ID;
  if (!chatId || !creatorOpenId) {
    return {
      content: [
        {
          type: 'text',
          text: '缺少 HARNESS_OS_CHAT_ID / HARNESS_OS_OWNER_OPEN_ID，MCP 子进程没有拿到当前会话上下文。',
        },
      ],
      isError: true,
    };
  }
  const port = Number(process.env.SCHEDULE_API_PORT ?? 3101);
  const token = process.env.SCHEDULE_API_TOKEN;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/schedules/manage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-api-token': token } : {}),
      },
      body: JSON.stringify({ request: input, chatId, creatorOpenId }),
    });
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `无法连接 HarnessOS 定时任务管理接口：${(error as Error).message}`,
        },
      ],
      isError: true,
    };
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { notice?: string; error?: string; issues?: unknown }
    | undefined;
  if (!response.ok) {
    const detail = payload?.issues
      ? `\n${JSON.stringify(payload.issues, null, 2)}`
      : '';
    return {
      content: [
        {
          type: 'text',
          text: `定时任务管理失败（${response.status}）：${payload?.error ?? '未知错误'}${detail}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: payload?.notice ?? '定时任务管理完成。',
      },
    ],
  };
}

/**
 * 角色权限真源已下沉到 `src/core/tool-rbac.ts`，此处只做转出。
 *
 * 原因：这张表原先只存在于 MCP 子进程，宿主侧另写了一份**独立**的角色判断，
 * 于是「同一件事两个真源」且宿主侧覆盖面残缺。宿主也需要在**执行前**复核权限
 * （被 MCP 拒绝的调用现在也会回到宿主提取点），两侧必须共用同一份判定。
 */
import { checkToolRbac } from '../core/tool-rbac.js';

export { checkToolRbac };

server.registerTool(
  CLARIFICATION_TOOL_NAME,
  {
    title: '向用户提问',
    description: [
      '当产品需求仍有会实质影响方案的歧义时，调用此工具向用户展示飞书问题卡片。',
      '一次最多提交 5 个问题，每题提供 2 到 4 个清晰选项。',
      '提交后不要自行补全用户答案，本轮回复可以简短收束。',
    ].join(''),
    inputSchema: ClarificationRequestSchema,
  },
  async ({ questions }) => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, CLARIFICATION_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `已把 ${questions.length} 个问题交给 HarnessOS，请等待用户回答。`,
        },
      ],
    };
  },
);

server.registerTool(
  PRODUCT_SPEC_TOOL_NAME,
  {
    title: '提交产品文档',
    description: [
      '产品方案已经生成后，调用此工具提交唯一的待确认产物。',
      'deliveryMode=local 时提交 specPath、ticketsPath、title 与 summary（产物必须位于 .scratch/<feature>/ 局部工作区，严禁写入 docs/ 目录），并确保文件真实存在。ticketsPath 可传切片目录（如 .scratch/<feature>/issues）或汇总说明文件（如 .scratch/<feature>/tickets.md）。',
      'deliveryMode=lark-doc 时必须提交 documentUrl（且必须使用 lark-doc 创建或更新成功结果中的 document.url；该文档必须同时包含产品说明与「实现任务（Tickets）」章节），title 与 summary 为选填。',
      '同一份方案不要同时维护本地 Markdown 和飞书云文档，避免两个来源互相覆盖。',
      '提交前必须完成需求澄清，确保这份方案已经可以确认。',
      '调用后停止工作，不要实现代码或委派团队成员。',
    ].join(''),
    inputSchema: ProductSpecRequestSchema,
  },
  async () => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, PRODUCT_SPEC_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '唯一的产品方案产物已交给 HarnessOS，等待用户查看。',
        },
      ],
    };
  },
);

server.registerTool(
  DISPATCH_TASK_TOOL_NAME,
  {
    title: '把任务交给团队成员',
    description: [
      '把任务确定性地交给一名已注册的长期团队成员。',
      '只有 CEO 助理可以在运行时调用；产品经理和开发者调用会被拒绝。',
      'targetBotId 必须是团队名单中的成员 id，不能填写自己。',
      'objective 写协作目标，instruction 写交给对方的完整要求，expectedOutput 写期望产出。',
      '调用后停止工作，等待对方完成并把结果交回。',
    ].join(''),
    inputSchema: DispatchTaskRequestSchema,
  },
  async () => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, DISPATCH_TASK_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '派发请求已交给 HarnessOS，等待协作任务送达目标成员。',
        },
      ],
    };
  },
);

server.registerTool(
  SCHEDULE_MANAGE_TOOL_NAME,
  {
    title: '管理定时任务',
    description: [
      '统一管理定时任务，action 支持：',
      'list 列出全部计划；add 创建一个；addMany 批量创建；update 编辑一个；remove 删除一个；removeMany 按 ids 批量删除；removeAll 删除全部（必须 confirm=true）；run 立即执行；pause 暂停；resume 恢复；logs 查看运行记录。',
      'targetBotId 选择团队中负责执行的成员，prompt 保留完整任务要求，rule 使用一次性、固定间隔或 Cron 规则。',
      '批量删除和删除全部属于高影响操作，先 list 确认 id 再执行。',
    ].join(''),
    inputSchema: ScheduleManageRequestSchema,
  },
  async (input) => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, SCHEDULE_MANAGE_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return callScheduleManage(input);
  },
);

server.registerTool(
  REQUEST_APPROVAL_TOOL_NAME,
  {
    title: '请求高危操作审批',
    description: [
      '执行可能影响服务可用性或数据安全的操作前调用，例如重启服务、删除文件、修改生产配置、执行数据库写操作。',
      '提交操作名称、具体详情、影响范围和回滚方式；HarnessOS 会展示审批卡，等待用户拍板。',
      '调用后停止工作，等待审批结果；审批通过后才能继续执行。',
    ].join(''),
    inputSchema: ApprovalRequestSchema,
  },
  async () => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, REQUEST_APPROVAL_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '审批请求已交给 HarnessOS，等待用户拍板。',
        },
      ],
    };
  },
);

server.registerTool(
  ESCALATION_TOOL_NAME,
  {
    title: '申请任务动态升级',
    description: [
      '当你在执行 S 级直派任务时，通过本地代码探查发现物理现实复杂度（跨模块接缝、破坏性影响、测试边界缺失）远超预期，',
      '可调用此工具行使专业主权，将任务动态升级为 M/L 级并召回 product 介入编制方案。',
      'reason 写清物理探查证据，suggestedTier 给出你判断的目标等级。',
      '调用后停止工作，等待 HarnessOS 重新编排流水线。',
    ].join(''),
    inputSchema: EscalationRequestSchema,
  },
  async () => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, ESCALATION_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '升级申请已交给 HarnessOS，等待协同总线重新编排流水线。',
        },
      ],
    };
  },
);

server.registerTool(
  RELAY_TOOL_NAME,
  {
    title: '把当前工件转交给链内同伴',
    description: [
      '在**已授权的协作链内部**，把当前工件转交给另一位团队成员继续处理（协作转发）。',
      '与 dispatch_task 的区别：dispatch_task 是「创造新任务授权」（仅 CEO 助理可用）；',
      'relay_to_peer 是「延续既有任务授权」，因此**不产生新任务、不可改写协作目标、不可更换工作区**。',
      'targetBotId 必须是团队名单中的成员，且不能填写自己。',
      'objective / 分级 / 轮次 / 工作区全部沿原链路自动继承，你只需要写清 instruction 与期望产出。',
      '若你并不处于协作链中（例如用户直接找你对话），请改用 dispatch_task 由 CEO 助理派发。',
    ].join(''),
    inputSchema: RelayRequestSchema,
  },
  async () => {
    // 注意：此处**刻意不做 ceo 独占限制**。转发的安全边界不在"谁可以转发"，
    // 而在"只能沿既有链转发"——该约束由宿主在 dispatch 时以链路字段继承强制实施。
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, RELAY_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '转发请求已交给 HarnessOS，等待协作链传递至目标成员。',
        },
      ],
    };
  },
);

server.registerTool(
  ARBITRATION_VERDICT_TOOL_NAME,
  {
    title: '提交初步仲裁裁决',
    description: [
      '三层仲裁链第一层的唯一下达门禁：当 product 与 developer 就方案或复杂度陷入僵局时，由 ceo-assistant 先行初裁。',
      'verdict=adopt_product / adopt_developer 表示在自身授权边界内（排期、粒度、取舍、方案选择）作出的裁决；',
      'verdict=abstain 表示争议超出授权边界（例如涉及技术真实性本身），**必须显式弃权**上浮人类，严禁假装决断。',
      'riskLevel 是你的自评风险等级；只有它与宿主物理探针的判定**同时**为低风险时，超时后才可能自动采纳初裁。',
      'flowToken 必须使用仲裁指令中给出的仲裁编号，不能自行编造。',
      '调用后停止工作，等待 HarnessOS 流转状态机。',
    ].join(''),
    inputSchema: ArbitrationVerdictSchema,
  },
  async () => {
    const rbac = checkToolRbac(
      process.env.HARNESS_OS_BOT_ID,
      ARBITRATION_VERDICT_TOOL_NAME,
    );
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '初步仲裁裁决已交给 HarnessOS，等待协同总线流转。',
        },
      ],
    };
  },
);

server.registerTool(
  TECH_REVIEW_TOOL_NAME,
  {
    title: '提交技术可行性审查结论',
    description: [
      'Phase 3 技术可行性对抗审查的唯一下达门禁。',
      '你完成方案穿刺（接口契约、测试接缝、物理可行性、回滚策略）后调用此工具回传裁决。',
      'verdict=approved 表示方案可行，将进入人类终审；verdict=rejected 表示存在对抗意见，将退回 product 修正。',
      'flowToken 必须使用协作指令中给出的技术审查编号，不能自行编造。',
      '调用后停止工作，等待 HarnessOS 流转状态机。',
    ].join(''),
    inputSchema: SubmitTechReviewRequestSchema,
  },
  async () => {
    const rbac = checkToolRbac(process.env.HARNESS_OS_BOT_ID, TECH_REVIEW_TOOL_NAME);
    if (!rbac.allowed) {
      return {
        content: [{ type: 'text', text: rbac.reason! }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: '技术审查结论已交给 HarnessOS，等待协同总线流转。',
        },
      ],
    };
  },
);

if (process.argv[1] && (process.argv[1].includes('app-tools-server.ts') || process.argv[1].includes('app-tools-server.js'))) {
  await server.connect(new StdioServerTransport());
}
