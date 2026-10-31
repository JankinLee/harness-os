import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ArbitrationFlowStore,
  type ArbitrationFlow,
  type ArbitrationStatus,
  type ArbitrationVerdict,
} from './collaboration.js';

const ArbitrationFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  dispatchId: z.string().min(1).optional(),
  fromBotId: z.string().min(1),
  toBotId: z.string().min(1),
  reportToBotId: z.string().min(1),
  objective: z.string(),
  instruction: z.string(),
  contradictionReason: z.string(),
  round: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  negotiationRound: z.number().int().nonnegative().optional(),
  negotiationMaxRounds: z.number().int().positive().optional(),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  workspaceDir: z.string().min(1),
  originalMessageId: z.string().min(1).optional(),
  cardMessageId: z.string().min(1).optional(),
  replyInThread: z.boolean().optional(),
  tier: z.enum(['S', 'M', 'L']).optional(),
  escalations: z.number().int().nonnegative().optional(),
  status: z.enum([
    'pending_preliminary',
    'pending_human',
    'resolved',
    'suspended',
  ]),
  preliminaryVerdict: z
    .enum(['adopt_product', 'adopt_developer', 'abstain'])
    .optional(),
  preliminaryReasoning: z.string().optional(),
  preliminaryAt: z.iso.datetime().optional(),
  trigger: z.enum(['negotiation', 'escalation']).optional(),
  // narrative / createdAt / updatedAt 保持 optional：旧版本落盘的记录没有这几个字段，
  // 若设为必填会把历史仲裁整体判为非法而**静默丢弃**，比读不出来更糟。
  narrative: z.array(z.string()).optional(),
  lowRisk: z.boolean().optional(),
  riskReasons: z.array(z.string()).optional(),
  autoAdoptedAt: z.iso.datetime().optional(),
  selectedOption: z.string().optional(),
  customGuidance: z.string().optional(),
  resolvedAt: z.iso.datetime().optional(),
  suspendedAt: z.iso.datetime().optional(),
  createdAt: z.number().int().positive().optional(),
  updatedAt: z.number().int().positive().optional(),
});

/**
 * 仲裁流持久化存储。
 *
 * 仲裁是**跨天**的生命周期（24h 挂起窗口），而宿主是 watch 模式的热重载进程：
 * 纯内存态会在任意一次源码变更重启时把待决仲裁与仲裁叙事整体丢空，
 * 使人类收到的卡片变成一个点了没反应的死按钮。
 */
export class JsonArbitrationFlowStore extends ArbitrationFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(
    options: Parameters<ArbitrationFlowStore['create']>[0],
  ): ArbitrationFlow {
    return this.mutate(() => super.create(options));
  }

  override recordPreliminary(
    token: string,
    verdict: {
      verdict: ArbitrationVerdict;
      reasoning: string;
      lowRisk?: boolean;
      riskReasons?: string[];
    },
  ): ArbitrationFlow | undefined {
    return this.mutate(() => super.recordPreliminary(token, verdict));
  }

  override resolve(
    token: string,
    decision: {
      selectedOption?: string;
      customGuidance?: string;
      autoAdopted?: boolean;
    },
  ): ArbitrationFlow | undefined {
    return this.mutate(() => super.resolve(token, decision));
  }

  override suspend(token: string): ArbitrationFlow | undefined {
    return this.mutate(() => super.suspend(token));
  }

  override wake(token: string): ArbitrationFlow | undefined {
    return this.mutate(() => super.wake(token));
  }

  override deleteByTaskId(
    taskId: string,
    options: Parameters<ArbitrationFlowStore['deleteByTaskId']>[1] = {},
  ): number {
    // **必须转发 options**：此前只声明单参，而基类签名是双参 —— tsc 不报错、
    // 运行时静默丢参，于是「人类明确终止时连人类待办一起回收」在持久化层失效，
    // 被杀的链会在 24h 后按超时策略自动复活。
    return this.mutate(() => super.deleteByTaskId(taskId, options));
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

function loadFlows(filePath: string): ArbitrationFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`仲裁流状态文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ArbitrationFlowSchema.safeParse(row);
    if (!result.success) {
      // 绝不静默丢弃：一条解析失败会让人类手里的仲裁卡变成点了没反应的死按钮，
      // 而运营者在日志里看不到任何线索。
      console.warn(
        `[仲裁流] 丢弃无法解析的记录（schema 漂移或文件损坏）: ${result.error.issues.map((i) => i.path.join('.')).join(',')}`,
      );
      return [];
    }
    const flow = result.data;
    // 旧版本落盘的记录没有 narrative / createdAt，补齐后再作为实例状态装载，
    // 否则后续 push 会因 undefined 抛错而让整条仲裁链静默失效。
    const now = Date.now();
    return [
      {
        ...flow,
        status: flow.status as ArbitrationStatus,
        narrative: flow.narrative ?? [],
        createdAt: flow.createdAt ?? now,
        updatedAt: flow.updatedAt ?? now,
      },
    ];
  });
}
