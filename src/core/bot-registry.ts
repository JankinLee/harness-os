import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CliId } from '../cli/types.js';
import { resolveWorkspacePath } from './workspace.js';

const ProductDeliveryModeSchema = z.enum(['local', 'lark-doc']);

export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>;

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  role: string;
  skills: string[];
  systemPrompt: string;
  workspaceDir: string;
  collaborationMaxRounds: number;
}

export const WorkspaceMetaConfigSchema = z.object({
  path: z.string().trim().min(1),
  wikiSpaceId: z.string().trim().optional(),
  prdParentNodeToken: z.string().trim().optional(),
  archivedParentNodeToken: z.string().trim().optional(),
  wikiSpaceUrl: z.string().trim().optional(),
});

export type WorkspaceMetaConfig = z.infer<typeof WorkspaceMetaConfigSchema>;

export interface HarnessOsConfig {
  teamLeaderId: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
  defaultWorkspaceDir: string;
  workspaces: Record<string, string | WorkspaceMetaConfig>;
  wikiSpaceId?: string;
  bots: BotConfig[];
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'bot id 只能使用小写字母、数字、连字符和下划线',
    ),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(['claude', 'codex']),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(''),
  collaborationMaxRounds: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .default(16),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  defaultProductDeliveryMode:
    ProductDeliveryModeSchema.optional().default('lark-doc'),
  defaultWorkspace: z.string().trim().min(1, 'defaultWorkspace 不能为空'),
  workspaces: z
    .record(
      z.string(),
      z.union([z.string().trim().min(1), WorkspaceMetaConfigSchema]),
    )
    .optional()
    .default({}),
  wikiSpaceId: z.string().trim().optional(),
  bots: z.array(BotSchema).min(1),
});

export function parseHarnessOsConfig(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): HarnessOsConfig {
  const parsed = BotConfigFileSchema.parse(input);
  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const defaultWorkspaceDir = resolveWorkspacePath(
    parsed.defaultWorkspace ?? env.CLI_WORKDIR ?? env.CLAUDE_WORKDIR ?? '.',
    baseDirectory,
  );

  const resolvedWorkspaces: Record<string, string | WorkspaceMetaConfig> = {};
  for (const [alias, ws] of Object.entries(parsed.workspaces)) {
    if (typeof ws === 'string') {
      resolvedWorkspaces[alias] = resolveWorkspacePath(ws, baseDirectory);
    } else {
      resolvedWorkspaces[alias] = {
        ...ws,
        path: resolveWorkspacePath(ws.path, baseDirectory),
      };
    }
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? '';
      const appSecret = env[bot.appSecretEnv]?.trim() ?? '';
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        collaborationMaxRounds: bot.collaborationMaxRounds,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? defaultWorkspaceDir,
          baseDirectory,
        ),
      };
    });
  if (configs.length === 0) throw new Error('至少需要启用一个 bot');
  const enabledIds = new Set(configs.map((config) => config.id));
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    defaultWorkspaceDir,
    workspaces: resolvedWorkspaces,
    wikiSpaceId: parsed.wikiSpaceId,
    bots: configs,
  };
}

export function parseBotConfigs(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): BotConfig[] {
  return parseHarnessOsConfig(input, env, baseDirectory).bots;
}

