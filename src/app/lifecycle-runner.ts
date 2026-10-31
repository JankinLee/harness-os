import { dirname } from 'node:path';
import { archiveScratchFeature } from './scratch-archiver.js';
import type { Bot } from '../im/lark.js';
import {
  LIFECYCLE_ARCHIVE_MS,
  LIFECYCLE_STALE_MS,
  planLifecycleSweep,
  type LifecycleEvent,
  type ProductSpecFlow,
} from '../core/product-spec.js';
import { buildAlertCard, buildProductSpecArchivedCard } from '../im/card.js';
import { sendResultNotification } from './notification-service.js';
import type { AppRuntime } from './runtime.js';

/** 归档通道。三通道必须落在同一个实现上，否则它们会各自演化出不同语义。 */
export type ArchiveChannel = 'manual' | 'command' | 'auto' | 'dashboard';

const ARCHIVE_EVENT: Record<ArchiveChannel, LifecycleEvent> = {
  manual: 'manual_archive',
  command: 'command_archive',
  auto: 'auto_archive',
  // 管理大盘的批量归档与单条人工点击在语义上同类（都是人类显式操作），
  // 因此落到同一个事件上，避免再引入一个只有一处用到的生命周期事件。
  dashboard: 'manual_archive',
};

/**
 * 归档收口（**唯一实现**）。
 *
 * 人工点击、`/archive` 命令、14 天静默自动三条通道全部经由本函数，
 * 因此「释放监听、清理状态、通知人类」这三件事在任何通道下都必然同时发生——
 * 只要有一条通道自己写一遍，就会出现「有的归档释放了监听、有的没释放」的长期暗债。
 */
export async function archiveSpecFlow(options: {
  runtime: AppRuntime;
  /** 缺省时不发卡片，但仍必须完成状态跃迁、删除与订阅对账 */
  bot?: Bot;
  flow: ProductSpecFlow;
  channel: ArchiveChannel;
  reason?: string;
  /**
   * 是否由本函数推送归档卡。
   * 卡片按钮触发时为 false —— 那种场景下调用方会**原地更新**原卡片；
   * 再新发一张会让同一件事出现两张卡（而人类只点了一张）。
   */
  deliverCard?: boolean;
}): Promise<boolean> {
  const { runtime, flow } = options;
  // 跃迁与删除必须原子完成（见 ProductSpecFlowStore.archive 的注释）：
  // 分两次落盘会留下「已归档却仍在 Map 里」的崩溃窗口，重启后即复活。
  const archived = runtime.productSpecFlows.archive(
    flow.token,
    ARCHIVE_EVENT[options.channel],
  );
  if (!archived) {
    console.warn(
      `[生命周期] flow=${flow.token} 归档跃迁非法（当前阶段 ${flow.lifecycle ?? 'pending'}）`,
    );
    return false;
  }

  const channelLabel =
    options.channel === 'manual'
      ? '人工点击归档'
      : options.channel === 'command'
        ? '/archive 命令归档'
        : options.channel === 'dashboard'
          ? '管理大盘批量归档'
          : `${Math.round(LIFECYCLE_ARCHIVE_MS / 86_400_000)} 天静默自动归档`;

  const replyTarget = flow.cardMessageId ?? flow.originalMessageId;
  if (options.deliverCard !== false && options.bot && replyTarget) {
    await options.bot
      .replyCard(
        replyTarget,
        buildProductSpecArchivedCard(flow, channelLabel),
        flow.replyInThread ?? false,
      )
      .catch((error) => {
        // 归档状态已落库并已释放监听，卡片发送失败不应回滚这些事实，
        // 但必须留下痕迹 —— 静默吞掉会让「归档了却没人收到通知」无从排查。
        console.warn(
          `[生命周期] flow=${flow.token} 归档卡片发送失败:`,
          (error as Error).message,
        );
      });
  }
  console.log(
    `[生命周期] flow=${flow.token} 已归档（${channelLabel}）task=${flow.taskId}`,
  );

  // 物理草稿箱移送归档（Soft Archival · 彻底消除 Context Rot 与膨胀）
  if (flow.request.deliveryMode === 'local' && flow.request.specPath) {
    const specDir = dirname(flow.request.specPath);
    const result = archiveScratchFeature(specDir);
    if (!result.archived && result.error) {
      console.warn(`[生命周期] 特性软归档未执行或已降级: ${result.error}`);
    }
  }

  // 归档是「这份文档一生结束」的时刻，也是唯一该检查订阅是否还有存在必要的时刻
  await reconcileDocumentSubscription(runtime, flow.botId);
  return true;
}

