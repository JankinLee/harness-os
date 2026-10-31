import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CollaborationOrigin } from './collaboration.js';
import {
  inspectToolCall,
  type ToolCallInspection,
} from './tool-call-inspection.js';

const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
    '文档路径必须位于当前工作目录内',
  )
  .refine(
    (value) => !value.replace(/\\/g, '/').startsWith('docs/'),
    '禁止将业务需求文档写入 docs/ 目录。docs/ 仅限系统蓝图与架构决策，业务文档请置于 .scratch/<feature>/ 局部工作区。',
  );

const LarkDocumentUrlSchema = z
  .url()
  .refine(
    (value) => /\/(?:docx|wiki)\//.test(new URL(value).pathname),
    'documentUrl 必须是飞书 Docx 或 Wiki 知识库文档链接',
  );

export const LocalProductSpecRequestSchema = z.object({
  deliveryMode: z.literal('local'),
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  warning: z.string().optional(),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema.describe(
    '实现任务路径，可传切片目录（如 .scratch/<feature>/issues）或汇总说明文件（如 .scratch/<feature>/tickets.md）',
  ),
  issuesPath: WorkspaceDocumentPathSchema.optional(),
}).strict();

export const LarkProductSpecRequestSchema = z.object({
  deliveryMode: z.literal('lark-doc'),
  documentUrl: LarkDocumentUrlSchema,
  title: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  warning: z.string().optional(),
}).strict();

export const ProductSpecRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<
  typeof LocalProductSpecRequestSchema
>;
export type LarkProductSpecRequest = z.infer<
  typeof LarkProductSpecRequestSchema
>;

/**
 * 云文档四阶段生命周期（LIFECYCLE-CAPSULE）。
 *
 * 与单维审批态 `status` **正交并存**，不可互相顶替：
 * `status` 回答「这份方案人类批了没有」，`lifecycle` 回答「这件事走到一生中的哪一步」。
 * 把两者压成一个字段，会让「已批准但尚未交付」与「已交付但尚未验收」无法区分。
 */
export type SpecLifecycle = 'pending' | 'in_development' | 'delivered' | 'archived';

/** 停滞休眠阈值：研发中静默超过 7 天视为停摆，转入休眠并释放资源 */
export const LIFECYCLE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** 静默自动归档阈值：交付后 14 天无人验收则自动归档（归档通道③） */
export const LIFECYCLE_ARCHIVE_MS = 14 * 24 * 60 * 60 * 1000;

export type LifecycleEvent =
  | 'approved'
  | 'dev_delivered'
  | 'accepted'
  | 'rejected'
  | 'manual_archive'
  | 'command_archive'
  | 'auto_archive'
  | 'stale_quarantine'
  | 'wake';

const LIFECYCLE_TRANSITIONS: Record<
  SpecLifecycle,
  Partial<Record<LifecycleEvent, SpecLifecycle>>
> = {
  pending: {
    approved: 'in_development',
    manual_archive: 'archived',
    command_archive: 'archived',
    auto_archive: 'archived',
    stale_quarantine: 'pending',
    wake: 'pending',
  },
  in_development: {
    dev_delivered: 'delivered',
    manual_archive: 'archived',
    command_archive: 'archived',
    auto_archive: 'archived',
    stale_quarantine: 'in_development',
    wake: 'in_development',
  },
  delivered: {
    // 打回归正：验收未通过必须回到研发，而不是停在 delivered 反复推送验收卡
    rejected: 'in_development',
    accepted: 'delivered',
    manual_archive: 'archived',
    command_archive: 'archived',
    auto_archive: 'archived',
    // **必填**：PRD §2.2.3 的停滞休眠对象就是 delivered（长期观察期）。
    // 漏掉这个键会让 `planLifecycleSweep` 判定为 quarantine 而 `nextLifecycle` 返回 undefined，
    // 巡检只能静默 continue —— 整档休眠写了却从不生效（错题本「跃迁表漏键」同型）。
    stale_quarantine: 'delivered',
    wake: 'delivered',
  },
  // 归档是终态：任何事件都不得把它复活（含 wake），否则「释放监听」会被悄悄撤销
  archived: {},
};

