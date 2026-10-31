import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  inspectToolCall,
  type ToolCallInspection,
} from './tool-call-inspection.js';

/**
 * 胶囊的**承接来源**：显式声明「本链承接自哪一条已收口的上游链」。
 *
 * 为什么必须显式而不能靠凭据过滤的偶然命中：
 * 话题级 taskId + 凭据过滤只会把「同话题的另一个任务」判为**不相关**并丢弃，
 * 于是「先单独对话、再启动协作链」这类承接场景必然断链。承接是一个**业务事实**，
 * 必须由上游或宿主显式声明，不能寄望于过滤器恰好放行。
 */
export interface CapsuleLineage {
  /** 承接来源的任务标识（通常是本话题上一条已收口的链） */
  sourceTaskId: string;
  /** 来源链的已确认方案指针（若该链产出过方案） */
  approvedSpecPointer?: string;
  /** 来源链最后一次收口的时间（人类验收 / 归档 / 完成） */
  settledAt?: string;
  /**
   * 承接说明。**必须由上游显式提供**，总线不编造摘要——
   * 编造出来的"承接说明"会让下游把幻觉当事实。
   */
  note?: string;
}

export interface TargetWorkspaceMetaPrompt {
  alias?: string;
  path: string;
  wikiSpaceId?: string;
  prdParentNodeToken?: string;
  archivedParentNodeToken?: string;
  wikiSpaceUrl?: string;
}

export interface ContextCapsule {
  sourceTaskId: string;
  fromWorkspace: string;
  toWorkspace: string;
  objective: string;
  constraints: string[];
  distilledDecisionsSummary: string;
  approvedSpecPointer?: string;
  /** 承接来源（跨任务续接时显式携带，而非依赖过滤器偶然放行） */
  lineage?: CapsuleLineage;
  /** 目标工作区知识空间元数据指引 */
  targetWorkspaceMeta?: TargetWorkspaceMetaPrompt;
  timestamp: number;
}

export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  fromBotId: string;
  toBotId: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  tier?: TaskTier;
  /** 本任务链已发生的下游穿刺升级次数（有界自愈，防止无限升级乒乓） */
  escalations?: number;
  /**
   * 任务发起时的人类原始消息 id。跨协作跳转必须原样继承，
   * 严禁在各跳重新落成「本跳的入站消息 id」——否则 escalation 召回 / 通用续派产生的
   * 新投递消息会被误判为「同话题的另一个任务」，把技术审查的轮次预算静默重置。
   */
  originMessageId?: string;
  /** 链跳数（发散防护网计数，触顶熔断终止） */
  round: number;
  maxRounds: number;
  /** 辩证轮数（收敛界计数，触顶进入仲裁链）；与链跳数分离，互不消耗额度 */
  negotiationRound?: number;
  negotiationMaxRounds?: number;
  /**
   * 工单性质。`recon` = 只读调研探查（可在方案批准前直派 developer），
   * `implement` 或缺省 = 实现（M/L 级必须走完 Phase 1-4）。
   * 声明本身不可信，宿主会用 `git status` 前后指纹**物理复核**。
   */
  intent?: TaskIntent;
  workspaceDir: string;
  targetWorkspace?: string;
  capsule?: ContextCapsule;
}

/** 工单性质：调研（只读）与实现（可写）在门禁上必须区别对待 */
export type TaskIntent = 'recon' | 'implement';

/** 单个任务链允许的动态升级上限，超过则熔断转人工，杜绝无限乒乓 */
export const MAX_TASK_ESCALATIONS = 2;

/**
 * 辩证收敛界：product 与 developer 就**同一份方案**往复对抗的轮次上限。
 * 触顶后果 = **进入仲裁链**（ceo 初裁 → 人类 → 停滞休眠）。
 */
export const NEGOTIATION_MAX_ROUNDS = 3;

/**
 * 发散防护网：整条协作链的**总跳数**上限（含转发、回传、退回修正等所有跳）。
 * 触顶后果 = **熔断终止**并告知人类，**不是仲裁**。
 *
 * 必须与 `NEGOTIATION_MAX_ROUNDS` 分离为两个独立常量：
 * 二者语义正交（一个管「这件事吵了几轮」，一个管「这条链总共走了几跳」），
 * 合并成同一个字段会让 3 轮辩证界形同虚设 —— 链路任意一次转发都消耗同一份额度。
 */
export const COLLABORATION_MAX_ROUNDS = 16;

/**
 * 人类仲裁挂起窗口。超时后的处置由「ceo 明确初裁 + 探针判定低风险」双条件决定：
 * 双条件同时成立才按时限自动采纳初裁，否则进入停滞休眠等待热激活。
 */
export const ARBITRATION_SUSPEND_MS = 24 * 60 * 60 * 1000;

export interface CollaborationOrigin {
  taskId: string;
  fromBotId: string;
  reportToBotId: string;
  round: number;
  maxRounds: number;
  /** 辩证轮数（与链跳数分离，见 NEGOTIATION_MAX_ROUNDS） */
  negotiationRound?: number;
  negotiationMaxRounds?: number;
  /** 工单性质必须随溯源持久化，否则澄清/修订回填后会被当成实现类工单重新触发门禁 */
  intent?: TaskIntent;
  /** 任务分级必须随协作溯源一起持久化，否则澄清/修订回填路径会丢失 M/L 级上下文 */
  tier?: TaskTier;
  escalations?: number;
  originMessageId?: string;
}

/** 分级上下文：CollaborationMessage 与 CollaborationOrigin 均可满足 */
export interface CollaborationTierContext {
  tier?: TaskTier;
  escalations?: number;
  dispatchId?: string;
  originMessageId?: string;
  negotiationRound?: number;
  negotiationMaxRounds?: number;
  intent?: TaskIntent;
}

/** 仲裁裁决选项（ceo 初裁与人类裁决共用同一套词汇，便于叙事比对） */
export type ArbitrationVerdict = 'adopt_product' | 'adopt_developer' | 'abstain';

/**
 * 三层仲裁链状态机。
 *
 * `pending_preliminary`（等 ceo 初裁）→ `pending_human`（等人类裁决，含 ceo 弃权的情形）
 * → `resolved` | `suspended`（24h 无响应且不可自动采纳）。
 *
 * **弃权不是终态**：ceo 弃权意味着「超出我的授权边界」，争议必须上浮到人类，
 * 因此同样进入 `pending_human`，只是**永不允许自动采纳**。
 *
 * 曾经声明过一个 `expired` 状态（「任务声明 TTL 才真正取消」），但全仓无任何赋值点——
 * 一个永远进不去的状态会让状态机图与真实行为不符，也让读者误以为取消路径已经存在。
 * 按 M8（过渡层必须设定生命周期并退役），在真正实现 TTL 取消之前不保留空壳。
 */
export type ArbitrationStatus =
  | 'pending_preliminary'
  | 'pending_human'
  | 'resolved'
  | 'suspended';