/**
 * 订阅对账：有活跃（未归档）方案流时保持订阅，没有则退订。
 *
 * 这是「释放监听」的物理落点。缺少退订时，应用会随见过的文档数线性累积订阅，
 * 而每一条订阅都会持续投递事件、触发回调与队列查找——一个不会报错的算力泄漏。
 */
export async function reconcileDocumentSubscription(
  runtime: AppRuntime,
  botId: string,
): Promise<void> {
  const botRuntime = runtime.botRuntimes.get(botId);
  if (!botRuntime) return;
  if (!botRuntime.config.skills.includes('lark-drive')) return;

  // 判据必须是「还有没有需要听评论的方案」：归档行在 archive() 时即被删除，
  // 写 `lifecycle !== 'archived'` 是永远为真的空判据，会让退订分支形同虚设。
  //
  // 保持对所有未归档活跃方案（pending、in_development、delivered）的订阅；
  // 物理退订严格锚定在方案归档时刻（人类在 delivered 卡片点击【立即归档并释放监听】或 14 天静默归档）。
  const hasActive = runtime.productSpecFlows
    .listAll()
    .some(
      (flow) =>
        flow.botId === botId &&
        flow.lifecycle !== 'archived' &&
        flow.status !== 'expired' &&
        flow.status !== 'rejected',
    );

  try {
    if (hasActive) {
      await botRuntime.bot.subscribeToDocumentComments();
    } else {
      await botRuntime.bot.unsubscribeFromDocumentComments();
      console.log(`[云文档] bot=${botId} 已无活跃方案流，退订评论事件`);
    }
  } catch (error) {
    // 订阅/退订失败只降级为告警：它是资源优化，不是任务正确性的前置条件
    console.warn(
      `[云文档] 订阅对账失败 bot=${botId}:`,
      (error as Error).message,
    );
  }
}

/**
 * 交付回执：developer 完成实施回传时，把方案流推进到「已交付待验收」，
 * 并把研发实施简报**回写云文档**。
 *
 * 为什么回执判定放在宿主而不是让 developer 自己声明：
 * 「我交付了」是一个状态跃迁，不是一个可以自证的文案。
 * 宿主依据「消息确实来自 developer + 该任务确有处于研发中的方案流」两个物理事实判定，
 * 使跃迁不可被任意一段 LLM 文本触发。
 */
export async function markDeliveredFromDevReport(options: {
  runtime: AppRuntime;
  bot: Bot;
  taskId: string;
  fromBotId: string;
  credential?: string;
  summary: string;
  testPassed?: boolean;
}): Promise<ProductSpecFlow | undefined> {
  if (options.fromBotId !== 'developer') return undefined;

  const flow = options.runtime.productSpecFlows.findLatestByTaskId(
    options.taskId,
    { originMessageId: options.credential },
  );
  if (!flow || flow.lifecycle !== 'in_development') {
    // 留痕而非静默：交付回执落不到任何方案流，是链路断点最该被看见的时刻。
    // 尤其注意**无凭据的存量行不参与匹配**：它们永远不会收到交付回执，
    // 因此也永远不会走到 delivered（这正是 B-3「研发中无终态」的另一半事实）。
    console.log(
      `[交付回执] task=${options.taskId} 无处于研发中的方案流，跳过交付跃迁`,
    );
    return undefined;
  }

  // 回写必须用**方案归属 bot** 的凭证：标准链路是 ceo-assistant 汇总交付、
  // 而方案归属 product，用发起方的凭证写不进 product 的文档。
  // （曾经的写法是"不同源就跳过回写"，那等于让**正常路径**永远不回写。）
  const ownerRuntime = options.runtime.botRuntimes.get(flow.botId);
  const writeBackBot = ownerRuntime?.bot ?? options.bot;

  const delivered = options.runtime.productSpecFlows.transitionLifecycle(
    flow.token,
    'dev_delivered',
  );
  if (!delivered) return undefined;

  // 回写云文档：仅 lark-doc 交付方式有可写载体；local 方式产物本来就在工作区
  let writtenBack = false;
  if (flow.request.deliveryMode === 'lark-doc') {
    // 回写异常不得逃逸：跃迁已经落盘，异常冒泡会让调用方把成功当成失败，
    // 人类看到「执行失败」而磁盘上生命周期已是 delivered —— 自相矛盾且难以排查。
    writtenBack = await writeBackBot
      .appendDocumentSection({
      documentUrl: flow.request.documentUrl,
      heading: '研发实施与验收简报',
      body: [
        `交付时间：${new Date().toISOString()}`,
        // 三态而非二态：生产链路当前不传 testPassed，
        // 用 `!== false` 兜底会让回写正文永远写「已全绿通过」——拿未提供的字段当背书。
        options.testPassed === true
          ? '自动化测试与代码审查：已全绿通过'
          : options.testPassed === false
            ? '自动化测试与代码审查：部分待人工复验'
            : '自动化测试与代码审查：未提供（请以人工复核为准）',
        '',
        options.summary,
      ].join('\n'),
    });
  }

  // 必须走 store 落盘：直接赋值只改内存，要等下一次 mutate 才写盘，
  // 崩溃即丢失「是否成功回写云文档」这一事实。
  options.runtime.productSpecFlows.recordDevReport(delivered.token, {
    summary: options.summary,
    testPassed: options.testPassed,
    reportedAt: new Date().toISOString(),
    writtenBackToDocument: writtenBack,
  });
  console.log(
    `[生命周期] flow=${flow.token} 已交付待验收（云文档回写=${writtenBack ? '成功' : '未执行/失败'}）`,
  );
  return delivered;
}

