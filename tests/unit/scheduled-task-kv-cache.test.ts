import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledTask } from '../../src/core/schedule.js';
import type { BotConfig } from '../../src/core/bot-registry.js';
import { buildScheduledTaskPrompt } from '../../src/app/scheduled-task-runner.js';

test('createScheduledTask supports workspace attribute', () => {
  const task = createScheduledTask({
    creatorOpenId: 'user_1',
    chatId: 'chat_1',
    targetBotId: 'developer',
    prompt: 'Check logs every hour',
    workspace: 'custom-workspace',
    rule: { kind: 'interval', everyMs: 3600_000 },
  });

  assert.equal(task.workspace, 'custom-workspace');
});

test('scheduled task prompt keeps static prefix unchanged across runs for KV Cache hit', () => {
  const mockBotConfig: BotConfig = {
    id: 'developer',
    appId: 'app_1',
    appSecret: 'sec_1',
    defaultCliId: 'claude',
    role: '开发工程师，负责实现已确认方案',
    skills: ['implement-ticket'],
    systemPrompt: '按照标准流程执行代码交付。',
    workspaceDir: '/path/to/ws',
    collaborationMaxRounds: 16,
  };

  const task = createScheduledTask({
    creatorOpenId: 'user_1',
    chatId: 'chat_1',
    targetBotId: 'developer',
    prompt: '每日系统健康审计：检查各组件错误率并输出结论报告。',
    rule: { kind: 'interval', everyMs: 3600_000 },
  });

  // 直接消费**生产代码**的组装函数：此前测试手抄了一份 prompt 文本，
  // 于是实现改动后测试仍全绿，而它声称守护的性质早已失真。
  const build = (scheduledFor: string) =>
    buildScheduledTaskPrompt({
      target: mockBotConfig,
      task,
      scheduledFor,
      teamContext: '团队上下文',
      defaultProductDeliveryMode: 'lark-doc',
    });

  // Run 1 at 10:00
  const prompt1 = build('2026-09-09T10:00:00.000Z');
  // Run 2 at 11:00 (one hour later)
  const prompt2 = build('2026-09-09T11:00:00.000Z');

  // 动态边界 = 计划触发时间所在位置。此前用「前 2,000 字符必须相同」来近似，
  // 而真实 prompt 的动态段落在 1,144 字符处（实测）——那个近似只在手抄的短 prompt 上成立，
  // 一旦改为消费生产函数就立刻暴露。改为直接断言真正要守的性质：
  // 动态段必须落在**固定位置**，其之前的静态前缀逐字节相同。
  const marker = '计划触发时间：';
  const boundary1 = prompt1.indexOf(marker);
  const boundary2 = prompt2.indexOf(marker);
  assert.ok(boundary1 > 0 && boundary2 > 0, '运行元信息必须存在且可定位');

  assert.equal(boundary1, boundary2, '动态段的起点不得随调度时间漂移');
  assert.equal(
    prompt1.slice(0, boundary1),
    prompt2.slice(0, boundary2),
    '静态前缀必须逐字节相同，否则 KV Cache 无法复用',
  );
  // 门槛贴着**实测值**定，而不是随手取 500（那等于允许前缀缩水一半以上仍然全绿，断言退化成装饰）。
  // 基线演进：早期版本的 L0 公理约 1,144 字符；补齐 M2/M4/M5/M6/M9、
  // M7 收敛为 LB1–LB6、M12 写回真参数后约为 2,700。
  // 前缀变短不是"优化"而是**公理被删减**，必须是一次显式决定并同步本基线，故门槛贴着实测值。
  assert.ok(
    boundary1 > 2_400,
    `静态前缀过短（实测 ${boundary1} 字符 / 基线约 2700）：要么公理被误删，要么 prompt 结构被改动，两者都需要显式确认`,
  );
  // 锁住被缓存的内容本身：前缀必须是 L0 公理块，否则"前缀稳定"可能只是缓存了一段没用的东西
  assert.ok(
    prompt1.startsWith('【L0 核心元方法论公理'),
    '静态前缀必须以 L0 公理块开头',
  );

  // 差异确实存在，且**只**存在于动态段内的时间戳本身
  assert.notEqual(prompt1, prompt2);
  const withoutTimestamp = (prompt: string, at: number) =>
    prompt.slice(at).replace(/计划触发时间：[^\n]*/, '');
  assert.equal(
    withoutTimestamp(prompt1, boundary1),
    withoutTimestamp(prompt2, boundary2),
    '除计划触发时间外，动态段其余内容也必须一致',
  );
});