export interface ArbitrationFlow {
  token: string;
  taskId: string;
  dispatchId?: string;
  fromBotId: string;
  toBotId: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  contradictionReason: string;
  /** 链跳数快照（发散防护网计数） */
  round: number;
  maxRounds: number;
  /** 辩证轮数快照（收敛界计数）；两个计数必须分别保存，不可合并 */
  negotiationRound?: number;
  negotiationMaxRounds?: number;
  ownerOpenId: string;
  ownerUnionId?: string;
  workspaceDir: string;
  originalMessageId?: string;
  cardMessageId?: string;
  replyInThread?: boolean;
  /** 分级与升级预算必须穿越人工仲裁继续传递，否则裁决后的方案提交会丢失 M/L 上下文而跳过 Phase 3 */
  tier?: TaskTier;
  escalations?: number;
  status: ArbitrationStatus;
  /**
   * 触发来源。必须在卡片上如实渲染：
   * 「辩证 N 轮触顶」与「升级次数触顶」是两种不同的僵局，
   * 若统一渲染成前者，人类会按错误的烈度判断该不该亲自介入。
   */
  trigger?: 'negotiation' | 'escalation';
  /** 第一层：ceo 初裁结论与理由 */
  preliminaryVerdict?: ArbitrationVerdict;
  preliminaryReasoning?: string;
  preliminaryAt?: string;
  /**
   * 仲裁叙事：初裁结论 + 关键分歧点的时间线。
   * **只存结论性片段，不存全量思维链**（全量 CoT 会污染下游上下文并随轮次线性膨胀）。
   */
  narrative: string[];
  /** 探针低风险判定（确定性事实），与 ceo 声明共同构成自动采纳的前置条件 */
  lowRisk?: boolean;
  riskReasons?: string[];
  /** 超时自动采纳时刻：非空即表示裁决未经人类显式确认，交付物**必须**显式标注 */
  autoAdoptedAt?: string;
  selectedOption?: string;
  customGuidance?: string;
  resolvedAt?: string;
  suspendedAt?: string;
  createdAt: number;
  updatedAt: number;
}

export class ArbitrationFlowStore {
  private readonly flows = new Map<string, ArbitrationFlow>();

  constructor(initialFlows: ArbitrationFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

  create(
    options: Omit<
      ArbitrationFlow,
      'token' | 'status' | 'narrative' | 'createdAt' | 'updatedAt'
    >,
  ): ArbitrationFlow {
    const token = randomUUID().replaceAll('-', '');
    const now = Date.now();
    const flow: ArbitrationFlow = {
      ...options,
      token,
      status: 'pending_preliminary',
      narrative: [],
      createdAt: now,
      updatedAt: now,
    };
    this.flows.set(token, flow);
    return flow;
  }

  get(token: string): ArbitrationFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 同一任务不得并发多张待决仲裁卡。
   *
   * 话题级 taskId + 多跳回传会让同一次分歧被重复建流：升级超限与辩证触顶
   * 是两条独立的触发路径，且都可能在同一条链上先后命中，
   * 重复建流会向人类推送多张互相矛盾的仲裁卡。
   * （链路跳数触顶**不在此列**——它走熔断终止，不建仲裁流。）
   */
  findOpenByTaskId(
    taskId: string,
    options: { originMessageId?: string } = {},
  ): ArbitrationFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.taskId !== taskId) continue;
      if (flow.status !== 'pending_preliminary' && flow.status !== 'pending_human')
        continue;
      if (
        options.originMessageId &&
        flow.originalMessageId &&
        flow.originalMessageId !== options.originMessageId
      ) {
        continue;
      }
      return flow;
    }
    return undefined;
  }

  /** 第一层：记录 ceo 初裁并移交第二层（人类）。弃权同样移交，但携带 abstain 标记。 */
  recordPreliminary(
    token: string,
    verdict: {
      verdict: ArbitrationVerdict;
      reasoning: string;
      lowRisk?: boolean;
      riskReasons?: string[];
    },
  ): ArbitrationFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending_preliminary') return undefined;
    flow.status = 'pending_human';
    flow.preliminaryVerdict = verdict.verdict;
    flow.preliminaryReasoning = verdict.reasoning;
    flow.preliminaryAt = new Date().toISOString();
    if (verdict.lowRisk !== undefined) flow.lowRisk = verdict.lowRisk;
    if (verdict.riskReasons) flow.riskReasons = verdict.riskReasons;
    if (verdict.verdict === 'abstain') {
      flow.narrative.push(
        `ceo 初裁：弃权（超出授权边界）——${verdict.reasoning}`,
      );
    } else {
      flow.narrative.push(
        `ceo 初裁：${verdict.verdict === 'adopt_product' ? '采纳 Product 方案' : '采纳 Developer 建议'}——${verdict.reasoning}`,
      );
    }
    flow.updatedAt = Date.now();
    this.flows.set(token, flow);
    return flow;
  }

  resolve(
    token: string,
    decision: {
      selectedOption?: string;
      customGuidance?: string;
      autoAdopted?: boolean;
    },
  ): ArbitrationFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || (flow.status !== 'pending_human' && flow.status !== 'suspended'))
      return undefined;
    const resolved: ArbitrationFlow = {
      ...flow,
      status: 'resolved',
      selectedOption: decision.selectedOption,
      customGuidance: decision.customGuidance,
      resolvedAt: new Date().toISOString(),
      autoAdoptedAt: decision.autoAdopted
        ? new Date().toISOString()
        : flow.autoAdoptedAt,
      updatedAt: Date.now(),
    };
    resolved.narrative = [
      ...flow.narrative,
      decision.autoAdopted
        ? `系统按 ceo 初裁自动采纳（人类 ${Math.round(ARBITRATION_SUSPEND_MS / 3_600_000)}h 未响应且任务经探针判定为低风险）`
        : `人类裁决：${decision.customGuidance || decision.selectedOption || '已裁决'}`,
    ];
    this.flows.set(token, resolved);
    return resolved;
  }

  /** 第三层：24h 无响应且不满足自动采纳条件 → 停滞休眠（释放资源，保留叙事） */
  suspend(token: string): ArbitrationFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending_human') return undefined;
    flow.status = 'suspended';
    flow.suspendedAt = new Date().toISOString();
    flow.narrative.push('人类裁决超时，任务转入停滞休眠（保留仲裁叙事，等待人类交互热激活）');
    flow.updatedAt = Date.now();
    this.flows.set(token, flow);
    return flow;
  }

  /**
   * 第一层超时：ceo 未在时限内初裁 → 争议直接上浮人类。
   *
   * 必须与 `recordPreliminary` 区分：本路径**不产生初裁结论**，
   * 因此在语义上等价于弃权（`preliminaryVerdict` 保持 undefined），
   * 从而在第三层超时时**永远不会**触发自动采纳。
   */
  markPreliminaryTimeout(token: string): ArbitrationFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending_preliminary') return undefined;
    flow.status = 'pending_human';
    flow.narrative.push('ceo 未在初裁时限内响应，争议直接上浮人类（无初裁建议）');
    flow.updatedAt = Date.now();
    this.flows.set(token, flow);
    return flow;
  }

  /** 热激活：人类任意交互把休眠中的仲裁唤醒回等待态 */
  wake(token: string): ArbitrationFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'suspended') return undefined;
    flow.status = 'pending_human';
    flow.suspendedAt = undefined;
    flow.narrative.push('检测到人类交互，仲裁请求已热激活并重新计时');
    flow.updatedAt = Date.now();
    this.flows.set(token, flow);
    return flow;
  }

  /**
   * 列出「等待人类操作」的仲裁流（含休眠），供热激活扫描使用。
   *
   * **不可**用于超时巡检：本方法刻意排除 `pending_preliminary`，
   * 若巡检复用它，"初裁超时上浮人类"将永远不可达（曾因此让 30 分钟初裁时限彻底失效）。
   */
  listOpen(): ArbitrationFlow[] {
    return [...this.flows.values()].filter(
      (flow) => flow.status === 'pending_human' || flow.status === 'suspended',
    );
  }

  /**
   * 列出**全部未终结**的仲裁流（含尚未初裁的 `pending_preliminary`），供超时巡检使用。
   *
   * 与 `listOpen` 的职责差异必须保持显式：巡检要覆盖每一个还在走的流，
   * 而热激活只关心人类此刻能操作的那些。把两者合并成一个方法，
   * 必然有一侧语义被悄悄牺牲——上次牺牲的就是第一层初裁的时限。
   */
  listSweepable(): ArbitrationFlow[] {
    return [...this.flows.values()].filter(
      (flow) =>
        flow.status === 'pending_preliminary' ||
        flow.status === 'pending_human' ||
        flow.status === 'suspended',
    );
  }

  /**
   * 级联清理：链路终止时回收关联仲裁，避免同话题的下个任务继承陈旧争议。
   *
   * **默认只回收「尚未上浮人类」的流**：处于 `pending_human` / `suspended` 的争议
   * 已经被推到人类面前，人类可能正在裁决——链路熔断不应把一张待裁决的卡片
   * 变成点了没反应的死按钮（那会让人类以为自己错过了什么）。
   * 需要连它们一起抹掉时（如「终止任务」），显式传 `includeHumanPending`。
   */
  deleteByTaskId(
    taskId: string,
    options: { includeHumanPending?: boolean } = {},
  ): number {
    let removed = 0;
    for (const flow of [...this.flows.values()]) {
      if (flow.taskId !== taskId) continue;
      const isHumanPending =
        flow.status === 'pending_human' || flow.status === 'suspended';
      if (isHumanPending && !options.includeHumanPending) continue;
      this.flows.delete(flow.token);
      removed += 1;
    }
    return removed;
  }

  delete(token: string): boolean {
    return this.flows.delete(token);
  }

  protected snapshot(): ArbitrationFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  protected restore(flows: ArbitrationFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}

