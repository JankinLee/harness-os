import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  TechReviewFlowStore,
  type TechReviewFlow,
} from './collaboration.js';

const TechReviewFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  dispatchId: z.string().min(1).optional(),
  specFlowToken: z.string().min(1).optional(),
  specDocumentUrl: z.string().min(1).optional(),
  specPath: z.string().min(1).optional(),
  title: z.string(),
  summary: z.string(),
  productBotId: z.string().min(1),
  devBotId: z.string().min(1),
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  workspaceDir: z.string().min(1),
  comments: z.array(z.string()).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'arbitration_needed']),
  originMessageId: z.string().min(1).optional(),
  createdAt: z.number().int().positive().optional(),
  updatedAt: z.number().int().positive().optional(),
  resolvedAt: z.iso.datetime().optional(),
});

/**
 * Phase 3 技术审查流持久化存储。
 *
 * 与技术审查流同源的仲裁流已持久化，本流若仍为纯内存，会出现**半持久化**的错位状态：
 * 重启后仲裁流还在、被它引用的技术审查流却已消失，`submit_tech_review` 会拿到
 * "审查编号失效" 的误导性提示，运营者无法判断是编号错还是状态丢。
 */
export class JsonTechReviewFlowStore extends TechReviewFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(
    options: Parameters<TechReviewFlowStore['create']>[0],
  ): TechReviewFlow {
    return this.mutate(() => super.create(options));
  }

  override bindSpecFlow(
    token: string,
    spec: Parameters<TechReviewFlowStore['bindSpecFlow']>[1],
  ): TechReviewFlow | undefined {
    return this.mutate(() => super.bindSpecFlow(token, spec));
  }

  override recordFeedback(
    token: string,
    comment: string,
    approved: boolean,
  ): TechReviewFlow | undefined {
    return this.mutate(() => super.recordFeedback(token, comment, approved));
  }

  override deleteByTaskId(taskId: string): number {
    return this.mutate(() => super.deleteByTaskId(taskId));
  }

  override delete(token: string): boolean {
    return this.mutate(() => super.delete(token));
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

function loadFlows(filePath: string): TechReviewFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`技术审查流状态文件格式错误: ${filePath}`);
  }
  const now = Date.now();
  return rows.flatMap((row) => {
    const result = TechReviewFlowSchema.safeParse(row);
    if (!result.success) {
      console.warn(
        `[技术审查流] 丢弃无法解析的记录（schema 漂移或文件损坏）: ${result.error.issues.map((i) => i.path.join('.')).join(',')}`,
      );
      return [];
    }
    const flow = result.data;
    return [
      {
        ...flow,
        comments: flow.comments ?? [],
        createdAt: flow.createdAt ?? now,
        updatedAt: flow.updatedAt ?? now,
      },
    ];
  });
}
