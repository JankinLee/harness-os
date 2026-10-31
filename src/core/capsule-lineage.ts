import type { CapsuleLineage } from './collaboration.js';
import type { ProductSpecFlow, ProductSpecRequest } from './product-spec.js';

/** 从方案请求中提取权威产物指针（飞书云文档 URL 或本地 Spec 路径） */
export function specPointerOf(
  request: ProductSpecRequest | undefined,
): string | undefined {
  if (!request) return undefined;
  return request.deliveryMode === 'lark-doc'
    ? request.documentUrl
    : request.specPath;
}

/**
 * 求本话题的「承接来源」：最近一条**已交付**且**不属于当前任务**的方案流。
 *
 * 只搬运**确定性事实**（来源任务标识、方案指针、收口时间），
 * `note` 一律留空 —— 承接说明必须由上游 Bot 显式给出，总线不编造摘要。
 *
 * 两条硬约束（都踩过坑）：
 * 1. **只认 `delivered`**：`archived` 的行在 `archive()` 的同一次 mutate 内就被删除，
 *    `listAll()` 永远看不到它。把 `'archived'` 也列进条件是死代码，
 *    会让人误以为归档后仍能承接（代价是明确的边界：自动归档后承接能力消失）。
 * 2. **双方都有凭据且不同**才算「上一条链」。任一侧缺凭据就不比较 ——
 *    否则当前任务自己的流会因一侧 undefined 被当成承接来源，产出「承接自自己」的幻觉。
 *    写法与 `findLatestByTaskId` / `findPendingByTaskId` 保持一致。
 */
export function selectCapsuleLineage(options: {
  flows: ProductSpecFlow[];
  taskId: string;
  currentCredential: string;
}): CapsuleLineage | undefined {
  const settled = options.flows.filter(
    (flow) =>
      flow.taskId === options.taskId &&
      !flow.quarantined &&
      flow.lifecycle === 'delivered' &&
      Boolean(flow.originalMessageId) &&
      flow.originalMessageId !== options.currentCredential,
  );
  if (settled.length === 0) return undefined;

  const latest = settled.reduce((best, flow) =>
    (flow.lifecycleUpdatedAt ?? 0) > (best.lifecycleUpdatedAt ?? 0) ? flow : best,
  );
  return {
    sourceTaskId: latest.taskId,
    approvedSpecPointer: specPointerOf(latest.request),
    settledAt: latest.lifecycleUpdatedAt
      ? new Date(latest.lifecycleUpdatedAt).toISOString()
      : undefined,
  };
}