/**
 * 仲裁发起人鉴权。
 *
 * 与 `isProductSpecOwner` / `isClarificationOwner` 同构：unionId 优先，openId 兜底
 * （unionId 跨应用稳定，openId 在同租户不同应用间会变）。
 */
export function isArbitrationOwner(
  flow: Pick<ArbitrationFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

export type ArbitrationTimeoutAction =
  | 'none'
  | 'escalate_to_human'
  | 'suspend'
  | 'auto_adopt';

/**
 * 仲裁超时处置判定（**纯函数，唯一判定点**）。
 *
 * 把「什么时候该自动采纳」从定时器回调里抽出来单独判定，使其可被单测穷举。
 * 判定与副作用分离后，"忘了判低风险就自动推进"这类错误在结构上不可能发生。
 *
 * 自动采纳的三个前置条件缺一不可：
 * 1. ceo **明确**初裁（非弃权、非初裁超时）；
 * 2. 宿主物理探针 ∧ ceo 自评**同时**判定为低风险；
 * 3. 人类静默已达完整挂起窗口。
 */
export function planArbitrationTimeout(
  flow: Pick<
    ArbitrationFlow,
    'status' | 'preliminaryVerdict' | 'lowRisk' | 'updatedAt'
  >,
  now: number,
  options: { preliminaryTtlMs: number; suspendMs: number },
): ArbitrationTimeoutAction {
  const elapsed = now - flow.updatedAt;

  if (flow.status === 'pending_preliminary') {
    return elapsed >= options.preliminaryTtlMs ? 'escalate_to_human' : 'none';
  }
  if (flow.status !== 'pending_human') return 'none';
  if (elapsed < options.suspendMs) return 'none';

  const decisivePreliminary =
    flow.preliminaryVerdict !== undefined && flow.preliminaryVerdict !== 'abstain';
  if (decisivePreliminary && flow.lowRisk === true) return 'auto_adopt';
  return 'suspend';
}

export type TaskTier = 'S' | 'M' | 'L';

const TIER_RANK: Record<TaskTier, number> = { S: 0, M: 1, L: 2 };

/**
 * 已确认方案判定（**唯一真源**）。
 *
 * 必须锚定到具体产物指针，不能只凭派发者自己写下的「方案」二字自证，
 * 否则 M/L 级门禁可被同一段 LLM 文案自签放行。
 *
 * 派发（dispatch_task）与转发（relay_to_peer）**必须共用本判定**，
 * 否则转发会成为绕过方案与人类终审、直接把 M/L 任务塞给 developer 的侧门。
 */
export function detectApprovedSpec(options: {
  objective: string;
  instruction: string;
  chainObjective?: string;
}): boolean {
  // 系统自身在人类批准后写入的链路目标，属权威标记
  if (options.chainObjective?.includes('方案已确认')) return true;
  if (options.chainObjective?.includes('方案已批准')) return true;

  const text = `${options.objective} ${options.instruction}`;
  const approvedSpecPointerRe =
    /(https?:\/\/\S*\/(?:docx|wiki)\/[A-Za-z0-9_-]+|\.scratch\/\S+|documentUrl|specPath|ticketsPath)/i;
  return (
    /(已确认|已批准|已通过|通过审批|确认通过)/.test(text) &&
    approvedSpecPointerRe.test(text)
  );
}

/**
 * 取两者中更高的分级，用于保证分级在协作链路中**单调不降**。
 * 降级通道必须彻底关闭：否则链路中已定级的 M/L 任务可被某一跳显式声明为 S 而绕过 Phase 3。
 */
export function maxTaskTier(
  a: TaskTier | undefined,
  b: TaskTier | undefined,
): TaskTier | undefined {
  if (!a) return b;
  if (!b) return a;
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export interface SeamProbeResult {
  declaredTier: TaskTier;
  calibratedTier: TaskTier;
  escalated: boolean;
  reason?: string;
  /** 探针识别出的物理产物面（声明触及的文件路径集合） */
  probedPaths: string[];
}

/**
 * 架构冻结边界规则：以「物理产物路径」为判定单元，而非自然语言形容词。
 */
const FROZEN_BOUNDARY_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\/)CLAUDE\.md$/i, label: 'CLAUDE.md 项目指令契约' },
  { pattern: /(^|\/)package\.json$/i, label: 'package.json 核心依赖清单' },
  { pattern: /(^|\/)\.env$/i, label: '.env 凭证配置' },
  { pattern: /(^|\/)docs\//i, label: 'docs/ 架构蓝图与 ADR 冻结区' },
  { pattern: /(^|\/)config\//i, label: 'config/ 团队与工作区配置' },
  { pattern: /(^|\/)(pnpm-lock\.yaml|tsconfig\.json)$/i, label: '构建与锁文件契约' },
];

/** 物理破坏性操作指令探针（与高危门禁同源的确定性模式） */
const DESTRUCTIVE_COMMAND_RE =
  /\b(rm\s+(-\w*f\w*|--force|--recursive|-\w*r\w*\s+-\w*f\w*)|git\s+reset\s+--hard|git\s+push\s+(-f|--force)|git\s+clean\s+-\w*f|pm2\s+(restart|delete|stop|kill)|kill\s+-9|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i;

/**
 * 物理产物路径词元。
 * 注意：扩展名候选必须按「最长优先」排列（jsonc 在 json 之前、json 在 js 之前），
 * 否则 `package.json` 会被截断为 `package.js`，导致冻结边界规则永远失配。
 */
const PATH_TOKEN_RE =
  /(?:[A-Za-z0-9_@.-]+[\\/])+[A-Za-z0-9_@.*-]+|\.env(?![A-Za-z0-9])|(?:docs|config|data|tests|src|scripts)\/|[A-Za-z0-9_@-]+\.(?:jsonc|json|tsx|ts|mjs|cjs|js|ya?ml|md|env|lock)/gi;

/** 已知工程根目录：作为「这是物理路径而非普通斜杠短语」的判定锚点 */
const KNOWN_PROJECT_ROOTS =
  /^(?:src|docs|config|data|tests|scripts|node_modules|\.scratch|\.agents|\.claude|\.github)\//i;

/** 路径词元必须落在「真实工程产物面」上，避免 CI/CD、N/A、24/7、S/M/L 等斜杠短语误判为爆炸半径 */
function isPlausibleArtifactPath(token: string): boolean {
  if (token === '.env') return true;
  if (KNOWN_PROJECT_ROOTS.test(token)) return true;
  return /\.[A-Za-z0-9]+$/.test(token);
}

export class SeamProbeEngine {
  /**
   * 从任务文本中提取声明的物理产物路径集合（去重、归一化分隔符）。
   */
  static extractFilePaths(text: string): string[] {
    const found = text.match(PATH_TOKEN_RE) ?? [];
    const normalized = found
      .map((token) => token.replace(/\\/g, '/').replace(/[.,;:、。）)]+$/, ''))
      .filter((token) => token.length > 1 && isPlausibleArtifactPath(token));
    const unique = [...new Set(normalized)];
    // 剔除已被更具体文件路径包含的目录前缀（如 "src/" 与 "src/index.ts" 并存时只保留后者）
    return unique.filter(
      (token) =>
        !token.endsWith('/') ||
        !unique.some((other) => other !== token && other.startsWith(token)),
    );
  }

  /**
   * 基于「物理产物面 + 架构冻结边界」对声明的 Tier 执行硬探针校准（M10 决策充分性）。
   *
   * 与已废除的纯文本正则猜谜的本质区别：判定依据是「任务声明要触碰的物理文件路径集合」，
   * 而非「微调 / 重构」等自然语言形容词，因此无法通过换个说法绕过门禁。
   */
  static calibrateTier(options: {
    declaredTier?: TaskTier;
    objective: string;
    instruction: string;
  }): SeamProbeResult {
    const declaredTier =
      options.declaredTier ?? inferTaskTier(options.objective, options.instruction);
    const combined = `${options.objective} ${options.instruction}`;
    const probedPaths = SeamProbeEngine.extractFilePaths(combined);

    // 1. 物理破坏性操作探针：无论声明为何，强制 L 级
    const destructive = combined.match(DESTRUCTIVE_COMMAND_RE);
    if (destructive && declaredTier !== 'L') {
      return {
        declaredTier,
        calibratedTier: 'L',
        escalated: true,
        probedPaths,
        reason: `检测到物理破坏性操作指令「${destructive[0]}」，强制升级为 L 级并入人工审批闭环`,
      };
    }

    // 2. 架构冻结边界探针（Boundary Violation Gate）
    const boundaryHits = probedPaths.filter((path) =>
      FROZEN_BOUNDARY_RULES.some((rule) => rule.pattern.test(path)),
    );
    if (boundaryHits.length > 0 && declaredTier !== 'L') {
      const labels = [
        ...new Set(
          boundaryHits.map(
            (path) =>
              FROZEN_BOUNDARY_RULES.find((rule) => rule.pattern.test(path))!.label,
          ),
        ),
      ];
      return {
        declaredTier,
        calibratedTier: 'L',
        escalated: true,
        probedPaths,
        reason: `物理探针命中架构冻结边界：${labels.join('、')}（${boundaryHits.join('、')}），强制升级为 L 级`,
      };
    }

    // 3. 爆炸半径探针（Blast Radius Gate）：仅 S 级需要防穿透校准
    const directories = new Set(
      probedPaths.map((path) => path.split('/').slice(0, -1).join('/') || '.'),
    );
    if (declaredTier === 'S' && (probedPaths.length > 3 || directories.size > 1)) {
      return {
        declaredTier,
        calibratedTier: 'M',
        escalated: true,
        probedPaths,
        reason: `爆炸半径探针：任务声明触及 ${probedPaths.length} 个文件、跨 ${directories.size} 个目录，超出 S 级轻量无害范围，升级为 M 级`,
      };
    }

    return { declaredTier, calibratedTier: declaredTier, escalated: false, probedPaths };
  }
}

export interface LowRiskAssessment {
  lowRisk: boolean;
  reasons: string[];
}

/**
 * 低风险判定（**纯函数，唯一判定点**）。
 *
 * 判定式为「探针事实 ∧ ceo 自评」双条件**同时**成立：
 *
 * 1. **探针事实**（确定性，LLM 无法靠措辞绕过）：任务声明的物理产物面
 *    不得触碰架构冻结边界、不得含物理破坏性指令、不得超出小爆炸半径、分级不得为 L。
 *    「可回滚」由此推出——不触碰冻结区、无破坏性操作、纯代码变更天然落在 Git 版本控制内。
 * 2. **ceo 自评**：ceo **显式**声明 `riskLevel: 'low'`。未声明即不背书（fail-closed）。
 *
 * 为什么必须是双条件而非任一单条件：
 * - 只信探针 → 探针只能看见「被声明的路径」，看不见未声明的语义风险；
 * - 只信 ceo → ceo 可单方面放宽标准，把本应付人类成本的争议自动推过人类闸门。
 *   二者互为对方的边界，缺一即不成立。
 */
export function assessLowRisk(options: {
  objective: string;
  instruction: string;
  tier?: TaskTier;
  ceoRiskLevel?: 'low' | 'high';
}): LowRiskAssessment {
  const reasons: string[] = [];

  // ── 事实侧：物理探针（与 Tier 校准共用同一套规则，杜绝两套判定标准漂移）──
  const probe = SeamProbeEngine.calibrateTier({
    declaredTier: options.tier,
    objective: options.objective,
    instruction: options.instruction,
  });
  if (probe.escalated) {
    reasons.push(`物理探针不通过：${probe.reason ?? '爆炸半径超出轻量范围'}`);
  }
  if ((options.tier ?? 'M') === 'L') {
    reasons.push('任务分级为 L 级，系统级变更不适用自动采纳');
  }

  // ── 声明侧：ceo 自评 ──
  if (options.ceoRiskLevel !== 'low') {
    reasons.push(
      options.ceoRiskLevel === 'high'
        ? 'ceo 自评为高风险'
        : 'ceo 未显式声明低风险（未声明即不背书）',
    );
  }

  return { lowRisk: reasons.length === 0, reasons };
}

/**
 * 辅助判定任务复杂度等级 (Tier)
 * - S 级（轻量级）：文案修改、已知Bug微调、单测修复、配置微调等单点明确任务
 * - L 级（重量级）：架构改造、系统重构、多模块变更、中枢演进等系统级任务
 * - M 级（标准级）：常规需求演进、新特性开发等标准流程任务
 */
export function inferTaskTier(objective: string, instruction: string): TaskTier {
  const combined = `${objective} ${instruction}`;

  // 匹配 S 级轻量任务特征
  const isLightweight =
    /(bug|文案|拼写|样式|微调|修复单测|更新配置|修改注释|fix|typo|lint|单测)/i.test(combined);
  const isHeavyweight =
    /(架构|系统|重构|新功能|PRD|跨模块|自适应|中枢|流水线|多智能体|状态机|mas|protocol|lifecycle)/i.test(combined);

  if (isHeavyweight) return 'L';
  if (isLightweight) return 'S';
  return 'M';
}

export interface TechReviewFlow {
  token: string;
  taskId: string;
  dispatchId?: string;
  /** 关联的待确认产品方案流（Phase 4 人类拍板卡片的载体） */
  specFlowToken?: string;
  specDocumentUrl?: string;
  specPath?: string;
  title: string;
  summary: string;
  productBotId: string;
  devBotId: string;
  round: number;
  maxRounds: number;
  ownerOpenId: string;
  ownerUnionId?: string;
  workspaceDir: string;
  comments: string[];
  status: 'pending' | 'approved' | 'rejected' | 'arbitration_needed';
  /**
   * 发起该任务的人类消息 id（跨修订轮次稳定）。
   * taskId 是话题级哈希，无法区分「同一任务的下一轮修订」与「同话题的新任务」，
   * 而原始消息 id 在修订时被 `product-revision-runner` / `clarification-runner` 复用、
   * 在新任务时必然不同，是唯一能精确区分两者的物理凭据。
   */
  originMessageId?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: string;
}

/**
 * 技术审查流的「闲置」回收阈值（自最后一次活动起算）。
 *
 * taskId 是「按话题」哈希而非按任务，同一话题里上一轮任务遗留的 pending 审查流
 * 会被下一个新任务命中并继承其陈旧轮次预算与工作区。
 *
 * 必须按「闲置」而非「创建时长」计算：一轮审查 = Dev 一次完整 CLI 会话 + Product 一次完整 CLI 会话，
 * 中间还可能排队等人点卡片，一小时量级完全在正常往返范围内；若按创建时长回收，
 * 同一任务的正常修订会被误判为孤儿并重置轮次预算，把收敛上限变成永动机。
 * 阈值只需短于「人类在同一话题里开启下一个任务」的间隔。
 */
export const TECH_REVIEW_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

export class TechReviewFlowStore {
  private readonly flows = new Map<string, TechReviewFlow>();

  constructor(initialFlows: TechReviewFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

  create(
    options: Omit<
      TechReviewFlow,
      'token' | 'status' | 'comments' | 'round' | 'createdAt' | 'updatedAt'
    >,
  ): TechReviewFlow {
    const token = randomUUID().replaceAll('-', '');
    const now = Date.now();
    const flow: TechReviewFlow = {
      ...options,
      token,
      round: 1,
      comments: [],
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.flows.set(token, flow);
    return flow;
  }

  get(token: string): TechReviewFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 查找同一任务仍在收敛中的技术审查流（跨产品修订轮次复用，保证 3 轮上限不被重置）。
   *
   * 判定顺序：
   * 1. 物理凭据优先：双方都有 originMessageId 且不一致 → 确认为同话题的不同任务，回收；
   * 2. 否则退回「闲置时长」兜底，回收长期静默的孤儿流。
   */
  findPendingByTaskId(
    taskId: string,
    options: { originMessageId?: string; maxIdleMs?: number } = {},
  ): TechReviewFlow | undefined {
    const maxIdleMs = options.maxIdleMs ?? TECH_REVIEW_IDLE_TTL_MS;
    for (const flow of this.flows.values()) {
      if (flow.taskId !== taskId || flow.status !== 'pending') continue;

      const isDifferentTask =
        !!options.originMessageId &&
        !!flow.originMessageId &&
        flow.originMessageId !== options.originMessageId;
      if (isDifferentTask || Date.now() - flow.updatedAt > maxIdleMs) {
        this.flows.delete(flow.token);
        continue;
      }
      return flow;
    }
    return undefined;
  }

  /**
   * 产品修订后重新绑定最新的待确认方案流。
   * 必须同时刷新产物指针：修订可能改变路径（spec-v2.md）甚至交付方式（local <-> lark-doc），
   * 否则下游 Dev 会照着第一轮的陈旧指针做穿刺，白白烧掉一轮收敛额度。
   */
  bindSpecFlow(
    token: string,
    spec: {
      specFlowToken: string;
      title?: string;
      summary?: string;
      specDocumentUrl?: string;
      specPath?: string;
      ownerOpenId?: string;
      ownerUnionId?: string;
      workspaceDir?: string;
      originMessageId?: string;
    },
  ): TechReviewFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow) return undefined;
    flow.specFlowToken = spec.specFlowToken;
    if (spec.title) flow.title = spec.title;
    if (spec.summary) flow.summary = spec.summary;
    // 交付方式可能切换，两个指针必须整体替换而非各自保留
    flow.specDocumentUrl = spec.specDocumentUrl;
    flow.specPath = spec.specPath;
    // 归属与工作区以当前方案流为准：话题级 taskId 可能让新任务命中旧流，
    // 若沿用旧流的工作区，Dev 会被指向上一个任务的工作目录
    if (spec.ownerOpenId) flow.ownerOpenId = spec.ownerOpenId;
    if (spec.ownerUnionId) flow.ownerUnionId = spec.ownerUnionId;
    if (spec.workspaceDir) flow.workspaceDir = spec.workspaceDir;
    // 无凭据的旧流在首次拿到凭据时补齐，使后续轮次具备精确区分同话题异任务的能力
    if (spec.originMessageId && !flow.originMessageId) {
      flow.originMessageId = spec.originMessageId;
    }
    // 绑定即一次活动往返，必须续期，否则同一任务的正常修订会被闲置回收误判为孤儿
    flow.updatedAt = Date.now();
    this.flows.set(token, flow);
    return flow;
  }

  recordFeedback(
    token: string,
    comment: string,
    approved: boolean,
  ): TechReviewFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending') return undefined;

    flow.comments.push(comment);
    flow.updatedAt = Date.now();
    if (approved) {
      flow.status = 'approved';
      flow.resolvedAt = new Date().toISOString();
    } else {
      flow.round += 1;
      if (flow.round > flow.maxRounds) {
        flow.status = 'arbitration_needed';
      }
    }
    this.flows.set(token, flow);
    return flow;
  }

  /** 级联清理：链路被终止/熔断时必须回收关联审查流，避免同话题的下个任务继承陈旧轮次预算 */
  deleteByTaskId(taskId: string): number {
    let removed = 0;
    for (const flow of [...this.flows.values()]) {
      if (flow.taskId !== taskId) continue;
      this.flows.delete(flow.token);
      removed += 1;
    }
    return removed;
  }

  delete(token: string): boolean {
    return this.flows.delete(token);
  }

  protected snapshot(): TechReviewFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  protected restore(flows: TechReviewFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}

export const DispatchTaskRequestSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  objective: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(2_000),
  expectedOutput: z.string().trim().min(1).max(500).optional(),
  targetWorkspace: z.string().trim().min(1).max(240).optional(),
  tier: z.enum(['S', 'M', 'L']).optional(),
  /**
   * 工单性质。**默认为 implement**（fail-closed）：不声明就等于声明"这是实现单"，
   * M/L 级照常走完 Phase 1-4；只有显式声明 recon 才允许在方案批准前直派 developer，
   * 且事后会被 `git status` 物理复核。
   */
  intent: z.enum(['recon', 'implement']).optional(),
  /** 上游显式提供的决策摘要（总线不编造），用于装配下游胶囊 */
  distilledDecisionsSummary: z.string().trim().max(1_000).optional(),
});

