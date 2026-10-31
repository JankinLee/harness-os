import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/app/scheduler.js';
import { ScheduleStore } from '../../src/core/schedule-store.js';
import { ScheduleRunStore, type ScheduledRun } from '../../src/core/schedule-run-store.js';
import { createScheduledTask, type ScheduledTask } from '../../src/core/schedule.js';
import { buildScheduleRunCard } from '../../src/im/card.js';
import { deliverScheduleReceipt } from '../../src/app/schedule-delivery.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { CardJson } from '../../src/im/card.js';

/** 只捕获投递行为的假 Bot —— 本组用例断言的是「有没有送达、送达了什么」。 */
function makeFakeRuntime(options: {
  sessionStatus?: 'idle' | 'active';
  failSend?: boolean;
  omitBot?: boolean;
}) {
  const sent: Array<{ chatId: string; card: CardJson }> = [];
  const bot = {
    async sendCardToChat(chatId: string, card: CardJson) {
      if (options.failSend) throw new Error('飞书 API 不可用');
      sent.push({ chatId, card });
      return 'om_fake_message';
    },
  };
  const botRuntimes = new Map<string, unknown>();
  if (!options.omitBot) {
    botRuntimes.set('developer', {
      config: { id: 'developer', role: '开发工程师' },
      bot,
    });
  }
  const runtime = {
    botRuntimes,
    teamRegistry: {
      get: (id: string) => (id === 'developer' ? { id, workspaceDir: '/workspace/harness-os' } : undefined),
      contextFor: () => '团队上下文',
    },
    workspaceResolver: { getAlias: () => 'harness-os' },
    sessions: {
      resolve: async () => ({
        session: { id: 'sess-1', status: options.sessionStatus ?? 'idle' },
        isNew: false,
      }),
      transition: async () => ({ id: 'sess-1', status: 'active' }),
    },
  } as unknown as AppRuntime;
  return { runtime, sent };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return createScheduledTask({
    id: 'task-daily-audit',
    creatorOpenId: 'ou_owner',
    chatId: 'oc_target_chat',
    targetBotId: 'developer',
    prompt: '每日系统健康审计：检查各组件错误率并输出结论报告。',
    rule: { kind: 'interval', everyMs: 3_600_000 },
    ...overrides,
  });
}

function makeRun(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: 'run-1',
    scheduleId: 'task-daily-audit',
    scheduledFor: '2026-09-18T04:00:00.000Z',
    startedAt: '2026-09-18T04:00:00.100Z',
    completedAt: '2026-09-18T04:02:30.000Z',
    status: 'succeeded',
    ...overrides,
  };
}

function cardText(card: CardJson): string {
  return JSON.stringify(card);
}

test('调度回执：成功后必须向任务绑定会话投递，且带执行者/耗时/结论', async () => {
  const { runtime, sent } = makeFakeRuntime({});
  await deliverScheduleReceipt({
    runtime,
    task: makeTask(),
    run: makeRun(),
    answer: '审计完成：三处错误率上升，已生成报告。',
    durationMs: 150_000,
  });

  assert.equal(sent.length, 1, '成功分支必须投递回执');
  assert.equal(sent[0].chatId, 'oc_target_chat', '必须投递到任务绑定的会话，而不是聊天列表');
  const text = cardText(sent[0].card);
  assert.match(text, /开发工程师/);
  assert.match(text, /developer/);
  assert.match(text, /150\.0s/);
  assert.match(text, /审计完成/);
});

test('调度回执：失败同样必须投递 —— 失败恰恰是最需要被看见的那条路径', async () => {
  const { runtime, sent } = makeFakeRuntime({});
  await deliverScheduleReceipt({
    runtime,
    task: makeTask(),
    run: makeRun({ status: 'failed', error: '目标 bot 当前会话仍在执行' }),
  });

  assert.equal(sent.length, 1);
  const text = cardText(sent[0].card);
  // 两条独立断言，不用 `|` 合并 —— 合并后任一条命中就通过，等于什么都没断言
  // （卡片 subtitle 里恒有 status=skipped/succeeded 字样，会把"带出真实错误"这条悄悄放过去）。
  assert.match(text, /failed/, '必须标出失败状态');
  assert.match(text, /目标 bot 当前会话仍在执行/, '必须带出真实失败原因，而不是只标一个红标');
});

test('调度回执卡片：没有 error 字段时不得虚构错误行', () => {
  const card = buildScheduleRunCard(makeRun({ status: 'failed' }), {});
  assert.doesNotMatch(cardText(card), /\*\*错误\*\*/);
});