/**
 * 停滞巡检（7 天休眠 / 14 天静默归档）。
 *
 * 判定交给纯函数 `planLifecycleSweep`，本函数只执行副作用——
 * 与仲裁巡检同构，使「什么时候该休眠、什么时候该归档」可被单测穷举。
 */
export async function sweepLifecycles(options: {
  runtime: AppRuntime;
  now?: number;
}): Promise<void> {
  const now = options.now ?? Date.now();
  for (const flow of options.runtime.productSpecFlows.listAll()) {
    const action = planLifecycleSweep(flow, now);
    if (action === 'none') continue;

    // 缺 bot 只意味着「发不出卡片」，不意味着「可以不动」——
    // 直接 continue 会让该流永远停在原地：既不清扫也不退订，成为无人知晓的悬挂状态。
    const bot = options.runtime.botRuntimes.get(flow.botId)?.bot;

    if (action === 'quarantine') {
      if (flow.quarantined) continue;
      const quarantined = options.runtime.productSpecFlows.transitionLifecycle(
        flow.token,
        'stale_quarantine',
      );
      if (!quarantined) continue;
      console.log(
        `[生命周期] flow=${flow.token} 研发阶段停滞超过 ${Math.round(LIFECYCLE_STALE_MS / 86_400_000)} 天，转入休眠`,
      );
      continue;
    }

    const archived = await archiveSpecFlow({
      runtime: options.runtime,
      bot,
      flow,
      channel: 'auto',
    });
    if (archived && bot) {
      await sendResultNotification({
        bot,
        replyToMessageId: flow.cardMessageId ?? flow.originalMessageId ?? '',
        target: { openId: flow.ownerOpenId, name: '' },
        text: `方案「${flow.request.title ?? ''}」交付后 ${Math.round(LIFECYCLE_ARCHIVE_MS / 86_400_000)} 天未有验收动作，已按生命周期策略自动归档并释放监听。`,
        replyInThread: flow.replyInThread ?? false,
      });
    }
  }
}

/**
 * 热激活：人类任意交互唤醒休眠中的方案流。
 * 契约与仲裁一致——**不销毁上下文**，唤醒后可直接续办。
 */
export async function wakeQuarantinedFlows(options: {
  runtime: AppRuntime;
  taskId: string;
}): Promise<number> {
  let woken = 0;
  for (const flow of options.runtime.productSpecFlows.listAll()) {
    if (flow.taskId !== options.taskId || !flow.quarantined) continue;
    const wokenFlow = options.runtime.productSpecFlows.transitionLifecycle(
      flow.token,
      'wake',
    );
    if (!wokenFlow) continue;
    woken += 1;
    const bot = options.runtime.botRuntimes.get(flow.botId)?.bot;
    const replyTarget = flow.cardMessageId ?? flow.originalMessageId;
    if (!bot || !replyTarget) continue;
    await bot
      .replyCard(
        replyTarget,
        buildAlertCard({
          title: '方案已热激活',
          template: 'orange',
          detail: `检测到你在话题中的交互，方案「${flow.request.title ?? ''}」已从停滞休眠中唤醒并重新计时。`,
        }),
        flow.replyInThread ?? false,
      )
      .catch(() => undefined);
  }
  return woken;
}