export type DispatchTaskRequest = z.infer<typeof DispatchTaskRequestSchema>;

/**
 * 下游穿刺动态升级门禁 (request_escalation)
 * developer 在承接 S 级直派任务时，若探查发现物理复杂度超标，行使专业主权将任务升级为 M/L 级。
 */
export const EscalationRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(1_000).optional(),
  suggestedTier: z.enum(['M', 'L']),
});

export type EscalationRequest = z.infer<typeof EscalationRequestSchema>;

export function findEscalationRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): EscalationRequest | undefined {
  return inspectEscalationRequest(toolCalls).request;
}

export function inspectEscalationRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ToolCallInspection<EscalationRequest> {
  return inspectToolCall(toolCalls, 'request_escalation', EscalationRequestSchema);
}

/**
 * Phase 3 技术可行性对抗审查结论 (submit_tech_review)
 * developer 完成代码接缝穿刺后回传结构化裁决，驱动收敛或人工仲裁。
 */
export const SubmitTechReviewRequestSchema = z.object({
  flowToken: z.string().trim().min(1).max(64),
  verdict: z.enum(['approved', 'rejected']),
  comment: z.string().trim().max(1_000).optional(),
});

export type SubmitTechReviewRequest = z.infer<
  typeof SubmitTechReviewRequestSchema
