import {
  ARBITRATION_VERDICT_TOOL_NAME,
  CLARIFICATION_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  ESCALATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  TECH_REVIEW_TOOL_NAME,
} from '../cli/app-tools.js';

/**
 * 终结型控制工具的**角色权限真源**（角色 ↔ 工具）。
 *
 * 为什么必须搬到 core 并被两侧共用：这张表原先只存在于 MCP 子进程，
 * 宿主侧只对 `dispatch_task` 写了一份**独立**的角色判断 —— 于是「同一件事有两个真源」，
 * 且宿主那一侧的覆盖面天然残缺。最近一次修复让「被 MCP 拒绝的调用」也会回到宿主提取点后，
 * 这个残缺立刻变成真实风险：`request_escalation` / `submit_tech_review` /
 * `submit_arbitration_verdict` 三个工具在宿主侧**没有任何角色复核**，
 * 别的角色只要调用（哪怕已被 MCP 拒绝）就会被宿主照常执行。
 *
 * 结论：权限判定只能有一份，且必须同时被「拦截方（MCP）」与「执行方（宿主）」使用。
 */
/**
 * 受限工具的**唯一一张规则表**：工具 → 允许的角色 + 拒绝话术。
 *
 * 为什么是表而不是一串 `if`：此前"哪些工具受限"这个事实是由一列 `if` 隐含表达的，
 * 于是想做"身份缺失时该不该放行"的判断时，只能二选一 ——
 * 要么继续 fail-open（身份缺失 = 特权全开），要么另写一份受限工具名单（第二真源，必然漏项）。
 * 表化之后，`ROLE_RULES.some(...)` 就是那份名单本身，判据与规则不可能漂移。
 */
interface RoleRule {
  tool: string;
  roles: readonly string[];
  deny: (botId: string) => string;
}

const ROLE_RULES: readonly RoleRule[] = [
  {
    tool: DISPATCH_TASK_TOOL_NAME,
    roles: ['ceo-assistant'],
    deny: (botId) =>
      `【RBAC 权限拦截】只有 CEO 助理 (ceo-assistant) 具备任务派发与跨角色调度权；当前角色 ${botId} 无权调用 dispatch_task。请完成本角色职责后直接向负责人交付成果。`,
  },
  {
    tool: PRODUCT_SPEC_TOOL_NAME,
    roles: ['product'],
    deny: (botId) =>
      `【RBAC 权限拦截】产品方案编制与提审 (request_spec_approval) 属于 product 专属职责；当前角色 ${botId} 无权调用。`,
  },
  {
    tool: SCHEDULE_MANAGE_TOOL_NAME,
    roles: ['ceo-assistant', 'product', 'developer'],
    deny: (botId) =>
      `【RBAC 权限拦截】定时任务统一管理仅限团队成员 (ceo-assistant, product, developer) 维护本领域任务；当前角色 ${botId} 无权调用。`,
  },
  {
    tool: CLARIFICATION_TOOL_NAME,
    roles: ['product'],
    deny: (botId) =>
      `【RBAC 权限拦截】需求澄清卡片 (request_clarification) 属于 product 专属职责；当前角色 ${botId} 无权调用。如需对需求进行澄清或规划，请调用 dispatch_task 派发给 product 角色。`,
  },
  {
    tool: ESCALATION_TOOL_NAME,
    roles: ['developer'],
    deny: (botId) =>
      `【RBAC 权限拦截】下游穿刺升级门禁 (request_escalation) 属于 developer 承接任务时的专业主权；当前角色 ${botId} 无权调用。`,
  },
  {
    tool: TECH_REVIEW_TOOL_NAME,
    roles: ['developer'],
    deny: (botId) =>
      `【RBAC 权限拦截】Phase 3 技术可行性审查裁决 (submit_tech_review) 属于 developer 独立审查职责；当前角色 ${botId} 无权调用。`,
  },
  // 仲裁归属必须唯一且可追溯：初裁只能由团队负责人下达，
  // 否则争议双方都能给自己发裁决，仲裁层会退化成又一个立场表达通道。
  {
    tool: ARBITRATION_VERDICT_TOOL_NAME,
    roles: ['ceo-assistant'],
    deny: (botId) =>
      `【RBAC 权限拦截】三层仲裁链的初步裁决 (submit_arbitration_verdict) 属于 CEO 助理的统筹裁决职责；当前角色 ${botId} 无权调用。若你认为争议超出自身授权边界，请在回传结论中明确说明，由链路交回 ceo-assistant 裁定。`,
  },
];

export function checkToolRbac(
  botId: string | undefined,
  toolName: string,
): { allowed: boolean; reason?: string } {
  const rule = ROLE_RULES.find((candidate) => candidate.tool === toolName);
  if (!rule) return { allowed: true };

  // 身份缺失时**绝不**放行受限工具。
  //
  // 此前的 `if (!botId) return { allowed: true }` 是 fail-open：只要忘了把
  // HARNESS_OS_BOT_ID 传给 CLI 子进程，这个角色就变成"特权全开"。
  // 而"忘记下发身份"在本仓**真的发生过五次**（澄清续跑 / 文档评论 / 方案修订首轮与重试 / 定时任务），
  // 每一次都静默地把角色门禁整条关掉，且没有任何告警 ——
  // 一个默认放行的安全默认值，只在没人犯错时才安全。
  // 现改为：无身份 = 无法证明你有权 → 拒绝，并把"该修哪里"写进理由。
  if (!botId) {
    return {
      allowed: false,
      reason: `【RBAC 身份缺失】当前 CLI 执行未下发角色身份（HARNESS_OS_BOT_ID），无法证明有权调用 ${toolName}，已按最小权限拒绝。这是宿主接线缺陷，请报告并修复下发点，不要重试本工具。`,
    };
  }

  if (!rule.roles.includes(botId)) {
    return { allowed: false, reason: rule.deny(botId) };
  }

  return { allowed: true };
}