/**
 * 生命周期转移判定（**纯函数，唯一判定点**）。
 * 返回 undefined 表示该事件在当前阶段非法 —— 由调用点显式回告，不得静默忽略。
 */
export function nextLifecycle(
  current: SpecLifecycle,
  event: LifecycleEvent,
): SpecLifecycle | undefined {
  return LIFECYCLE_TRANSITIONS[current]?.[event];
}

export type LifecycleSweepAction = 'none' | 'quarantine' | 'archive';

/**
 * 停滞巡检判定（**纯函数**）。
 *
 * 三个通道（人工点击、/archive 命令、14 天自动）最终都汇入同一个归档实现，
 * 因此这里只负责判定「该不该动」，不负责怎么动 —— 避免三条通道各自演化出不同语义。
 */
export function planLifecycleSweep(
  flow: Pick<ProductSpecFlow, 'lifecycle' | 'lifecycleUpdatedAt' | 'acceptedAt'>,
  now: number,
  options: { staleMs?: number; archiveMs?: number } = {},
): LifecycleSweepAction {
  if (flow.lifecycle === 'archived') return 'none';
  const staleMs = options.staleMs ?? LIFECYCLE_STALE_MS;
  const archiveMs = options.archiveMs ?? LIFECYCLE_ARCHIVE_MS;
  // 历史落盘记录没有 lifecycleUpdatedAt：按「刚刚活动过」处理（fail-open 到活跃态），
  // 否则升级重启后所有旧方案会在同一瞬间被判定为停滞并集体休眠。
  const idle = now - (flow.lifecycleUpdatedAt ?? now);

  // PRD §2.2.3 的原始对象是 **delivered**：长期观察期才是「卡片挂起 + 监听算力浪费」的现场。
  // 先判归档（更终局），再判停滞；两档共用同一条 idle 时间轴。
  if (flow.lifecycle === 'delivered') {
    if (idle >= archiveMs) return 'archive';
    return idle >= staleMs ? 'quarantine' : 'none';
  }
  // 研发中的停滞休眠是 PRD 之外的**超集**（研发中同样占用工作区与订阅，放任不管没有依据）。
  // 若与 PRD 冲突需去掉，只删这一行即可，delivered 的语义不受影响。
  if (flow.lifecycle === 'in_development' && idle >= staleMs) return 'quarantine';
  return 'none';
}

/**
 * 挑出「已交付且静默超过阈值」的方案（治理大盘的批量归档对象）。
 *
 * 判定必须与 `/governance` 展示、批量归档执行**共用同一个函数**：
 * 三处各写一遍条件时，必然出现「大盘上看到 3 份、点下去只归档了 2 份」的错位。
 */
export function selectStaleDelivered(
  flows: ProductSpecFlow[],
  now: number,
  staleMs: number = LIFECYCLE_STALE_MS,
): ProductSpecFlow[] {
  return flows.filter(
    (flow) =>
      flow.lifecycle === 'delivered' && now - (flow.lifecycleUpdatedAt ?? now) >= staleMs,
  );
}

/**
 * 是否为**无任务凭据行**（存量行，或凭据链在上游断裂时新建的行）。
 *
 * 这类行**不参与任何同话题任务匹配**：`taskId` 是话题级哈希，缺凭据的行在
 * 「双方都有凭据才比较」的旧语义下会匹配**任意**凭据 —— 于是同话题下发新任务时，
 * 既可能被注入上一个任务的方案指针，也可能让陈旧的 pending 永久抑制完成通知。
 *
 * 为什么由凭据**推导**而不是落一个显式标记字段：任何标记都只能在「装载」与「创建」
 * 两条写路径上维护，第三条生产路径（直接构造 store、测试辅助、将来的迁移）必然破洞，
 * 而破洞的表现正是「同一状态两种表示」——一种退出匹配、一种仍匹配任意凭据。
 * 凭据本身就在行里，是同一事实的**唯一**真源。
 */
export function isCredentiallessRow(
  flow: Pick<ProductSpecFlow, 'originalMessageId'>,
): boolean {
  return !flow.originalMessageId;
}

