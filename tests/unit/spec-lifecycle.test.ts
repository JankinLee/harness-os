import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLE_ARCHIVE_MS,
  LIFECYCLE_STALE_MS,
  ProductSpecFlowStore,
  nextLifecycle,
  planLifecycleSweep,
  selectStaleDelivered,
  type SpecLifecycle,
} from '../../src/core/product-spec.js';
import {
  buildDeliveryReviewCard,
  buildGovernanceCard,
  buildProductSpecArchivedCard,
} from '../../src/im/card.js';

function makeFlow(store: ProductSpecFlowStore) {
  return store.create({
    taskId: 'task-life',
    botId: 'product',
    sessionId: 's-1',
    ownerOpenId: 'ou_owner',
    request: {
      deliveryMode: 'local',
      title: '生命周期方案',
      summary: '验证四阶段治理',
      specPath: '.scratch/x/spec.md',
      ticketsPath: '.scratch/x/tickets.md',
    },
  });
}

test('批次五 · 四阶段转移表：合法路径全部可达，非法路径一律拒绝', () => {
  // 主干路径：待确认 → 研发中 → 已交付 → 已归档
  assert.equal(nextLifecycle('pending', 'approved'), 'in_development');
  assert.equal(nextLifecycle('in_development', 'dev_delivered'), 'delivered');
  assert.equal(nextLifecycle('delivered', 'accepted'), 'delivered');
  assert.equal(nextLifecycle('delivered', 'manual_archive'), 'archived');
  assert.equal(nextLifecycle('delivered', 'command_archive'), 'archived');
  assert.equal(nextLifecycle('delivered', 'auto_archive'), 'archived');

  // 打回归正：验收未通过必须真的退回研发阶段
  assert.equal(nextLifecycle('delivered', 'rejected'), 'in_development');

  // 非法路径：未批准不得直接交付/验收
  assert.equal(nextLifecycle('pending', 'dev_delivered'), undefined);
  assert.equal(nextLifecycle('pending', 'accepted'), undefined);
  // 未交付不得验收
  assert.equal(nextLifecycle('in_development', 'accepted'), undefined);
  assert.equal(nextLifecycle('in_development', 'rejected'), undefined);
});

test('批次五 · 归档是终态：任何事件都不得复活它', () => {
  const events = [
    'approved',
    'dev_delivered',
    'accepted',
    'rejected',
    'wake',
    'stale_quarantine',
    'manual_archive',
  ] as const;
  for (const event of events) {
    assert.equal(
      nextLifecycle('archived', event),
      undefined,
      `已归档流程不得响应 ${event}`,
    );
  }
});

test('批次五 · 停滞/归档巡检判定是纯函数且可穷举', () => {
  const base = { acceptedAt: undefined } as const;
  const now = 10 * LIFECYCLE_ARCHIVE_MS;

  // 研发中且静默超过 7 天 → 停滞休眠
  assert.equal(
    planLifecycleSweep(
      { ...base, lifecycle: 'in_development', lifecycleUpdatedAt: now - LIFECYCLE_STALE_MS },
      now,
    ),
    'quarantine',
  );
  assert.equal(
    planLifecycleSweep(
      {
        ...base,
        lifecycle: 'in_development',
        lifecycleUpdatedAt: now - LIFECYCLE_STALE_MS + 1,
      },
      now,
    ),
    'none',
  );

  // 已交付且静默超过 14 天 → 自动归档
  assert.equal(
    planLifecycleSweep(
      { ...base, lifecycle: 'delivered', lifecycleUpdatedAt: now - LIFECYCLE_ARCHIVE_MS },
      now,
    ),
    'archive',
  );
  // 已交付：**两档递进** —— 7 天先入停滞休眠（PRD §2.2.3 的原始对象），14 天才自动归档。
  // 曾把 7 天窗口错挂在 in_development 上，导致观察期挂起这个真实痛点完全没被覆盖。
  assert.equal(
    planLifecycleSweep(
      {
        ...base,
        lifecycle: 'delivered',
        lifecycleUpdatedAt: now - LIFECYCLE_STALE_MS,
      },
      now,
    ),
    'quarantine',
  );
  assert.equal(
    planLifecycleSweep(
      {
        ...base,
        lifecycle: 'delivered',
        lifecycleUpdatedAt: now - LIFECYCLE_STALE_MS + 1,
      },
      now,
    ),
    'none',
  );
  assert.equal(
    planLifecycleSweep(
      {
        ...base,
        lifecycle: 'delivered',
        lifecycleUpdatedAt: now - LIFECYCLE_ARCHIVE_MS + 1,
      },
      now,
    ),
    'quarantine',
    '距归档还差一天时应停在休眠档，而不是直接归档',
  );

  // 已归档 → 永不重复动作
  assert.equal(
    planLifecycleSweep(
      { ...base, lifecycle: 'archived', lifecycleUpdatedAt: 0 },
      now,
    ),
    'none',
  );

  // 历史落盘记录没有 lifecycleUpdatedAt：必须 fail-open 到「刚刚活动过」，
  // 否则升级重启的瞬间所有旧方案会被集体判定为停摆
  assert.equal(
    planLifecycleSweep({ ...base, lifecycle: 'in_development' }, now),
    'none',
  );
});