>;

export function findTechReviewSubmission(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): SubmitTechReviewRequest | undefined {
  return inspectTechReviewSubmission(toolCalls).request;
}

export function inspectTechReviewSubmission(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ToolCallInspection<SubmitTechReviewRequest> {
  return inspectToolCall(
    toolCalls,
    'submit_tech_review',
    SubmitTechReviewRequestSchema,
  );
}

/**
 * 第一层仲裁：ceo-assistant 初步裁决 (submit_arbitration_verdict)。
 *
 * 为什么必须用**独立工具**而非复用 `dispatch_task` 表达裁决：
 * 派发创造的是「新的任务授权」，裁决表达的是「对既有争议的归属判定」，
 * 两者若共用一个工具，仲裁归属会变得无法追溯——事后无法从工具调用记录里
 * 区分「ceo 派发了新任务」与「ceo 对某次争议做了裁决」。
 *
 * `abstain` 是一等公民而非错误分支：ceo 的授权边界（排期/粒度/取舍/方案选择）
 * 之外的技术真实性争议**必须显式弃权**上浮人类，严禁"假装决断"。
 */
export const ArbitrationVerdictSchema = z.object({
  flowToken: z.string().trim().min(1).max(64),
  verdict: z.enum(['adopt_product', 'adopt_developer', 'abstain']),
  reasoning: z.string().trim().min(1).max(1_000),
  /**
   * ceo 自评风险等级。低风险自动采纳要求「探针事实 ∧ ceo 声明」双条件同时成立，
   * 因此该字段**不可省略**为默认值：未声明即视为未背书低风险。
   */
  riskLevel: z.enum(['low', 'high']).optional(),
});

export type ArbitrationVerdictRequest = z.infer<
  typeof ArbitrationVerdictSchema
>;

export function findArbitrationVerdict(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ArbitrationVerdictRequest | undefined {
  return inspectArbitrationVerdict(toolCalls).request;
}

export function inspectArbitrationVerdict(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ToolCallInspection<ArbitrationVerdictRequest> {
  return inspectToolCall(
    toolCalls,
    'submit_arbitration_verdict',
    ArbitrationVerdictSchema,
  );
}

export function findDispatchTaskRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): DispatchTaskRequest | undefined {
  return inspectDispatchTaskRequest(toolCalls).request;
}

export function inspectDispatchTaskRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ToolCallInspection<DispatchTaskRequest> {
  return inspectToolCall(toolCalls, 'dispatch_task', DispatchTaskRequestSchema);
}

/**
 * 协作转发（Chain-internal Relay）请求。
 *
 * 与「任务派发」的第一性区别：**是否产生新的任务授权**。
 * - `dispatch_task` 创造授权（组织权，ceo 独占，可改 objective / 指定工作区）
 * - `relay_to_peer` 延续授权（上游委托，链内成员可用，**不可改写 objective**）
 *
 * 因此本 schema **故意不提供 objective / targetWorkspace / tier 字段**：
 * 转发的语义就是「沿既有链把当前工件交给下一位专业角色」，
 * 一旦允许改写目标或分级，转发即退化为绕开 RBAC 的越权派发后门。
 */
export const RelayRequestSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  instruction: z.string().trim().min(1).max(2_000),
  expectedOutput: z.string().trim().min(1).max(500).optional(),
  /** 上游显式提供的决策摘要，用于装配下游 ContextCapsule（总线不自行编造摘要） */
  distilledDecisionsSummary: z.string().trim().max(1_000).optional(),
});