export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  /**
   * 任务凭据（人类发起该任务时的原始消息 id）。
   *
   * **双用途字段**，改它之前必须知道两件事：
   * ① 它是同话题「上一个任务」与「新任务」的唯一物理区分依据（匹配用）；
   * ② 它还被 `lifecycle-runner` / `product-revision-runner` 当作**回复目标消息 id**。
   * 因此**缺凭据的行不能靠「合成一个占位值」来标记** —— 那会让 ② 去回一条不存在的消息；
   * 缺凭据这一事实本身就足够了（见 `isCredentiallessRow`）。
   */
  originalMessageId?: string;
  cardMessageId?: string;
  replyInThread?: boolean;
  request: ProductSpecRequest;
  /** 底层 Docx 文档 obj_token（Wiki 穿透底盘代币，保障划词评论承接与交付回写不脱靶） */
  objToken?: string;
  status: 'pending' | 'approved' | 'expired' | 'rejected';
  approvedAt?: string;
  rejectedAt?: string;
  revisionNotes?: string;
  /** 四阶段生命周期；缺省按 'pending' 处理（兼容历史落盘记录） */
  lifecycle?: SpecLifecycle;
  /** 上一次生命周期跃迁的时间戳，停滞/归档巡检的计时基准 */
  lifecycleUpdatedAt?: number;
  /** 停滞休眠标记：休眠期间不主动打扰，人类任意交互即热激活 */
  quarantined?: boolean;
  acceptedAt?: string;
  /** 研发实施与验收简报（含回写云文档的结果） */
  devReport?: {
    summary: string;
    testPassed?: boolean;
    reportedAt: string;
    writtenBackToDocument: boolean;
  };
}

export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  originalMessageId?: string;
  cardMessageId?: string;
  replyInThread?: boolean;
  request: ProductSpecRequest;
  objToken?: string;
}

export type ProductSpecParsingResult = ToolCallInspection<ProductSpecRequest>;

export function findProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined {
  return inspectProductSpecRequest(toolCalls).request;
}

/**
 * 本函数是「终结工具入参检验」这一族的**发源地**：其余 7 个终结工具此前只有
 * `find*`，入参写错时模型收不到任何纠正提示。现该族的唯一实现已收敛到
 * `tool-call-inspection.ts`，此处只保留工具名与 schema 的绑定。
 */
export function inspectProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecParsingResult {
  return inspectToolCall(
    toolCalls,
    'request_spec_approval',
    ProductSpecRequestSchema,
  );
}