test('批次五 · 三通道归档共用同一跃迁语义', () => {
  for (const event of ['manual_archive', 'command_archive', 'auto_archive'] as const) {
    const store = new ProductSpecFlowStore();
    const flow = makeFlow(store);
    store.transitionLifecycle(flow.token, 'approved');
    store.transitionLifecycle(flow.token, 'dev_delivered');
    const archived = store.transitionLifecycle(flow.token, event);
    assert.equal(
      archived?.lifecycle,
      'archived',
      `${event} 必须与其他通道得到同一终态`,
    );
    // 归档后不得再响应任何事件
    assert.equal(store.transitionLifecycle(flow.token, 'wake'), undefined);
  }
});

test('批次五 · 打回归正退回研发并重新计时', () => {
  const store = new ProductSpecFlowStore();
  const flow = makeFlow(store);
  store.transitionLifecycle(flow.token, 'approved');
  store.transitionLifecycle(flow.token, 'dev_delivered');
  assert.equal(store.get(flow.token)?.lifecycle, 'delivered');

  const rejected = store.transitionLifecycle(flow.token, 'rejected');
  assert.equal(rejected?.lifecycle, 'in_development');
  // 退回即重新计时：否则刚被打回的方案会立刻又被判为停滞
  assert.ok((rejected?.lifecycleUpdatedAt ?? 0) >= flow.lifecycleUpdatedAt!);
  assert.equal(rejected?.acceptedAt, undefined);
});

test('批次五 · 验收通过记录 acceptedAt 但保持已交付（两段式验收的第一段）', () => {
  const store = new ProductSpecFlowStore();
  const flow = makeFlow(store);
  store.transitionLifecycle(flow.token, 'approved');
  store.transitionLifecycle(flow.token, 'dev_delivered');

  const accepted = store.transitionLifecycle(flow.token, 'accepted');
  assert.equal(accepted?.lifecycle, 'delivered');
  assert.ok(accepted?.acceptedAt);
});

test('批次五 · 停滞休眠与热激活：休眠不销毁上下文', () => {
  const store = new ProductSpecFlowStore();
  const flow = makeFlow(store);
  store.transitionLifecycle(flow.token, 'approved');

  const sleeping = store.transitionLifecycle(flow.token, 'stale_quarantine');
  assert.equal(sleeping?.quarantined, true);
  assert.equal(sleeping?.lifecycle, 'in_development');

  const woken = store.transitionLifecycle(flow.token, 'wake');
  assert.equal(woken?.quarantined, false);
  // 唤醒后方案流仍在，且请求内容完整保留 —— 这就是「不销毁上下文」
  assert.equal(woken?.lifecycle, 'in_development');
  assert.equal(woken?.request.title, '生命周期方案');
});

test('批次五 · 交付验收卡包含打回归正，且符合 Schema 2.0', () => {
  const store = new ProductSpecFlowStore();
  const flow = makeFlow(store);
  store.transitionLifecycle(flow.token, 'approved');
  const delivered = store.transitionLifecycle(flow.token, 'dev_delivered')!;

  const card = buildDeliveryReviewCard({
    flow: delivered,
    devSummary: '已完成实现并全量通过测试',
    testPassed: true,
  });
  const json = JSON.stringify(card);
  assert.match(json, /确认业务验收/);
  assert.match(json, /打回归正（退回研发）/);
  assert.match(json, /reject_delivery/);
  assert.match(json, /archive_spec/);
  assert.match(json, /已交付待验收|研发实施中/);
  // Schema 2.0：严禁 textarea，输入组件统一用 input
  assert.doesNotMatch(json, /textarea/);
  assert.match(json, /"tag":"input"/);
});

