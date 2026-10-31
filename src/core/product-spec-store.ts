import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ProductSpecRequestSchema,
  ProductSpecFlowStore,
  isCredentiallessRow,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from './product-spec.js';

const ProductSpecFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  // 协作溯源必须**整组**落盘：zod 默认会剥离未声明的键，
  // 此前只声明了 taskId/fromBotId/reportToBotId/round/maxRounds，
  // 导致 tier / escalations / originMessageId 在重启后被静默丢弃——
  // 而 `CollaborationOrigin.tier` 的注释正写着「必须随溯源一起持久化」。
  collaboration: z
    .object({
      taskId: z.string().min(1),
      fromBotId: z.string().min(1),
      reportToBotId: z.string().min(1),
      round: z.number().int().positive(),
      maxRounds: z.number().int().positive(),
      negotiationRound: z.number().int().nonnegative().optional(),
      negotiationMaxRounds: z.number().int().positive().optional(),
      intent: z.enum(['recon', 'implement']).optional(),
      tier: z.enum(['S', 'M', 'L']).optional(),
      escalations: z.number().int().nonnegative().optional(),
      originMessageId: z.string().min(1).optional(),
    })
    .optional(),
  lifecycle: z
    .enum(['pending', 'in_development', 'delivered', 'archived'])
    .optional(),
  lifecycleUpdatedAt: z.number().int().positive().optional(),
  quarantined: z.boolean().optional(),
  acceptedAt: z.iso.datetime().optional(),
  devReport: z
    .object({
      summary: z.string(),
      testPassed: z.boolean().optional(),
      reportedAt: z.string(),
      writtenBackToDocument: z.boolean(),
    })
    .optional(),
  request: ProductSpecRequestSchema,
  objToken: z.string().min(1).optional(),
  // 任务凭据必须落盘：它是 `findPendingByTaskId` 用来区分「同话题的另一个任务」的
  // 唯一物理凭据。一旦重启丢失，凭据过滤会退化为「无条件匹配」，
  // 让陈旧的 pending 流永久抑制新任务的完成通知（fail-closed 停滞的根因）。
  originalMessageId: z.string().min(1).optional(),
  cardMessageId: z.string().min(1).optional(),
  replyInThread: z.boolean().optional(),
  status: z.enum(['pending', 'approved', 'expired', 'rejected']),
  approvedAt: z.iso.datetime().optional(),
  rejectedAt: z.iso.datetime().optional(),
  revisionNotes: z.string().optional(),
});

export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options));
  }

  override approve(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token));
  }

  // reject 同样改变持久状态：此前未覆写，导致「人类驳回方案」在重启后被回滚成 pending，
  // 一条已被否决的方案会重新变成可批准的待审流。
  override reject(
    token: string,
    revisionNotes?: string,
  ): ProductSpecFlow | undefined {
    return this.mutate(() => super.reject(token, revisionNotes));
  }

  override delete(token: string): boolean {
    return this.mutate(() => super.delete(token));
  }

  override transitionLifecycle(
    token: string,
    event: Parameters<ProductSpecFlowStore['transitionLifecycle']>[1],
  ): ProductSpecFlow | undefined {
    return this.mutate(() => super.transitionLifecycle(token, event));
  }

  override deleteByTaskId(
    taskId: string,
    options: Parameters<ProductSpecFlowStore['deleteByTaskId']>[1] = {},
  ): number {
    // 同 arbitration-store：覆写必须转发 options，否则人机待办回收策略静默失效
    return this.mutate(() => super.deleteByTaskId(taskId, options));
  }

  override archive(
    token: string,
    event: Parameters<ProductSpecFlowStore['archive']>[1],
  ): ProductSpecFlow | undefined {
    return this.mutate(() => super.archive(token, event));
  }

  override recordDevReport(
    token: string,
    report: Parameters<ProductSpecFlowStore['recordDevReport']>[1],
  ): ProductSpecFlow | undefined {
    return this.mutate(() => super.recordDevReport(token, report));
  }

  override setObjToken(
    token: string,
    objToken: string,
  ): ProductSpecFlow | undefined {
    return this.mutate(() => super.setObjToken(token, objToken));
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      'utf8',
    );
    renameSync(temporaryPath, this.filePath);
  }
}

function loadFlows(filePath: string): ProductSpecFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`产品方案状态文件格式错误: ${filePath}`);
  }
  const flows = rows.flatMap((row) => {
    const result = ProductSpecFlowSchema.safeParse(row);
    if (!result.success) {
      console.warn(
        `[方案流] 丢弃无法解析的记录（schema 漂移或文件损坏）: ${result.error.issues.map((i) => i.path.join('.')).join(',')}`,
      );
      return [];
    }
    const flow = result.data;
    // 升级前落盘的行没有 lifecycle：按审批态**推导**初始阶段，逐态映射——
    //   approved           → in_development（正在研发）
    //   pending            → pending（等待人类确认）
    //   rejected / expired → archived（已终结）
    // 把最后两类也塞进 `pending` 曾是错的：它们既不会被清扫、也不会被归档，
    // 却会在治理大盘里被列成「在生方案」，永久占用人的注意力。
    const lifecycle =
      flow.lifecycle ??
      (flow.status === 'approved'
        ? 'in_development'
        : flow.status === 'pending'
          ? 'pending'
          : 'archived');
    return [
      {
        ...flow,
        lifecycle,
        // 补一个新鲜的计时起点：让迁移过来的行从此刻起算 7/14 天，
        // 而不是在升级重启的瞬间被集体判定为停滞。
        lifecycleUpdatedAt: flow.lifecycleUpdatedAt ?? Date.now(),
      },
    ];
  });

  const credentialless = flows.filter(isCredentiallessRow).length;
  if (credentialless > 0) {
    // 留痕而非静默：这是「存量行退出同话题匹配」的唯一可观测证据。
    // 注意本行**不能**作为退役判据 —— 「日志不出现」在「未部署本版本」与
    // 「存量行已清空」两种情形下表现相同（M8 的退役条件必须可判）。
    console.log(
      `[方案流] 检出 ${credentialless} 条无任务凭据的存量行：不参与同话题任务匹配`,
    );
  }
  return flows;
}
