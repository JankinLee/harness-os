import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextCapsule } from './collaboration.js';

/**
 * 上下文谱系节点（不可变）。
 *
 * 从「一次性投递物」转向「可追溯谱系」的关键：每次派发产生一个**派生节点**，
 * 通过 `parentNodeId` 指向上游节点，因此可以回答三类此前答不了的问题：
 * ① 第 N 跳看到的与第 1 跳是否一致？② 某个结论是哪一跳引入的？③ 断链断在哪一跳？
 *
 * 节点的**不可变**是刻意的：需要续接时追加新节点，**永不修改旧节点**（M12 单一真理源）。
 */
export interface CapsuleNode {
  /** 节点标识（派发节点 = dispatchId，消费节点 = `consume:<dispatchId>`） */
  nodeId: string;
  /** 派生来源：本节点由哪个上游节点派生而来（链的起点为空） */
  parentNodeId?: string;
  /** 节点类型：派发（供给）或消费（下游实际读取） */
  event: 'dispatch' | 'consume';
  taskId: string;
  /**
   * 任务凭据（人类原始消息 id）。
   *
   * **必须随节点保存**：`taskId` 是话题级哈希，同话题里的第二个任务会得到完全相同的 taskId。
   * 若派生链只按 `taskId + fromBotId` 匹配，同一 Bot 先后处理两个任务时，
   * 第二条链会被静默焊接到第一条链的节点上——而日志里没有凭据字段，事后**无法检出**。
   */
  originMessageId?: string;
  fromBotId: string;
  toBotId: string;
  recordedAt: string;
  capsule: ContextCapsule;
  renderedLength: number;
  /**
   * 决策摘要的**署名**：摘要由谁提供。
   * 总线不编造摘要，但也不能假装摘要一定可信——署名让「谁写的」可追溯，
   * 而不是靠一句「总线不编造」的纪律去担保内容为真。
   */
  summaryAuthor?: string;
}

/** 兼容旧字段名（历史日志里写的是 dispatchId） */
interface LegacyCapsuleLogEntry {
  dispatchId?: string;
  taskId: string;
  fromBotId: string;
  toBotId: string;
  recordedAt: string;
  capsule: ContextCapsule;
  renderedLength: number;
}

/**
 * 上下文谱系日志：**只读快照 + 有界追加**。
 *
 * 三条设计约束：
 * 1. **只读快照**：记录的是派发时刻的供给事实，不是可变状态的第二份真源（M12）；
 * 2. **有界**：只保留最近 `maxEntries` 条，避免无限膨胀成新的算力泄漏；
 * 3. **失败不阻断派发**：日志是观测设施，绝不能因为写盘失败而让协作链断掉。
 */
export class CapsuleLog {
  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 400,
  ) {}

  append(node: CapsuleNode): void {
    try {
      const nodes = this.load();
      nodes.push(node);
      const bounded = nodes.slice(-this.maxEntries);
      mkdirSync(dirname(this.filePath), { recursive: true });
      // 原子写：先写临时文件再 rename。整文件重写若被 kill/断电截断，
      // 留下的半截 JSON 会让下一次 load 解析失败 —— 再下一次 append 便以空数组覆盖，
      // 整个审计历史被静默抹掉，而这套设施存在的唯一理由就是"事后可归因"。
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(bounded, null, 2)}\n`, 'utf8');
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      console.warn('[胶囊日志] 写入失败（不阻断派发）:', (error as Error).message);
    }
  }

  load(): CapsuleNode[] {
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.warn('[胶囊日志] 读取失败:', (error as Error).message);
      return [];
    }
    try {
      const rows: unknown = JSON.parse(content);
      return Array.isArray(rows)
        ? (rows as Array<CapsuleNode | LegacyCapsuleLogEntry>).map(normalizeNode)
        : [];
    } catch (error) {
      // 解析失败**不得**静默返回空数组：下一次 append 会以空为基底整文件覆盖，
      // 把损坏但可能仍可人工抢救的历史一并抹掉。先留档，再以空历史继续。
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        writeFileSync(backupPath, content, 'utf8');
        console.warn(
          `[胶囊日志] 内容损坏，已留档至 ${backupPath} 并以空历史继续:`,
          (error as Error).message,
        );
      } catch (backupError) {
        console.warn(
          '[胶囊日志] 内容损坏且留档失败:',
          (backupError as Error).message,
        );
      }
      return [];
    }
  }

  /** 按任务检索谱系（审计某条链一路看到了什么） */
  findByTaskId(taskId: string): CapsuleNode[] {
    return this.load().filter((node) => node.taskId === taskId);
  }

  /**
   * 求「本 Bot 在这条链上最近消费过的节点」——即下一个派发节点的派生来源。
   *
   * 从日志自身推导而不额外维护内存状态：状态一旦与日志分家，
   * 就会出现「日志说 A、内存说 B」的两份真相。
   */
  findLastConsumedBy(
    taskId: string,
    botId: string,
    options: { originMessageId?: string } = {},
  ): CapsuleNode | undefined {
    const nodes = this.load();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]!;
      if (node.taskId !== taskId || node.event !== 'consume') continue;
      if (node.fromBotId !== botId) continue;
      // 双方都有凭据且不同 → 属同话题的另一个任务，不得焊接（与其余查找器同构）
      if (
        options.originMessageId &&
        node.originMessageId &&
        node.originMessageId !== options.originMessageId
      ) {
        continue;
      }
      return node;
    }
    return undefined;
  }
}

/** 把历史日志条目补齐为节点模型（缺 nodeId / event 的旧记录按派发节点处理） */
function normalizeNode(row: CapsuleNode | LegacyCapsuleLogEntry): CapsuleNode {
  if ('nodeId' in row && typeof row.nodeId === 'string') return row;
  const legacy = row as LegacyCapsuleLogEntry;
  return {
    nodeId: legacy.dispatchId ?? `legacy-${legacy.recordedAt}`,
    event: 'dispatch',
    taskId: legacy.taskId,
    fromBotId: legacy.fromBotId,
    toBotId: legacy.toBotId,
    recordedAt: legacy.recordedAt,
    capsule: legacy.capsule,
    renderedLength: legacy.renderedLength,
  };
}
