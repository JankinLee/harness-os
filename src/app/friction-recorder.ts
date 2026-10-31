import { join } from 'node:path';
import { ExperienceCandidateStore } from '../core/experience-settlement.js';

/**
 * 全进程**唯一**的摩擦沉淀入口（M13）。
 *
 * 必须是单例：`ExperienceCandidateStore` 每次 `recordFriction` 都要先 `load()` 再 `save()`，
 * 两个实例各自持有视图时会互相覆盖计次——那会让「≥3 次自动沉淀」这条公理静默失效，
 * 而且是那种「计数看起来在涨、却永远到不了 3」的隐性失效。
 */
const store = new ExperienceCandidateStore(
  join('data', 'experience-candidates.json'),
);

export type FrictionCategory = Parameters<
  ExperienceCandidateStore['recordFriction']
>[0]['category'];

/** 串行队列：把并发调用排成链，杜绝 load→save 的读改写竞态（并发会丢计次） */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 记录一次摩擦。**永不抛出**：沉淀是观测设施，
 * 绝不能因为它自己写盘失败而让调用点（往往已经在错误处理路径上）二次崩溃。
 */

export function recordFriction(
  category: FrictionCategory,
  details: string,
  workspaceKey?: string,
): void {
  queue = queue
    .then(() =>
      store.recordFriction({
        category,
        details,
        workspaceKey,
        targetDcInboxDir: join('.scratch', 'dc-inbox'),
      }),
    )
    .catch((error) => {
      // 单例只保证「同一实例」，不保证并发安全 —— 而所有调用点都是火焰式发出，
      // 三次并发曾经只记到 1 次，使「≥3 次自动沉淀」永远达不到阈值。
      console.warn('[摩擦沉淀] 写入失败:', (error as Error).message);
    });
}