export type RelayRequest = z.infer<typeof RelayRequestSchema>;

/** 协作转发的链内上下文（仅暴露护栏判定所需字段） */
export interface RelayGuardChain {
  reportToBotId: string;
  round: number;
  maxRounds: number;
  tier?: TaskTier;
  objective: string;
  /** 工单性质：recon 允许在方案批准前转交 developer 做只读探查 */
  intent?: TaskIntent;
}

/**
 * 协作转发护栏判定（**纯函数，唯一判定点**）。
 *
 * 返回值：拒绝理由；`undefined` 表示放行。
 *
 * 之所以做成纯函数而非散落在调用点的多个 `if`：
 * 曾出现过「护栏只设置标志位而不终止分支」的严重回归——标志位只在进入代码块时求值一次，
 * 导致被拦截的转发照常派发、轮次上限与 M/L 门禁全部失效。
 * 集中为单点判定后，"非终止型护栏"在结构上不再可能表达。
 */
export function checkRelayGuardrails(options: {
  selfBotId: string;
  targetBotId: string;
  targetRegistered: boolean;
  chain?: RelayGuardChain;
  instruction: string;
}): string | undefined {
  const { chain } = options;

  if (!chain) {
    return '当前不在任何协作链中，无法转发。若需要发起新任务，请由 CEO 助理使用 dispatch_task 派发。';
  }
  if (!options.targetRegistered) {
    return `目标成员未注册或未启用：${options.targetBotId}`;
  }
  if (options.targetBotId === options.selfBotId) {
    return `不能把协作任务转发给当前 bot 自身：${options.selfBotId}`;
  }
  // 转给「本该回传的对象」在语义上叫回传，不叫转发。若放行，接收方的 reportToBotId
  // 恰等于其自身，完成时会命中「协作任务已完成」终态分支，从而在 Phase 3 审查流
  // 仍 pending 的情况下向人类谎报任务完成。
  if (options.targetBotId === chain.reportToBotId) {
    return `不能把协作任务转发给 ${chain.reportToBotId}：它是本链的回传对象，回传请直接给出结论，无需转发。`;
  }
  if (chain.round >= chain.maxRounds) {
    return `协作任务已达轮次上限 ${chain.maxRounds}，本轮必须给出最终结论，不得继续转发。`;
  }
  // 与 dispatch_task 共用同一道 M/L 级门禁：转发同样不得成为
  // 「绕过方案与人类终审、直接把 M/L 任务塞给 developer」的侧门。
  // 未声明分级时按 M 兜底（fail-closed），且**不可**写成 maxTaskTier(tier,'M') !== 'S'
  // —— 该式恒为真，会让门禁丧失分级判别能力。
  const relayTier = chain.tier ?? 'M';
  if (
    options.targetBotId === 'developer' &&
    relayTier !== 'S' &&
    // 只读调研与实现必须区别对待：Phase 1 明确要求 Dev 在方案批准前做 Seam 探查，
    // 若把调研也一并拦下，PRD 的两条要求会互相打架。recon 由 intent 显式声明，
    // 且转交后仍受 git 变更探针的物理复核（声明不可信，事实才可信）。
    chain.intent !== 'recon' &&
    !detectApprovedSpec({
      objective: chain.objective,
      instruction: options.instruction,
      chainObjective: chain.objective,
    })
  ) {
    return 'M/L 级任务在方案经人类终审前不可直接转交 developer（只读调研除外，需显式声明 intent=recon）。请先完成方案编制与 Phase 3 技术审查。';
  }
  return undefined;
}

export function findRelayRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): RelayRequest | undefined {
  return inspectRelayRequest(toolCalls).request;
}

export function inspectRelayRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ToolCallInspection<RelayRequest> {
  return inspectToolCall(toolCalls, 'relay_to_peer', RelayRequestSchema);
}

/**
 * ContextCapsule 体积上限（PRD 契约：≤1.5k tokens）。
 * 中文场景下 1 token ≈ 1.3~1.5 字符，故取 2000 字符作为保守预算。
 */