export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>();

  constructor(initialFlows: ProductSpecFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    for (const flow of this.flows.values()) {
      if (
        flow.taskId === options.taskId &&
        flow.botId === options.botId &&
        flow.status === 'pending'
      ) {
        flow.status = 'expired';
      }
    }
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      status: 'pending',
      lifecycle: 'pending',
      lifecycleUpdatedAt: Date.now(),
      quarantined: false,
      objToken: options.objToken,
    };
    if (!flow.originalMessageId) {
      // 新建行没有凭据是**异常**（说明凭据链在上游断了，而不是「存量」）：
      // 它会被 `isCredentiallessRow` 判为无凭据行而退出同话题匹配——这是 fail-closed 的正确方向，
      // 但**必须留下告警**，否则一次编码/传播错误会伪装成常态，
      // 直到该方案永远收不到交付回执、也永远不进归档时才被发现。
      console.warn(
        '[方案流] 新建方案行缺少任务凭据（凭据链在上游断裂）：该行将不参与同话题任务匹配',
      );
    }
    this.flows.set(flow.token, flow);
    return flow;
  }

  setObjToken(token: string, objToken: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow) return undefined;
    flow.objToken = objToken;
    this.flows.set(token, flow);
    return flow;
  }

  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 按云文档定位**需要响应评论**的方案流。
   *
   * 覆盖两态而不仅是 `pending`：
   * - `pending`：编制与探讨期的划词批注（原有行为）；
   * - `delivered`：业务观察期同样要保持「划词批注监听就绪」（PRD §2.2.1），
   *   否则观察期发现的缺陷无法回流。
   *
   * 若只认 `pending`，休眠（只可能落在 in_development/delivered）就永远没有事件可忽略，
   * 「本地忽略事件」的实现会退化成死代码。
   */
  findCommentRoutableByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.botId !== botId) continue;
      // 只要方案未归档、未废弃，全生命周期（pending 探讨期、in_development 研发期、delivered 待验收与观察期）均保持对评论的承接，
      // 直至人类在 delivered 卡片点击【立即归档并释放监听】或超时自动归档
      if (
        flow.lifecycle === 'archived' ||
        flow.status === 'expired' ||
        flow.status === 'rejected'
      ) {
        continue;
      }
      if (
        flow.request.deliveryMode === 'lark-doc' &&
        (documentToken(flow.request.documentUrl) === fileToken || flow.objToken === fileToken)
      )
        return flow;
    }
    return undefined;
  }

  findPendingByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (
        flow.botId === botId &&
        flow.status === 'pending' &&
        flow.request.deliveryMode === 'lark-doc' &&
        (documentToken(flow.request.documentUrl) === fileToken || flow.objToken === fileToken)
      )
        return flow;
    }
    return undefined;
  }

  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending') return undefined;
    flow.status = 'approved';
    flow.approvedAt = new Date().toISOString();
    return flow;
  }

  reject(token: string, revisionNotes?: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending') return undefined;
    flow.status = 'rejected';
    flow.rejectedAt = new Date().toISOString();
    flow.revisionNotes = revisionNotes;
    return flow;
  }

  /**
   * 应用一次生命周期跃迁。
   *
   * 非法跃迁返回 undefined 而非静默 no-op：调用点必须把「这一步走不通」回告人类，
   * 否则归档按钮会变成一个点了没反应、也没有任何解释的死按钮。
   */
  transitionLifecycle(
    token: string,
    event: LifecycleEvent,
  ): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow) return undefined;
    const next = nextLifecycle(flow.lifecycle ?? 'pending', event);
    if (!next) return undefined;

    flow.lifecycle = next;
    flow.lifecycleUpdatedAt = Date.now();
    if (event === 'accepted') flow.acceptedAt = new Date().toISOString();
    // 休眠与唤醒只改标记，不改阶段；任何非休眠事件都视作一次活动，自动解除休眠
    flow.quarantined = event === 'stale_quarantine';
    this.flows.set(token, flow);
    return flow;
  }

  /**
   * 归档收口：**跃迁与删除必须在同一次落盘内完成**。
   *
   * 分两次写会留下一个崩溃窗口：跃迁已落盘（lifecycle=archived）而删除未落盘，
   * 重启后这一行会被 findLatestByTaskId / findPendingByTaskId 重新找到 ——
   * 即「已归档的方案复活」，而所有 finder 都不看 lifecycle，无法自愈。
   */
  archive(token: string, event: LifecycleEvent): ProductSpecFlow | undefined {
    const flow = this.transitionLifecycle(token, event);
    if (!flow) return undefined;
    this.flows.delete(token);
    return flow;
  }

  /** 记录研发实施与验收简报（单独落盘，避免只存在于内存而随重启丢失） */
  recordDevReport(
    token: string,
    report: NonNullable<ProductSpecFlow['devReport']>,
  ): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow) return undefined;
    flow.devReport = report;
    flow.lifecycleUpdatedAt = Date.now();
    this.flows.set(token, flow);
    return flow;
  }

  listAll(): ProductSpecFlow[] {
    return [...this.flows.values()];
  }

  delete(token: string): boolean {
    return this.flows.delete(token);
  }

  /**
   * 级联清理：链路被终止/熔断时必须回收该任务的全部方案流。
   *
   * 与 `create()` 内部的同任务过期语义不同——那是「换一份新方案」，
   * 这是「这个任务不存在了」，因此连同已批准记录一并清除，
   * 避免同话题的下个任务从 `findLatestByTaskId` 里拿到上一个任务的权威方案指针。
   */
  deleteByTaskId(
    taskId: string,
    options: { includeHumanPending?: boolean } = {},
  ): number {
    let removed = 0;
    for (const flow of [...this.flows.values()]) {
      if (flow.taskId !== taskId) continue;
      // `pending` = 人类终审卡正摆在面前。链路熔断不该把它变成点了没反应的死按钮，
      // 那会让人类以为自己错过了什么。只有「人类明确终止任务」才连它一起回收。
      if (flow.status === 'pending' && !options.includeHumanPending) continue;
      this.flows.delete(flow.token);
      removed += 1;
    }
    return removed;
  }

  /**
   * 该任务是否仍有待人类确认的方案（用于抑制链路谎报完成）。
   *
   * 必须按任务凭据过滤：`taskId` 是话题级哈希，同一话题里**上一个任务**遗留的 pending 方案流
   * 会被下一个任务命中，导致把「已完成的任务 B」误判为未收敛而永久抑制其完成通知。
   * 语义与 `TechReviewFlowStore.findPendingByTaskId` 保持一致。
   *
   * 本查找器是**任务级**查询：无凭据行（`isCredentiallessRow`）一律不参与，
   * 即使调用方没有提供凭据 —— 它们不对应任何当前任务，返回它们只会制造跨任务污染。
   */
  findPendingByTaskId(
    taskId: string,
    options: { originMessageId?: string } = {},
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.taskId !== taskId || flow.status !== 'pending') continue;
      if (isCredentiallessRow(flow)) continue;
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

  /**
   * 取该任务**当前**的权威方案（用于向下游注入权威方案指针）。
   *
   * 必须按任务凭据过滤：`taskId` 是话题级哈希，同一话题里上一个任务的已批准方案
   * 会永远排在当前任务之前（approvedAt 更大），从而向下游注入**错误**的方案指针——
   * 那比留空更糟，直接违背胶囊「单一真理源」的初衷。
   *
   * 同为**任务级**查询：无凭据行不参与（理由见 `isCredentiallessRow`）。
   */
  findLatestByTaskId(
    taskId: string,
    options: { originMessageId?: string } = {},
  ): ProductSpecFlow | undefined {
    const statusRank = (flow: ProductSpecFlow): number =>
      flow.status === 'pending' ? 2 : flow.status === 'approved' ? 1 : 0;
    const lifecycleRank = (flow: ProductSpecFlow): number => {
      // 正在研发或编制中的活跃方案优先于已交付结项或归档的历史方案
      if (flow.lifecycle === 'in_development') return 3;
      if (flow.lifecycle === 'pending' || !flow.lifecycle) return 2;
      if (flow.lifecycle === 'delivered') return 1;
      return 0; // archived
    };

    let best: ProductSpecFlow | undefined;
    for (const flow of this.flows.values()) {
      if (flow.taskId !== taskId) continue;
      // 存量行没有任务凭据，**不等于**凭据匹配：它们不得参与任何「同话题任务匹配」，
      // 否则同话题下发新任务时会把上一个任务的方案指针注入下游
      if (isCredentiallessRow(flow)) continue;
      // 双方都有凭据且不一致 → 属同话题的另一个任务，不得注入
      if (
        options.originMessageId &&
        flow.originalMessageId &&
        flow.originalMessageId !== options.originMessageId
      ) {
        continue;
      }

      if (!best) {
        best = flow;
        continue;
      }

      const sDiff = statusRank(flow) - statusRank(best);
      if (sDiff > 0) {
        best = flow;
      } else if (sDiff === 0) {
        const lDiff = lifecycleRank(flow) - lifecycleRank(best);
        if (lDiff > 0) {
          best = flow;
        } else if (lDiff === 0) {
          const flowTime = flow.lifecycleUpdatedAt ?? (flow.approvedAt ? Date.parse(flow.approvedAt) : 0);
          const bestTime = best.lifecycleUpdatedAt ?? (best.approvedAt ? Date.parse(best.approvedAt) : 0);
          if (flowTime >= bestTime) {
            best = flow;
          }
        }
      }
    }
    return best;
  }

  protected snapshot(): ProductSpecFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  protected restore(flows: ProductSpecFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}

/** 从飞书云文档或知识空间 URL 中解析 document_id 或 node_token（唯一权威真源） */
export function documentToken(documentUrl: string): string | undefined {
  try {
    const match = /\/(?:docx|wiki)\/([A-Za-z0-9_-]+)/.exec(
      new URL(documentUrl).pathname,
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}
