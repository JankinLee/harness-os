import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RunawayDetector,
  fingerprintToolInvocation,
  normalizeVolatileTokens,
  stableStringify,
} from '../../src/core/runaway-detector.js';
import { runCli } from '../../src/cli/runner.js';
import type { CliAdapter } from '../../src/cli/types.js';

test('批次六 · 连续 3 次相同失败触发熔断（保留既有安全阈值，不放松）', () => {
  const detector = new RunawayDetector();
  const failure = {
    toolName: 'Bash',
    input: { command: 'npm test' },
    resultDigest: 'Command failed',
    failed: true,
  };

  assert.equal(detector.record(failure).level, 'none');
  assert.equal(detector.record(failure).level, 'warning');
  const third = detector.record(failure);
  assert.equal(third.level, 'breaker');
  assert.equal(third.period, 1);
  assert.equal(third.cycles, 3);
  assert.equal(detector.getConsecutiveCount(), 3);
});

test('批次六 · 纯成功重复（generic_repeat）降级为提示，永不熔断', () => {
  const detector = new RunawayDetector();
  const read = {
    toolName: 'Read',
    input: { file_path: 'src/index.ts' },
    resultDigest: 'export const x = 1;',
    failed: false,
  };
  detector.record(read);
  detector.record(read);
  const third = detector.record(read);
  // 关键：即使连续重复远超阈值，只要期间没有失败事实，就不得熔断
  assert.equal(third.level, 'critical');
  assert.notEqual(third.level, 'breaker');
  assert.match(third.reason ?? '', /无失败/);

  const fourth = detector.record(read);
  assert.equal(fourth.level, 'critical');
  assert.notEqual(fourth.level, 'breaker');
});

test('批次六 · 指纹必须归一化波动值（否则轮询无进展永不触发）', () => {
  // 同样的查询、不同的时间戳/耗时/绝对路径/行号 → 必须归一化为同一指纹
  const a = fingerprintToolInvocation({
    toolName: 'Bash',
    input: { command: 'cat /home/leon/project/src/index.ts' },
    resultDigest: '2026-09-17T05:22:31Z took 1234ms line src/index.ts:42',
  });
  const b = fingerprintToolInvocation({
    toolName: 'Bash',
    input: { command: 'cat /home/leon/project/src/index.ts' },
    resultDigest: '2026-09-17T05:23:59Z took 987ms line src/index.ts:57',
  });
  assert.equal(a, b, '波动值未剥离时同一轮询会产生两个指纹，无进展永远无法累积');

  // 键序不影响指纹
  assert.equal(
    stableStringify({ a: 1, b: 2 }),
    stableStringify({ b: 2, a: 1 }),
  );
  assert.equal(
    fingerprintToolInvocation({ toolName: 'Grep', input: { pattern: 'x', path: 'src' } }),
    fingerprintToolInvocation({ toolName: 'Grep', input: { path: 'src', pattern: 'x' } }),
  );

  // 归一化本身可断言
  assert.equal(normalizeVolatileTokens('用时 1234ms'), '用时 <metric>');
  assert.equal(
    normalizeVolatileTokens('C:\\workspace\\harness-os\\src\\index.ts'),
    '<path>',
  );

  // 真正的差异不得被归一化抹平
  assert.notEqual(
    fingerprintToolInvocation({ toolName: 'Bash', input: { command: 'npm test' } }),
    fingerprintToolInvocation({ toolName: 'Bash', input: { command: 'npm run build' } }),
  );
  // 成败不同必须产生不同指纹
  assert.notEqual(
    fingerprintToolInvocation({ toolName: 'Bash', input: { command: 'x' }, failed: true }),
    fingerprintToolInvocation({ toolName: 'Bash', input: { command: 'x' }, failed: false }),
  );
});

test('批次六 · 归一化不得把真实差异抹平（端口/短数字必须保留差异）', () => {
  // 曾用裸的 `/:\d+\b/` 归一行号，把 JSON 里冒号后的数字一并吃掉，
  // 于是「端口 3000」与「端口 8080」被判成同一指纹 —— 那不是无进展，是误判。
  assert.notEqual(
    fingerprintToolInvocation({ toolName: 'Bash', input: { port: 3000 } }),
    fingerprintToolInvocation({ toolName: 'Bash', input: { port: 8080 } }),
  );
  assert.notEqual(
    fingerprintToolInvocation({
      toolName: 'Bash',
      input: { command: 'curl http://localhost:3000/health' },
    }),
    fingerprintToolInvocation({
      toolName: 'Bash',
      input: { command: 'curl http://localhost:8080/health' },
    }),
  );
  // 但真正的行号仍必须被归一化：同一文件不同行 = 同一处无进展
  assert.equal(
    normalizeVolatileTokens('src/index.ts:42'),
    normalizeVolatileTokens('src/index.ts:57'),
  );
  assert.equal(normalizeVolatileTokens('src/index.ts:42'), 'src/index.ts:<line>');
});

test('批次六 · 引号不得决定「是否归一化」（对称性）', () => {
  // 有引号包裹同样要被归一化：曾有规则靠冒号+数字匹配，
  // 于是 `"took":1234` 被抹平而 `"took":"1234"` 不受影响 ——
  // 同一逻辑值因 JSON 引号有无而判定相反。
  assert.equal(normalizeVolatileTokens('"1234567"'), '"<num>"');
  assert.equal(normalizeVolatileTokens('1234567'), '<num>');
  // 短数字两侧都**不**归一：抹平它们会把端口/数量这类真实差异当成无进展
  assert.equal(normalizeVolatileTokens('"1234"'), '"1234"');
  assert.equal(normalizeVolatileTokens('1234'), '1234');
  // 字符串与数字仍是不同的输入，指纹不应相同（类型信息必须保留）
  assert.notEqual(
    fingerprintToolInvocation({ toolName: 'Bash', input: { took: '1234567' } }),
    fingerprintToolInvocation({ toolName: 'Bash', input: { took: 1234567 } }),
  );
});