test('调度回执：内置巡检的 system 占位地址不得投递', async () => {
  const { runtime, sent } = makeFakeRuntime({});
  await deliverScheduleReceipt({
    runtime,
    task: makeTask({ chatId: 'system' }),
    run: makeRun(),
    answer: '巡检完成',
  });
  assert.equal(sent.length, 0);
});

test('调度回执：投递失败绝不抛错，不得把成功的执行改判为失败', async () => {
  const { runtime } = makeFakeRuntime({ failSend: true });
  await assert.doesNotReject(async () => {
    await deliverScheduleReceipt({
      runtime,
      task: makeTask(),
      run: makeRun(),
      answer: 'ok',
    });
  });
});

test('调度回执：目标 Bot 未在运行时降级告警而不是崩溃', async () => {
  const { runtime, sent } = makeFakeRuntime({ omitBot: true });
  await assert.doesNotReject(async () => {
    await deliverScheduleReceipt({ runtime, task: makeTask(), run: makeRun() });
  });
  assert.equal(sent.length, 0);
});

test('调度回执卡片：无正文结论时如实声明，绝不编造摘要', () => {
  const card = buildScheduleRunCard(makeRun(), {
    taskPrompt: '每日系统健康审计',
    targetBotId: 'developer',
    targetRole: '开发工程师',
  });
  const text = cardText(card);
  assert.match(text, /无正文结论产出/);
  assert.match(text, /每日系统健康审计/);
});

test('调度回执：连续跳过只报第一跳（边沿触发），避免用卡片刷屏', async () => {
  const task = makeTask();
  const scheduleStore = new ScheduleStore([task]);
  // 已有一轮仍在执行 → 本轮必然走 skipped 分支
  const seedRunning: ScheduledRun[] = [
    {
      id: 'run-long',
      scheduleId: task.id,
      scheduledFor: '2026-09-17T01:00:00.000Z',
      startedAt: '2026-09-17T01:00:00.000Z',
      status: 'running',
    },
  ];

  // 第一跳：上一次是正常运行 → 必须报
  const first = makeFakeRuntime({});
  await new Scheduler({
    runtime: first.runtime,
    scheduleStore: new ScheduleStore([task]),
    runStore: new ScheduleRunStore(seedRunning.map((r) => ({ ...r }))),
    defaultProductDeliveryMode: 'local',
  }).runNow(task.id);
  assert.equal(first.sent.length, 1, '跳过必须让人知道，否则就是一个永远不响的任务');
  assert.match(cardText(first.sent[0].card), /上一轮仍在执行/);

  // 第二跳：上一次已经是 skipped → 不再重复刷屏
  const second = makeFakeRuntime({});
  await new Scheduler({
    runtime: second.runtime,
    scheduleStore: new ScheduleStore([task]),
    runStore: new ScheduleRunStore([
      ...seedRunning.map((r) => ({ ...r })),
      {
        id: 'run-prev-skip',
        scheduleId: task.id,
        scheduledFor: '2026-09-17T02:00:00.000Z',
        startedAt: '2026-09-17T02:00:00.000Z',
        completedAt: '2026-09-17T02:00:00.001Z',
        status: 'skipped',
        error: '上一轮仍在执行，本轮跳过',
      },
    ]),
    defaultProductDeliveryMode: 'local',
  }).runNow(task.id);
  assert.equal(second.sent.length, 0, '连续跳过只报第一跳');
});

test('调度回执：无手写调用点的渲染器必须真的被宿主调用（接线级断言）', async () => {
  // buildScheduleRunCard 曾经是**零调用点**的死代码 —— 渲染器存在不等于链路存在。
  // 本用例经真实 Scheduler 触发一次失败的调度执行，断言回执确实被投递出去。
  const { runtime, sent } = makeFakeRuntime({ sessionStatus: 'active' });
  const task = makeTask();
  const scheduleStore = new ScheduleStore([task]);
  const runStore = new ScheduleRunStore([]);
  const scheduler = new Scheduler({
    runtime,
    scheduleStore,
    runStore,
    defaultProductDeliveryMode: 'local',
  });

  await scheduler.runNow(task.id);

  assert.equal(sent.length, 1, '执行抛错后回执仍必须送达（finally 语义保证）');
  const text = cardText(sent[0].card);
  assert.match(text, /目标 bot 当前会话仍在执行/, '回执必须带出真实失败原因');
  // 运行记录同样落定，回执与状态机不得各说各话
  const runs = runStore.list(task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
});