export const CAPSULE_CHAR_BUDGET = 2_000;

/** 刚性约束区段的独立预算（防条数过多导致整体溢出） */
export const CAPSULE_CONSTRAINTS_BUDGET = 600;

/**
 * 确定性装配无状态上下文胶囊。
 *
 * 严格区分「总线确定性可得」与「需上游显式提供」两类信息：
 * - 总线只装配可从链路与存储**确定推出**的字段，**绝不自行编造摘要**；
 * - `distilledDecisionsSummary` 必须由上游 Bot 在派发/转发时显式给出，否则留空。
 */
const CAPSULE_TRUNCATION_SUFFIX = '…（已按胶囊预算截断）';

/** 把字符串截到 max 长度以内；截断时保留标记后缀且总长不超 max */
function truncateTo(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= CAPSULE_TRUNCATION_SUFFIX.length) return s.slice(0, Math.max(0, max));
  return `${s.slice(0, max - CAPSULE_TRUNCATION_SUFFIX.length)}${CAPSULE_TRUNCATION_SUFFIX}`;
}

/**
 * 宿主门禁规则（约束清单的**事实陈述**段）。
 *
 * 措辞刻意描述「宿主会怎么做」，而非「目标仓的红线是什么」——
 * 前者在任何项目下都成立，后者只在同仓时成立（跨仓时目标仓的 `docs/`、`config/`
 * 语义可能完全不同）。把两者的边界划清，才能既给出有效信息又永不说错话。
 *
 * 内置在装配器里而**不是**作为调用方参数：调用方参数曾经整整一段空转
 * （`constraints` 从未被任何调用点传入），内置后不存在「忘了传」的可能。
 */
export function hostGateConstraint(): string {
  const labels = FROZEN_BOUNDARY_RULES.map((rule) => rule.label).join('、');
  return `宿主门禁（事实陈述）：以下产物面被**宿主**视为冻结区，变更它们会被强制升级为 L 级并进入人工审批 —— ${labels}。跨工作区时以宿主自身规则为准，目标仓另有约定请以目标仓声明为准。`;
}

export function assembleContextCapsule(options: {
  sourceTaskId: string;
  fromWorkspace: string;
  toWorkspace: string;
  objective: string;
  tier?: TaskTier;
  approvedSpecPointer?: string;
  distilledDecisionsSummary?: string;
  constraints?: string[];
  lineage?: CapsuleLineage;
  targetWorkspaceMeta?: TargetWorkspaceMetaPrompt;
}): ContextCapsule {
  const rawConstraints = (options.constraints ?? []).map((c) =>
    truncateTo(c, 200),
  );
  // 内置门禁规则**排在调用方约束之后**：它是恒定 180 字的通用事实陈述，
  // 而调用方给的是任务特定约束。预算不足时先牺牲通用项，别把任务约束挤掉。
  rawConstraints.push(hostGateConstraint());
  if (options.tier) {
    rawConstraints.unshift(
      `任务分级：${options.tier} 级（分级为刚性下限，链路上只可上调，不得自行降级）`,
    );
  }
  // 约束条数同样必须有界：单条截断到 200 仍可能因条数过多而整体溢出
  const constraints: string[] = [];
  let constraintsUsed = 0;
  let omittedCount = 0;
  for (const constraint of rawConstraints) {
    if (constraintsUsed + constraint.length + 3 > CAPSULE_CONSTRAINTS_BUDGET) {
      // 用 continue 而非 break：一条装不下不该连带丢掉后面的短约束
      omittedCount += 1;
      continue;
    }
    constraints.push(constraint);
    constraintsUsed += constraint.length + 3;
  }
  const omitted = Math.max(omittedCount, rawConstraints.length - constraints.length);
  if (omitted > 0) {
    constraints.push(`…另有 ${omitted} 条约束因胶囊预算被省略`);
  }

  const constraintsLength = constraints.reduce((n, c) => n + c.length + 3, 0);
  const lineage = options.lineage
    ? {
        ...options.lineage,
        // 承接说明必须受预算约束，否则一段超长 note 就能顶穿整个胶囊
        note: options.lineage.note
          ? truncateTo(options.lineage.note, 300)
          : undefined,
      }
    : undefined;
  const fixedLength = capsuleFixedLength({
    sourceTaskId: options.sourceTaskId,
    fromWorkspace: options.fromWorkspace,
    toWorkspace: options.toWorkspace,
    approvedSpecPointer: options.approvedSpecPointer,
    constraintsLength,
    lineageLength: lineage ? lineageLengthOf(lineage) : 0,
    targetWorkspaceMetaLength: targetWorkspaceMetaLengthOf(
      options.targetWorkspaceMeta,
    ),
  });

  // **每一段都必须受预算约束**：仅截断摘要而放过超长 objective / constraints
  // 会让胶囊在极端输入下完全突破上限（实测目标 1900 字时可超 2100）。
  let objective = options.objective;
  let summary = options.distilledDecisionsSummary ?? '';
  const available = Math.max(0, CAPSULE_CHAR_BUDGET - fixedLength);
  objective = truncateTo(objective, available);
  summary = truncateTo(summary, Math.max(0, available - objective.length));

  return {
    sourceTaskId: options.sourceTaskId,
    fromWorkspace: options.fromWorkspace,
    toWorkspace: options.toWorkspace,
    objective,
    constraints,
    distilledDecisionsSummary: summary,
    approvedSpecPointer: options.approvedSpecPointer,
    lineage,
    targetWorkspaceMeta: options.targetWorkspaceMeta,
    timestamp: Date.now(),
  };
}

/** 格式化目标工作区知识空间资产元数据指引 */
export function formatTargetWorkspaceMeta(
  meta: TargetWorkspaceMetaPrompt,
): string {
  const targetLabel = meta.alias ? `${meta.alias} (${meta.path})` : meta.path;
  const lines = [
    '【目标工作区知识空间资产】',
    `目标工作区: ${targetLabel}`,
  ];
  if (meta.wikiSpaceId) {
    lines.push(`Wiki 空间 ID: ${meta.wikiSpaceId}`);
  }
  if (meta.prdParentNodeToken) {
    lines.push(`PRD 直建父节点: ${meta.prdParentNodeToken}`);
    lines.push(
      `操作纪律: 创建方案时必须携带 --parent-token ${meta.prdParentNodeToken} 直建挂载至目标 Wiki 节点。`,
    );
  }
  return lines.join('\n');
}

/** 目标工作区元数据指引段的可变文本开销；装配器与估计器必须共用 */
export function targetWorkspaceMetaLengthOf(
  meta?: TargetWorkspaceMetaPrompt,
): number {
  if (!meta) return 0;
  return formatTargetWorkspaceMeta(meta).length;
}

/** 承接段的可变文本长度；装配器与估计器必须共用，否则又会出现「测试绿而实际超限」 */
function lineageLengthOf(lineage: CapsuleLineage): number {
  return (
    lineage.sourceTaskId.length +
    (lineage.approvedSpecPointer?.length ?? 0) +
    (lineage.settledAt?.length ?? 0) +
    (lineage.note?.length ?? 0)
  );
}

/**
 * 胶囊的固定开销（与可变文本无关的部分）。
 * **装配器与估计器必须共用本函数**：否则估计器会漏算某字段，
 * 出现"测试断言通过、实际却超限"的假绿。
 */
