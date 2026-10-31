import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunawayDetector, fingerprintToolInvocation } from '../../src/core/runaway-detector.js';
import { harvestLatestDecisionSummary } from '../../src/app/product-decision-harvester.js';
import { formatParseError } from '../../src/core/tool-call-inspection.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { ScheduleStore } from '../../src/core/schedule-store.js';
import { ScheduleRunStore } from '../../src/core/schedule-run-store.js';
import { archiveScratchFeature } from '../../src/app/scratch-archiver.js';
import { ExperienceCandidateStore } from '../../src/core/experience-settlement.js';

test('LB-B: 物理载荷哈希解耦 —— 同一文件连续不同内容的修改不触发死循环报警', () => {
  const detector = new RunawayDetector();
  const filePath = '/workspace/example-project/.scratch/spec.md';

  for (let i = 0; i < 20; i++) {
    const verdict = detector.record({
      toolName: 'Edit',
      input: { detail: filePath },
      contentDigest: `digest-edit-round-${i}`,
      resultDigest: 'The file has been updated successfully.',
      failed: false,
    });
    assert.equal(
      verdict.level,
      'none',
      `第 ${i + 1} 次不同内容的编辑不得触发任何循环报警`,
    );
  }
});

test('LB-B: 物理载荷哈希解耦 —— 完全相同的入参连续失败 3 次精确触发熔断', () => {
  const detector = new RunawayDetector();
  const sameDigest = 'same-error-payload-digest';

  detector.record({
    toolName: 'Edit',
    input: { detail: 'broken.ts' },
    contentDigest: sameDigest,
    resultDigest: 'old_string not found',
    failed: true,
  });

  const v2 = detector.record({
    toolName: 'Edit',
    input: { detail: 'broken.ts' },
    contentDigest: sameDigest,
    resultDigest: 'old_string not found',
    failed: true,
  });
  assert.equal(v2.level, 'warning');

  const v3 = detector.record({
    toolName: 'Edit',
    input: { detail: 'broken.ts' },
    contentDigest: sameDigest,
    resultDigest: 'old_string not found',
    failed: true,
  });
  assert.equal(v3.level, 'breaker');
});

test('LB-A: 裁决文档摘要自动派生 —— 优先提取 <decision_summary> 结构块', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-harvest-'));
  try {
    const reviewDir = join(dir, '.scratch', 'review');
    mkdirSync(reviewDir, { recursive: true });
    const reviewFile = join(reviewDir, 'legacy-sunset-tech-review-r4.md');
    writeFileSync(
      reviewFile,
      `---
verdict: rejected
round: 3
---
<decision_summary>
- 裁决：rejected（窄口径）
- 阻塞项：C5Reason 出口 3/7/8 正向生产路径未冻结
</decision_summary>

## 详细记录
这里是详细穿刺内容...`,
      'utf8',
    );

    const summary = harvestLatestDecisionSummary(dir);
    assert.match(summary, /【裁决摘要 · 来源 legacy-sunset-tech-review-r4\.md】/);
    assert.match(summary, /C5Reason 出口 3\/7\/8 正向生产路径未冻结/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1/P2: 校验错误渲染带出实测长度与建议压缩目标', () => {
  const errorObj = {
    issues: [
      {
        path: ['summary'],
        message: 'Too big: expected string to have <=500 characters',
      },
    ],
  };
  const input = { summary: 'a'.repeat(650) };
  const rendered = formatParseError(errorObj, input);
  assert.match(rendered, /summary: 超长 \(实测 650 字 \/ 上限 500 字，需压缩 ≥150 字，建议 ≤450 字\)/);
});

test('Phase 4: Scheduler.ensureBuiltinTask 自动注册系统内置任务且支持 runNow 直通执行', async () => {
  const scheduleStore = new ScheduleStore();
  const runStore = new ScheduleRunStore();
  const runtime = {
    teamRegistry: new Map([
      ['ceo-assistant', { id: 'ceo-assistant', defaultCliId: 'claude', workspaceDir: process.cwd() }],
    ]),
    sessions: { resolve: async () => ({ session: { id: 's1', status: 'idle' }, isNew: false }), transition: async () => ({ id: 's1', status: 'idle' }) },
    arbitrationFlows: { listSweepable: () => [] },
    productSpecFlows: { listAll: () => [] },
    botRuntimes: new Map(),
  } as any;

  const scheduler = new Scheduler({
    runtime,
    scheduleStore,
    runStore,
    defaultProductDeliveryMode: 'local',
  });

  const task = scheduler.ensureBuiltinTask({
    id: 'sys-arbitration-sweep',
    rule: { kind: 'interval', everyMs: 5 * 60 * 1000 },
    prompt: '执行仲裁超时巡检',
    targetBotId: 'ceo-assistant',
    chatId: 'system',
    creatorOpenId: 'system',
  });

  assert.equal(task.id, 'sys-arbitration-sweep');
  assert.equal(scheduler.list().length, 1);

  // 验证 runNow 能够直通执行并生成成功记录
  const executed = await scheduler.runNow('sys-arbitration-sweep');
  assert.ok(executed);
  const runs = runStore.list('sys-arbitration-sweep');
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'succeeded');
});

test('ScratchArchiver: 软归档移送目录并生成 ARCHIVE_MANIFEST.md 封存备忘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scratch-test-'));
  try {
    const featureDir = join(dir, '.scratch', 'my-feature');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'spec.md'), '# 特性说明', 'utf8');

    const result = archiveScratchFeature(featureDir);
    assert.ok(result.archived);
    assert.ok(result.targetDir);
    assert.ok(existsSync(join(result.targetDir, 'ARCHIVE_MANIFEST.md')));
    assert.ok(existsSync(join(result.targetDir, 'spec.md')));
    assert.ok(!existsSync(featureDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ExperienceCandidateStore: 并发 recordHit 保证数据无丢失且原子写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concurrency-test-'));
  try {
    const filePath = join(dir, 'experience-candidates.json');
    const store = new ExperienceCandidateStore(filePath);

    // 10 次并发并发火焰式 hit 触发
    await Promise.all(
      Array.from({ length: 10 }).map((_, i) =>
        store.recordHit({
          id: `friction-test-${i}`,
          workspaceKey: 'harness-os',
          pattern: `测试模式 ${i}`,
          description: `详情 ${i}`,
        }),
      ),
    );

    const list = await store.load();
    assert.equal(list.length, 10, '所有并发写入的模式必须全部保留，无丢失更新');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ScratchArchiver: 严格路径边界拦截非 .scratch 目录与根目录自身', () => {
  const resultNonScratch = archiveScratchFeature('/workspace/harness-os/src/app');
  assert.equal(resultNonScratch.archived, false);

  const resultRoot = archiveScratchFeature('/workspace/harness-os/.scratch');
  assert.equal(resultRoot.archived, false);
});