test('批次六 · 类乒乓（a,b,a,b 与 a,a,b,a,a,b）必须被检出', () => {
  const a = { toolName: 'Read', input: { file_path: 'a.ts' }, resultDigest: 'A', failed: false };
  const b = { toolName: 'Read', input: { file_path: 'b.ts' }, resultDigest: 'B', failed: false };

  // 旧实现在每次成功时清空历史，a,b,a,b 永远攒不满阈值 → 这是根因级漏检
  const pingpong = new RunawayDetector();
  pingpong.record(a);
  pingpong.record(b);
  pingpong.record(a);
  const v = pingpong.record(b);
  assert.equal(v.period, 2);
  assert.equal(v.cycles, 2);
  assert.equal(v.level, 'warning');

  // a,a,b,a,a,b：周期 3
  const triple = new RunawayDetector();
  triple.record(a);
  triple.record(a);
  triple.record(b);
  triple.record(a);
  triple.record(a);
  const v3 = triple.record(b);
  assert.equal(v3.period, 3);
  assert.equal(v3.cycles, 2);
  assert.equal(v3.level, 'warning');
});

test('批次六 · 检测器是实例而非模块单例（多会话不得互相打断）', () => {
  const sessionA = new RunawayDetector();
  const sessionB = new RunawayDetector();
  const call = { toolName: 'Bash', input: { command: 'ls' }, failed: true };

  sessionA.record(call);
  sessionA.record(call);
  // 另一会话的写入不得影响 A 的窗口计数
  sessionB.record({ toolName: 'Read', input: { file_path: 'x' }, failed: false });
  sessionB.record(call);

  assert.equal(sessionA.getConsecutiveCount(), 2);
  assert.equal(sessionA.record(call).level, 'breaker');
});

test('批次六 · 引擎适配器必须把全部终结型工具转发给宿主（手工枚举回归）', async () => {
  // 手工列举的 CLAUDE_* 常量表曾漏掉 relay_to_peer / request_escalation /
  // submit_tech_review / submit_arbitration_verdict，使它们在 Claude 引擎下
  // 永不发出 tool_call —— 宿主既看不到（静默丢弃），也不会触发「未承接」告警。
  // 由于生产 bot 全部跑 Claude，这是实际生效路径上的空白。
  const { ClaudeAdapter } = await import('../../src/cli/claude-adapter.js');
  const { TERMINAL_CONTROL_TOOLS, SCHEDULE_MANAGE_TOOL_NAME } = await import(
    '../../src/cli/app-tools.js'
  );
  const adapter = new ClaudeAdapter();

  for (const toolName of [
    ...TERMINAL_CONTROL_TOOLS,
    SCHEDULE_MANAGE_TOOL_NAME,
  ]) {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: `tu-${toolName}`,
            name: `mcp__harness_os__${toolName}`,
            input: { probe: true },
          },
        ],
      },
    });
    const events = adapter.parseEvents(line);
    const toolCall = events.find((event) => event.type === 'tool_call');
    assert.ok(
      toolCall,
      `${toolName} 必须产生 tool_call 事件，否则宿主对它的调用完全不可见`,
    );
    assert.equal(
      (toolCall as { toolName: string }).toolName,
      toolName,
      'tool_call 必须带宿主侧的裸工具名',
    );
  }

  // 非 harness_os 的 MCP 工具不得被误认
  const foreign = adapter.parseEvents(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu-x',
            name: 'mcp__other__do_thing',
            input: {},
          },
        ],
      },
    }),
  );
  assert.equal(
    foreign.find((event) => event.type === 'tool_call'),
    undefined,
  );
});

test('批次六 · 先记录后检测：不依赖任何隐式调用顺序契约', () => {
  const detector = new RunawayDetector();
  const fail = { toolName: 'Bash', input: { command: 'x' }, failed: true };
  // 直接连续记录（中间不插入任何"成功"调用）即可触发，无需先失败后成功的顺序
  detector.record(fail);
  detector.record(fail);
  assert.equal(detector.record(fail).level, 'breaker');
  // peek 不改变状态
  const before = detector.getWindowSize();
  detector.peek();
  assert.equal(detector.getWindowSize(), before);
});

test('runCli silent timeout triggers when child produces no stdout within silentTimeoutMs', async () => {
  const mockAdapter: CliAdapter = {
    id: 'claude',
    displayName: 'Mock Claude',
    command: process.execPath,
    buildArgs: () => ['-e', 'setTimeout(() => {}, 10000)'],
    buildResumeArgs: () => ['-e', 'setTimeout(() => {}, 10000)'],
    parseEvents: () => [],
  };

  await assert.rejects(
    async () => {
      await runCli({
        adapter: mockAdapter,
        prompt: 'test',
        cwd: process.cwd(),
        env: { HARNESS_OS_BOT_ID: 'developer' },
        silentTimeoutMs: 150, // Test short silent timeout
        timeoutMs: 10000,
      });
    },
    {
      message: /STEP_TIMEOUT/,
    },
  );
});