function capsuleFixedLength(parts: {
  sourceTaskId: string;
  fromWorkspace: string;
  toWorkspace: string;
  approvedSpecPointer?: string;
  constraintsLength: number;
  /** 承接段的可变文本长度；装配器与估计器必须同时计入 */
  lineageLength?: number;
  /** 目标工作区元数据指引段长度；装配器与估计器必须同时计入 */
  targetWorkspaceMetaLength?: number;
}): number {
  const RENDER_OVERHEAD = 240; // 标题、字段名、分隔符等
  return (
    RENDER_OVERHEAD +
    parts.sourceTaskId.length +
    parts.fromWorkspace.length +
    parts.toWorkspace.length +
    (parts.approvedSpecPointer?.length ?? 0) +
    parts.constraintsLength +
    (parts.lineageLength ?? 0) +
    (parts.targetWorkspaceMetaLength ?? 0)
  );
}

/** 胶囊的渲染后总长度（供测试与上限校验使用，与装配器共用同一套开销计算） */
export function estimateCapsuleLength(capsule: ContextCapsule): number {
  return (
    capsuleFixedLength({
      sourceTaskId: capsule.sourceTaskId,
      fromWorkspace: capsule.fromWorkspace,
      toWorkspace: capsule.toWorkspace,
      approvedSpecPointer: capsule.approvedSpecPointer,
      constraintsLength: capsule.constraints.reduce((n, c) => n + c.length + 3, 0),
      lineageLength: capsule.lineage ? lineageLengthOf(capsule.lineage) : 0,
      targetWorkspaceMetaLength: targetWorkspaceMetaLengthOf(
        capsule.targetWorkspaceMeta,
      ),
    }) +
    capsule.objective.length +
    capsule.distilledDecisionsSummary.length
  );
}

export function collaborationOrigin(
  message: CollaborationMessage,
): CollaborationOrigin {
  return {
    taskId: message.taskId,
    fromBotId: message.fromBotId,
    reportToBotId: message.reportToBotId,
    round: message.round,
    maxRounds: message.maxRounds,
    negotiationRound: message.negotiationRound,
    negotiationMaxRounds: message.negotiationMaxRounds,
    intent: message.intent,
    tier: message.tier,
    escalations: message.escalations,
    originMessageId: message.originMessageId,
  };
}

export function buildCollaborationPrompt(
  message: CollaborationMessage,
): string {
  const parts = [
    `协作目标：${message.objective}`,
    `执行要求：${message.instruction}`,
    message.expectedOutput ? `期望产出：${message.expectedOutput}` : '',
  ];

  // 链路自我认知：接收方必须知道自己处于哪条链、第几轮、什么分级，
  // 否则「3 轮收敛」对 Agent 而言是不可知的约束——它连自己在第几轮都不知道。
  const remaining = Math.max(0, message.maxRounds - message.round);
  // 两个计数必须分别呈现：链跳数管「还能走几跳」，辩证轮数管「这件事还能吵几轮」。
  // 只给一个数字会让 Agent 把两种约束混为一谈（历史上正是这样塌缩的）。
  const negotiationMax = message.negotiationMaxRounds ?? NEGOTIATION_MAX_ROUNDS;
  const negotiationRound = message.negotiationRound ?? 1;
  parts.push(
    [
      '【协作链路状态】',
      `上一跳来源：${message.fromBotId}；最终回传至：${message.reportToBotId}`,
      `链路跳数：第 ${message.round} / ${message.maxRounds} 跳（剩余 ${remaining} 跳，触顶将熔断终止整条链）`,
      `辩证轮数：第 ${negotiationRound} / ${negotiationMax} 轮（product↔dev 就同一方案的对抗轮次，触顶将进入仲裁）`,
      message.tier ? `任务分级：${message.tier} 级` : '',
      message.intent === 'recon'
        ? '⚠️ 本工单性质为**只读调研（recon）**：只可探查与回报，**严禁修改任何文件**；宿主会用 git 变更探针复核，一旦发现改动即判定越权并熔断。'
        : '',
      message.escalations
        ? `已发生动态升级次数：${message.escalations} / ${MAX_TASK_ESCALATIONS}`
        : '',
      remaining === 0
        ? '⚠️ 本轮已是最后一跳：必须给出最终结论，不得再次转发或派发。'
        : '轮次是「收敛提示」而非「放弃信号」——请在剩余额度内给出可交付结论。',
      remaining === 0
        ? ''
        : '若需链内同伴（如 product 与 developer）就方案细节往复对抗，可调用 relay_to_peer 转交工件；注意：转发会**消耗一跳链跳数**并继承本链目标与分级，请勿用它改写任务目标，也勿用它替代本该直接给出的结论。',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (message.capsule) {
    const capsuleLines = [
      '【无状态上下文胶囊 (ContextCapsule)】',
      `溯源任务：${message.capsule.sourceTaskId}`,
      `工作区流转：${message.capsule.fromWorkspace} -> ${message.capsule.toWorkspace}`,
      message.capsule.approvedSpecPointer ? `权威方案指针：${message.capsule.approvedSpecPointer}` : '',
      message.capsule.targetWorkspaceMeta
        ? formatTargetWorkspaceMeta(message.capsule.targetWorkspaceMeta)
        : '',
      message.capsule.constraints.length ? `刚性约束：\n${message.capsule.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      message.capsule.distilledDecisionsSummary ? `决策摘要：\n${message.capsule.distilledDecisionsSummary}` : '',
      message.capsule.lineage
        ? [
            '承接来源（本链续接自以下已收口的上游工作，勿重复其已完成部分）：',
            `- 来源任务：${message.capsule.lineage.sourceTaskId}`,
            // 措辞必须与主胶囊的「权威方案指针」**明确区分**：
            // 两者都被称作"已确认方案"时，模型会去更新一份已经封存的旧文档。
            // 这里的指针仅供追溯，绝不能作为实施依据。
            message.capsule.lineage.approvedSpecPointer
              ? `- 来源历史方案（**仅供追溯，切勿据此实施或修改该文档**）：${message.capsule.lineage.approvedSpecPointer}`
              : '',
            message.capsule.lineage.settledAt
              ? `- 收口时间：${message.capsule.lineage.settledAt}`
              : '',
            message.capsule.lineage.note
              ? `- 承接说明：${message.capsule.lineage.note}`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
    ].filter(Boolean).join('\n');
    parts.push(capsuleLines);
  }

  parts.push(
    `完成后，把结果交回 ${message.reportToBotId} 继续组织后续工作；已经可以交付时，明确给出最终结论。`,
  );

  return parts.filter(Boolean).join('\n\n');
}

export function collaborationTurnKey(message: CollaborationMessage): string {
  // 修复为按 message.dispatchId 去重，根除跨轮次防重误杀缺陷
  return message.dispatchId;
}

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message);
  }

  /**
   * 只读取出（**不删除**）。与 `ack` 配对使用。
   *
   * 为什么必须两段式：`consume` 是破坏性取出，一旦被放在去重判定**之前**，
   * 重复投递的第二次就会拿到 `undefined`，从而**绕过整条去重护栏**，
   * 被降级成「外部派活」再跑一次 CLI —— 护栏存在却永远不被执行。
   * 「取出即销毁」的队列语义与「Set 型去重」不可共存，必须拆成 peek + ack。
   */
  peek(
    dispatchId: string,
    toBotId: string,
  ): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    if (!message || message.toBotId !== toBotId) return undefined;
    return message;
  }

  /** 确认处理完成后才真正移除 */
  ack(dispatchId: string): void {
    this.messages.delete(dispatchId);
  }

  /** 破坏性取出（仅用于**回滚**场景：派发失败时撤销已注册的消息） */
  consume(
    dispatchId: string,
    toBotId: string,
  ): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    if (!message || message.toBotId !== toBotId) return undefined;
    this.messages.delete(dispatchId);
    return message;
  }
}