export async function loadHarnessOsConfig(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<HarnessOsConfig> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      );
    }
    throw error;
  }

  try {
    return parseHarnessOsConfig(JSON.parse(content), env, baseDirectory);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<BotConfig[]> {
  return (await loadHarnessOsConfig(filePath, env, baseDirectory)).bots;
}

/**
 * L0 元方法论公理（注入给每个 Bot 的系统提示词前缀）
 *
 * 来源：作者的多智能体系统方法论笔记（M1–M13），结合公开研究与生产实践整理。
 * 下面的正文是**压缩转述**，完整说明与参考见 `docs/METHODOLOGY.md`。
 *
 * 三条维护铁律：
 * 1. 本块是方法论的**副本**，副本会静默偏离真源 —— 因此每条都带 M 编号与关键判据，
 *    改动必须先回流到 `docs/METHODOLOGY.md`、再同步此处，禁止只改此处；
 * 2. M7 的六个承重点固定为 LB1–LB6，每项都必须有可检查的验证方法；
 * 3. M10 刻意不含"程序员角色迁移"叙述 —— 那属于方法论演进中的历史语境，不是 M10 核心。
 *    这不是遗漏，请勿"补全"。
 */
export const L0_META_AXIOMS = `【L0 核心元方法论公理 (锁定前缀 KV Cache)】
> 来源：作者的多智能体系统方法论笔记（M1–M13），结合公开研究与生产实践整理。详见 docs/METHODOLOGY.md。

- M1 四层治理架构：知识供给层 → 执行编排层 → 风险门控层 → 治理运营层，逐层单向、各有明确输入输出契约、不跨层调用。编排层只管"做什么/谁来做"（不含业务规则与权限判断）；**门控层是最不应该随自主化趋势消融的层**。
- M2 协调拓扑：超过 4 个 Agent 后拓扑不当会让准确率增益饱和甚至下滑；生产最佳实践是 Hybrid（P2P + Lead 仲裁），纯 Mesh 极少落地。
- M3 Orchestrator / Workflow / Policy 三分：Orchestrator（任务 DAG、路由、并行串行、replan）**最应该被替换**；**Workflow 是确定性控制结构（阶段转换、重试、补偿、人工审批），不应该被 LLM 替代**；Policy（权限、预算、数据域、审计）**最不应该被消融** —— 自主性逐步接管的是"如何做"，还不是"能不能做"。
- M4 单 Agent 范式：以 ReAct 为主体，可按任务混合 Plan-and-Execute / ReWOO / 异构分工 / 反思循环。
- M5 失败根因不是 Prompt：MAS 失败 44.2% 源于系统设计（角色重叠或遗漏、任务分配不当）、32.3% 协调失败、23.5% 验证缺失 ⇒ 先看架构再看 Prompt；调指令只能解决表面问题。
- M6 三阶段演化：预定义编排 → 经验驱动编排 → 自主编排，跃迁标志是"经验积累是否足以指导编排"；**即使到第三阶段，边界与验证仍是外部约束**。
- M7 六个承重点（冻结顺序 LB1→LB6，每项都必须有可检查的验证方法）：LB1 冻结架构边界（每层职责不重叠）/ LB2 冻结 authority matrix（每类语义由唯一权威对象承载，防多真值混读）/ LB3 冻结宿主归属（每类逻辑该落在哪个模块，防 adapter 膨胀）/ LB4 冻结 contract discipline（防双面接口与 optional authority、防 fallback 越权）/ LB5 管理 transition lifetime（**没被真正退役的过渡层会成为新的默认宿主**）/ LB6 构建 eval harness（行为是否在正确轨道上要成为可验证对象）。
- M8 三次根因修复（"三次"指**三个阶段**，不是复发三次）：①归属诊断（这段逻辑属于哪一层？正式宿主是谁？）→ ②权威冻结（同一语义是否被多条路径混读？）→ ③契约冻结（前端 fallback 是否因为后端契约缺位？）。顺序有严格依赖：前一阶段不解决，后一阶段的修复会被绕过。
- M9 五条实操规则（Code Review 检查清单）：①修复前先回答语义类型 / 架构层次 / 正式宿主；②新增 adapter / helper / bridge **必须附带退出计划（Retirement Plan）**；③评审顺序 belongs → authority → contract → behavior；④**Fallback 即债务**，每个都应有 issue 追踪；⑤阶段顺序：冻结归属 → 冻结 contract → 宿主落位 → 兼容层退出 → 删 fallback。
- M10 约束换自主 & 决策充分性：**约束不是限制自主，而是赋能自主** —— 约束越完善，自主决策的可信赖度越高，可自主的范围也越大（不是"用约束换权限"的二元对立）。三原则：①不做能力增强（模型能力会持续演进，针对模型的包装会迅速过时）；②只做差异辅助（只提供模型自身无法获取的物理环境与状态信息）；③在完善的硬约束边界内，让模型最大化自主推演，而非无约束地最大化。决策充分性以**依据的充分性**为唯一标尺：依据充分 → 自主决策；依据不足但可自行获取 → 先探针补足再决策；分析后仍有 ≥2 条涉及价值裁决的合理路径 → 呈现"选项 + 影响 + 推荐 + 依据"交人类确认。两种对称的失败模式：未做分析就抛给用户是**逃避**，未做分析就自行决策是**武断**。自检三问：是否分析了所有路径？是否评估了影响？依据是否可追溯？
- M11 三板斧：Reduce（压缩与摘要）/ Offload（文件系统当外部记忆、工具原子化、渐进披露）/ Isolate（**多 Agent 的主要目的是隔离上下文，不是角色分工**）。
- M12 Context Rot 防御：模型性能随 context 增长出现**不可预测的跌落**；**所有压缩都是可恢复的**（信息没有真正丢掉，只是暂时不在视野里）；Lost-in-the-middle —— 关键信息在 context 开头准确率 75%、放中间 55%；工具定义不变可复用 KV Cache。四参数：单个工具结果 ≤ 总 context 的 30%、为模型输出保留 20% 安全边距、压缩时保留最近 3 轮、超过 180K 触发摘要。
- M13 摩擦驱动演进：任何"该放哪 / 叫什么 / 用哪个规则"的停顿，都是设计未完成的信号。**同类摩擦第三次发生时，不修症状，而是重新设计承载它的结构。** 警惕 Goblin 效应（重复暴露使异常感钝化、摩擦被正常化）。摩擦分四层：operational（锚定替代暂停，事后提取为 pattern）/ design health（对照 M 编号复检"已被否定的设计是否在新入口复活"）/ architectural（有消费权而无定义权 = 宿主残缺，应归还写入权）/ experience pipeline（未编码到 BACKLOG = 摩擦未被消费）。摩擦沉淀进真理源**不得自动回写**，须经人工终审。

【harness-os 项目铁律（来源：docs/ARCHITECTURE.md，**不是 M 编号**）】
单一真理源、物理隔离、去绝对路径、三权分立、确定性门禁、瘦宿主。这六条是 harness-os 自身加固清单，与 M7 的 LB1–LB6 是两回事，严禁互相顶替。`;

export function getL1ExperienceRouter(promptText: string): string {
  const routerLines: string[] = [];
  const text = promptText.toLowerCase();

  // 1. 飞书卡片 Schema 2.0 规范与反模式
  if (text.includes('card') || text.includes('卡片') || text.includes('button') || text.includes('form') || text.includes('schema')) {
    routerLines.push('- [Feishu Card 2.0]: 输入组件统一为 `tag: "input"`（严禁使用 textarea 等非法 tag）；严格控制嵌套层级与字符限制。');
  }

  // 2. Windows 命令行与子进程转义
  if (text.includes('spawn') || text.includes('exec') || text.includes('cmd') || text.includes('windows') || text.includes('cli')) {
    routerLines.push('- [Windows Subprocess]: Windows 下 spawn 传参必须严格做双引号转义；避免直接拼接引发 DEP0190 截断。');
  }

  // 3. 破坏性操作与 PM2 重启门禁
  if (text.includes('restart') || text.includes('pm2') || text.includes('kill') || text.includes('delete') || text.includes('重启')) {
    routerLines.push('- [Approval Guard]: 外部关键服务（如 PM2 harness-os）重启/终止属于高危破坏性操作，严禁静默执行，必须触发 request_approval。');
  }

  // 4. Git Worktree 与 Merge-tree 隔离
  if (text.includes('git') || text.includes('worktree') || text.includes('merge') || text.includes('conflict') || text.includes('branch')) {
    routerLines.push('- [Git Worktree Isolation]: 隔离工作区依托 git worktree 独立运行；冲突时优先使用 merge-tree 进行三方分析并输出裁决卡片。');
  }

  if (routerLines.length === 0) return '';
  return ['【L1 场景长尾经验 JIT 动态路由 (末尾挂载)】', ...routerLines].join('\n');
}

export function buildBotPrompt(
  config: Pick<BotConfig, 'role' | 'skills' | 'systemPrompt'>,
  prompt: string,
  teamContext = '',
  defaultProductDeliveryMode: ProductDeliveryMode = 'lark-doc',
): string {
  const managesProductDocuments = config.skills.some((skill) =>
    ['to-spec', 'to-tickets', 'lark-doc'].includes(skill),
  );
  const productDeliveryPolicy = managesProductDocuments
    ? [
        '产品方案交付规则（必须遵守）：',
        `- 当前默认交付方式：${defaultProductDeliveryMode}。`,
        '- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。',
        '- 严禁在 docs/ 目录下新建业务功能说明（PRD）。docs/ 仅限存放系统蓝图、架构决策（ADR）与全局协议。',
        '- 当交付方式为 lark-doc 时：方案完全托管至飞书云文档，以 document.url 为唯一权威产物，严禁在本地维护冗余的 Markdown 副本。',
        '- 当交付方式为 local 时：产物仅允许写入当前特性的局部隔离目录（如 .scratch/<feature>/spec.md 与 issues），以 deliveryMode=local 提交。',
        '- 严禁双轨维护：不要在 Markdown 与云文档之间自动转换、同步或互相覆盖。',
        '- 不要为了选择交付格式单独发起澄清。',
        '- 方案产物完成后必须实际调用 request_spec_approval，并提交最终采用的 deliveryMode 与对应产物字段。',
        '- 不能只在普通回复中罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。工具调用成功后停止本轮。',
      ].join('\n')
    : '';
  const feishuOutputPolicy = [
    '飞书输出规则（必须遵守）：',
    '- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。',
    '- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。',
    '- 详细产物写入当前工作区文件。回复只提供简短摘要和文件路径。',
    '- 需要用户决策时，必须调用 request_clarification 工具；不要用大段文字列出问题。工具调用后停止继续推断，等待用户回答。',
  ].join('\n');
  const l1Router = getL1ExperienceRouter(prompt);
  const sections = [
    L0_META_AXIOMS,
    `你的角色：${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    productDeliveryPolicy,
    config.skills.length > 0
      ? [
          '项目 Skill 加载规则（优先级不可颠倒）：',
          '- 对配置中声明的每个 Skill，先读取当前工作区 `.agents/skills/<skill>/SKILL.md`。',
          '- 上述路径不存在时，再读取当前工作区 `.claude/skills/<skill>/SKILL.md`。',
          '- 只有两个工作区路径都不存在时，才允许回退到用户级或全局同名 Skill；不得因全局 Skill 同名而跳过工作区版本。',
          `本次任务必须执行的项目 Skill：${config.skills.map((skill) => `$${skill}`).join('、')}`,
        ].join('\n')
      : '',
    feishuOutputPolicy,
    `当前任务：${prompt}`,
    l1Router,
  ];
  return sections.filter(Boolean).join('\n\n');
}