test('批次五 · 归档卡渲染归档通道', () => {
  const store = new ProductSpecFlowStore();
  const flow = makeFlow(store);
  const card = buildProductSpecArchivedCard(flow, '/archive 命令归档');
  const json = JSON.stringify(card);
  assert.match(json, /方案已归档 · 监听已释放/);
  assert.match(json, /\/archive 命令归档/);
  assert.match(json, /归档是终态/);
});

test('批次五 · 生命周期常量语义（7 天休眠 / 14 天归档）', () => {
  assert.equal(LIFECYCLE_STALE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(LIFECYCLE_ARCHIVE_MS, 14 * 24 * 60 * 60 * 1000);
  assert.ok(LIFECYCLE_ARCHIVE_MS > LIFECYCLE_STALE_MS);

  // 所有阶段都必须落在四阶段枚举内
  const stages: SpecLifecycle[] = [
    'pending',
    'in_development',
    'delivered',
    'archived',
  ];
  assert.equal(new Set(stages).size, 4);
});

test('A2 · 超期判定是纯函数，且大盘与批量归档共用同一真源', () => {
  const store = new ProductSpecFlowStore();
  const flow = makeFlow(store);
  store.transitionLifecycle(flow.token, 'approved');
  store.transitionLifecycle(flow.token, 'dev_delivered');
  const delivered = store.get(flow.token)!;

  const staleMs = LIFECYCLE_STALE_MS;
  // 未到阈值 → 不算超期
  assert.equal(
    selectStaleDelivered([delivered], (delivered.lifecycleUpdatedAt ?? 0) + staleMs - 1, staleMs)
      .length,
    0,
  );
  // 刚到阈值 → 超期
  assert.equal(
    selectStaleDelivered([delivered], (delivered.lifecycleUpdatedAt ?? 0) + staleMs, staleMs)
      .length,
    1,
  );
  // 研发中的方案不算「超期未验收」——那是停滞，不是超期
  const fresh = makeFlow(store);
  store.transitionLifecycle(fresh.token, 'approved');
  const developing = store.get(fresh.token)!;
  assert.equal(
    selectStaleDelivered([developing], Number.MAX_SAFE_INTEGER, staleMs).length,
    0,
  );
});

test('A2 · 治理大盘卡渲染三类信息，且只在有超期时给出批量归档按钮', () => {
  const stale = [
    {
      token: 't1',
      title: '【product】上一轮方案',
      taskId: 'task-abcdef123456',
      idleDays: 9,
    },
  ];
  const card = buildGovernanceCard({
    staleFlows: stale,
    activeFlows: [{ title: '【product】在生方案', stage: '研发实施中', taskId: 't2' }],
    capsuleEntries: [
      {
        recordedAt: '2026-09-17T00:00:00.000Z',
        fromBotId: 'ceo-assistant',
        toBotId: 'developer',
        taskId: 't3',
        objective: '探查协作总线接缝',
        event: 'dispatch' as const,
        nodeId: 'node-0001',
        // 链起点必须由调用方按完整窗口显式判定：缺省不得渲染成「链起点」，
        // 否则窗口滚走后中段节点会被显示成链首（界面输出可证伪的假话）
        isChainHead: true,
      },
      {
        recordedAt: '2026-09-17T00:01:00.000Z',
        fromBotId: 'developer',
        toBotId: 'ceo-assistant',
        taskId: 't3',
        objective: '探查协作总线接缝',
        event: 'consume' as const,
        nodeId: 'consume:node-0001',
        parentNodeId: 'node-0001',
        summaryAuthor: 'ceo-assistant',
      },
    ],
  });
  const json = JSON.stringify(card);
  assert.match(json, /治理大盘 · 生命周期与上下文供给/);
  assert.match(json, /超期未验收/);
  assert.match(json, /在生方案/);
  assert.match(json, /最近上下文谱系/);
  assert.match(json, /ceo-assistant → developer/);
  // 谱系必须可追溯：派生关系与摘要署名都要显式呈现
  assert.match(json, /\[派发\]/);
  assert.match(json, /\[读取\]/);
  assert.match(json, /（链起点）/);
  assert.match(json, /派生自 node-000/);
  assert.match(json, /摘要署名 ceo-assistant/);
  assert.match(json, /archive_stale_specs/);
  // Schema 2.0：禁止 textarea
  assert.doesNotMatch(json, /textarea/);

  // 无超期时不出现批量归档按钮（避免一个点了没反应的按钮）
  const empty = JSON.stringify(
    buildGovernanceCard({ staleFlows: [], activeFlows: [], capsuleEntries: [] }),
  );
  assert.doesNotMatch(empty, /archive_stale_specs/);
  assert.match(empty, /（无）/);
});
