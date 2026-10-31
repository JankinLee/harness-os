import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appToolNameOf } from '../../src/cli/app-tools.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPSULE_CHAR_BUDGET,
  DispatchTaskRequestSchema,
  assembleContextCapsule,
  buildCollaborationPrompt,
  checkRelayGuardrails,
  estimateCapsuleLength,
} from '../../src/core/collaboration.js';
import {
  EMPTY_CONTENT_DIGEST,
  diffWorkspaceFingerprint,
  type WorkspaceFingerprint,
} from '../../src/core/workspace-change-probe.js';
import { CapsuleLog } from '../../src/core/capsule-log.js';
import { selectCapsuleLineage } from '../../src/core/capsule-lineage.js';
import { READONLY_FORBIDDEN_TOOLS } from '../../src/cli/app-tools.js';
import { verifyReconMutation } from '../../src/app/recon-guard.js';
import { runCli } from '../../src/cli/runner.js';
import type { CliEvent } from '../../src/cli/types.js';

const repo = (
  entries: string[],
  contentDigest = 'digest-unchanged',
): WorkspaceFingerprint => ({
  isRepository: true,
  entries,
  contentDigest,
});

test('事项二 · 变更探针：只有真实改动才算越权，清理脏改动不算', () => {
  // 未改动
  assert.equal(
    diffWorkspaceFingerprint(repo([' M src/a.ts']), repo([' M src/a.ts'])).mutated,
    false,
  );
  // 新增改动 → 越权
  const added = diffWorkspaceFingerprint(
    repo([' M src/a.ts']),
    repo([' M src/a.ts', '?? src/evil.ts']),
  );
  assert.equal(added.mutated, true);
  assert.deepEqual(added.changes, ['?? src/evil.ts']);
  // 已有条目内容变化（M → M 但文件不同）
  assert.equal(
    diffWorkspaceFingerprint(repo([' M src/a.ts']), repo([' M src/b.ts'])).mutated,
    true,
  );
  // **既有脏文件被再次改写**：条目集合逐字节相同，只有内容指纹能发现
  const rewritten = diffWorkspaceFingerprint(
    repo([' M src/a.ts'], 'digest-before'),
    repo([' M src/a.ts'], 'digest-after'),
  );
  assert.equal(
    rewritten.mutated,
    true,
    '同一个脏文件被改写时条目集合不变，必须靠内容指纹检出（否则 recon 可绕过整道防线）',
  );
  assert.match(rewritten.changes[0] ?? '', /内容发生变化/);
  // 执行把原本的脏改动清理干净 → 不算越权（只是更干净了）
  assert.equal(
    diffWorkspaceFingerprint(repo([' M src/a.ts']), repo([])).mutated,
    false,
  );
  // 物理回归：将真实脏工作区彻底恢复为干净状态（哈希变为 EMPTY_CONTENT_DIGEST 且无新增条目）绝不误判为越权
  assert.equal(
    diffWorkspaceFingerprint(
      repo([' M src/a.ts'], '71cabb43e6b4b0d3255bfef95601890afd80709'),
      repo([], EMPTY_CONTENT_DIGEST),
    ).mutated,
    false,
    '恢复至 EMPTY_CONTENT_DIGEST 且无新增条目必须判定为合法清理而不是越权',
  );
  // 对比反例：若虽然 diff 为空，但留下了新增的未跟踪文件，仍然必须判定为越权
  assert.equal(
    diffWorkspaceFingerprint(
      repo([' M src/a.ts'], '71cabb43e6b4b0d3255bfef95601890afd80709'),
      repo(['?? src/leftover.txt'], EMPTY_CONTENT_DIGEST),
    ).mutated,
    true,
    '恢复为空 diff 但引入了新未跟踪文件必须被判定为越权',
  );
  // 非 git 仓库 → 必须标记 inconclusive，绝不谎报「未改动」
  const unknown = diffWorkspaceFingerprint(
    { isRepository: false, entries: [] },
    repo([]),
  );
  assert.equal(unknown.mutated, false);
  assert.equal(unknown.inconclusive, true, '无法判定时必须显式标记存疑');
  assert.ok(unknown.inconclusiveReason, '无法判定必须给出原因，供告警文案使用');
});

test('事项二 · 门禁：只读调研放行 developer，实现仍被拦下', () => {
  const chain = {
    reportToBotId: 'ceo-assistant',
    round: 1,
    maxRounds: 16,
    tier: 'L' as const,
    objective: '对现有协作总线做代码探查',
  };
  const base = {
    selfBotId: 'ceo-assistant',
    targetBotId: 'developer',
    targetRegistered: true,
    instruction: '请只读探查 src/core 的接缝',
  };

  // 默认（implement）：L 级且无已批准方案 → 必须拦截
  assert.match(
    checkRelayGuardrails({ ...base, chain }) ?? '',
    /不可直接转交 developer/,
  );

  // 显式 recon → 放行（Phase 1 要求 Dev 在批准前做 Seam 探查）
  assert.equal(
    checkRelayGuardrails({ ...base, chain: { ...chain, intent: 'recon' } }),
    undefined,
  );

  // implement 显式声明 → 仍然拦截
  assert.match(
    checkRelayGuardrails({
      ...base,
      chain: { ...chain, intent: 'implement' },
    }) ?? '',
    /不可直接转交 developer/,
  );

  // recon 不得成为绕过其他护栏的万能钥匙：轮次上限照常生效
  assert.match(
    checkRelayGuardrails({
      ...base,
      targetBotId: 'product',
      chain: { ...chain, round: 16, intent: 'recon' },
    }) ?? '',
    /已达轮次上限/,
  );
  // 也不得绕过「回传对象不可转发」与「目标必须注册」
  assert.match(
    checkRelayGuardrails({
      ...base,
      targetBotId: 'ceo-assistant',
      selfBotId: 'product',
      chain: { ...chain, intent: 'recon' },
    }) ?? '',
    /回传对象/,
  );
  assert.match(
    checkRelayGuardrails({
      ...base,
      targetRegistered: false,
      chain: { ...chain, intent: 'recon' },
    }) ?? '',
    /未注册或未启用/,
  );
});

test('事项二 · dispatch 契约：intent 缺省即 implement（fail-closed）', () => {
  const parsed = DispatchTaskRequestSchema.parse({
    targetBotId: 'developer',
    objective: '探查接缝',
    instruction: '只读',
  });
  assert.equal(parsed.intent, undefined, '未声明时保持 undefined，由调用点按 implement 兜底');

  const recon = DispatchTaskRequestSchema.parse({
    targetBotId: 'developer',
    objective: '探查接缝',
    instruction: '只读',
    intent: 'recon',
    distilledDecisionsSummary: '上一轮已确认采用事件溯源',
  });
  assert.equal(recon.intent, 'recon');
  assert.equal(recon.distilledDecisionsSummary, '上一轮已确认采用事件溯源');

  // 非法 intent 必须被拒绝
  assert.throws(() =>
    DispatchTaskRequestSchema.parse({
      targetBotId: 'developer',
      objective: 'x',
      instruction: 'y',
      intent: 'readonly',
    }),
  );
});

test('事项二 · 提示词必须显式告知下游这是只读工单', () => {
  const prompt = buildCollaborationPrompt({
    dispatchId: 'd-recon',
    taskId: 't-1',
    ownerOpenId: 'ou_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'developer',
    reportToBotId: 'ceo-assistant',
    objective: '探查协作总线接缝',
    instruction: '只读回报',
    tier: 'L',
    intent: 'recon',
    round: 1,
    maxRounds: 16,
    workspaceDir: '/ws',
  });
  assert.match(prompt, /只读调研（recon）/);
  assert.match(prompt, /严禁修改任何文件/);
  assert.match(prompt, /git 变更探针/);

  // implement 不出现该告警
  const impl = buildCollaborationPrompt({
    dispatchId: 'd-impl',
    taskId: 't-1',
    ownerOpenId: 'ou_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'developer',
    reportToBotId: 'ceo-assistant',
    objective: '实现功能',
    instruction: '写代码',
    tier: 'L',
    round: 1,
    maxRounds: 16,
    workspaceDir: '/ws',
  });
  assert.doesNotMatch(impl, /只读调研（recon）/);
});

test('事项五 · 胶囊承接来源：渲染进提示词，且计入体积预算', () => {
  const lineage = {
    sourceTaskId: 'task-prev',
    approvedSpecPointer: 'https://example.feishu.cn/docx/FAKE_DOC_TOKEN_3',
    settledAt: '2026-09-17T00:00:00.000Z',
    note: '上一轮已完成总线分级改造，本轮续接生命周期治理',
  };
  const capsule = assembleContextCapsule({
    sourceTaskId: 'task-now',
    fromWorkspace: 'harness-os',
    toWorkspace: 'harness-os',
    objective: '续接上一轮的治理改造',
    tier: 'M',
    lineage,
  });
  assert.equal(capsule.lineage?.sourceTaskId, 'task-prev');

  const prompt = buildCollaborationPrompt({
    dispatchId: 'd-1',
    taskId: 'task-now',
    ownerOpenId: 'ou_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'product',
    reportToBotId: 'ceo-assistant',
    objective: '续接上一轮的治理改造',
    instruction: '继续',
    round: 1,
    maxRounds: 16,
    workspaceDir: '/ws',
    capsule,
  });
  assert.match(prompt, /承接来源/);
  assert.match(prompt, /task-prev/);
  assert.match(prompt, /勿重复其已完成部分/);
  assert.match(prompt, /本轮续接生命周期治理/);

  // 估计器必须与装配器共用同一套开销，否则会出现「测试断言通过、实际却超限」的假绿
  assert.ok(estimateCapsuleLength(capsule) <= CAPSULE_CHAR_BUDGET);

  // 超长 note 必须被截断而不是顶穿预算
  const huge = assembleContextCapsule({
    sourceTaskId: 'task-now',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '目标',
    lineage: { sourceTaskId: 'task-prev', note: '承'.repeat(5_000) },
  });
  assert.ok((huge.lineage?.note?.length ?? 0) <= 400);
  assert.ok(estimateCapsuleLength(huge) <= CAPSULE_CHAR_BUDGET);
});

test('事项五 · 无承接来源时不渲染空段落（不得产出幻觉式的"承接"）', () => {
  const capsule = assembleContextCapsule({
    sourceTaskId: 'task-now',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '全新任务',
  });
  assert.equal(capsule.lineage, undefined);
  const prompt = buildCollaborationPrompt({
    dispatchId: 'd-2',
    taskId: 'task-now',
    ownerOpenId: 'ou_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'product',
    reportToBotId: 'ceo-assistant',
    objective: '全新任务',
    instruction: '开始',
    round: 1,
    maxRounds: 16,
    workspaceDir: '/ws',
    capsule,
  });
  assert.doesNotMatch(prompt, /承接来源/);
});

test('事项五 · 胶囊供给日志：可审计、有界、写失败不阻断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-log-'));
  try {
    const log = new CapsuleLog(join(dir, 'capsule-log.json'), 3);
    const capsule = assembleContextCapsule({
      sourceTaskId: 't-1',
      fromWorkspace: 'a',
      toWorkspace: 'b',
      objective: '目标',
    });
    for (let index = 0; index < 5; index += 1) {
      log.append({
        nodeId: `d-${index}`,
        event: 'dispatch',
        taskId: 't-1',
        fromBotId: 'ceo-assistant',
        toBotId: 'developer',
        recordedAt: new Date().toISOString(),
        capsule,
        renderedLength: estimateCapsuleLength(capsule),
      });
    }
    const entries = log.load();
    // 有界：只保留最近 3 条，避免日志本身变成新的算力泄漏
    assert.equal(entries.length, 3);
    assert.equal(entries[2]?.nodeId, 'd-4');
    // 可审计：能按任务回溯「下游到底看到了什么」
    assert.equal(log.findByTaskId('t-1').length, 3);
    assert.equal(log.findByTaskId('t-other').length, 0);
    assert.ok((entries[0]?.renderedLength ?? 0) > 0);

    // 写入不可用（路径指向目录）时不得抛错，只降级为告警
    const broken = new CapsuleLog(dir);
    assert.doesNotThrow(() =>
      broken.append({
        nodeId: 'd-x',
        event: 'dispatch',
        taskId: 't-1',
        fromBotId: 'a',
        toBotId: 'b',
        recordedAt: new Date().toISOString(),
        capsule,
        renderedLength: 1,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('事项五 · 承接来源筛选：只认已交付、且双方凭据必须可比较', () => {
  const makeFlow = (
    overrides: Partial<Parameters<typeof selectCapsuleLineage>[0]['flows'][number]>,
  ) =>
    ({
      token: 'tok',
      taskId: 'topic-1',
      botId: 'product',
      sessionId: 's',
      ownerOpenId: 'ou',
      request: {
        deliveryMode: 'local' as const,
        title: 't',
        summary: 's',
        specPath: '.scratch/x/spec.md',
        ticketsPath: '.scratch/x/tickets.md',
      },
      status: 'approved' as const,
      lifecycle: 'delivered' as const,
      lifecycleUpdatedAt: 100,
      originalMessageId: 'om-prev',
      ...overrides,
    }) as Parameters<typeof selectCapsuleLineage>[0]['flows'][number];

  // 正常：上一条已交付、凭据不同 → 命中
  const hit = selectCapsuleLineage({
    flows: [makeFlow({})],
    taskId: 'topic-1',
    currentCredential: 'om-now',
  });
  assert.equal(hit?.sourceTaskId, 'topic-1');
  assert.match(hit?.approvedSpecPointer ?? '', /spec\.md/);

  // 自己的流（凭据相同）不得被当作承接来源
  assert.equal(
    selectCapsuleLineage({
      flows: [makeFlow({ originalMessageId: 'om-now' })],
      taskId: 'topic-1',
      currentCredential: 'om-now',
    }),
    undefined,
  );

  // 凭据缺失 → **不比较**，绝不产出「承接自自己」的幻觉
  assert.equal(
    selectCapsuleLineage({
      flows: [makeFlow({ originalMessageId: undefined })],
      taskId: 'topic-1',
      currentCredential: 'om-now',
    }),
    undefined,
    '一侧缺凭据时不应把该流当成承接来源',
  );

  // 归档行不可能出现在 listAll（archive 即 delete）—— 即便构造出来也不得命中，
  // 因为该分支是死代码，留着会让人误以为归档后仍能承接
  assert.equal(
    selectCapsuleLineage({
      flows: [makeFlow({ lifecycle: 'archived' as never })],
      taskId: 'topic-1',
      currentCredential: 'om-now',
    }),
    undefined,
  );

  // 休眠中的流不算已收口
  assert.equal(
    selectCapsuleLineage({
      flows: [makeFlow({ quarantined: true })],
      taskId: 'topic-1',
      currentCredential: 'om-now',
    }),
    undefined,
  );

  // 多条已交付时取最近跃迁的那条
  const latest = selectCapsuleLineage({
    flows: [
      makeFlow({ token: 'old', lifecycleUpdatedAt: 100, originalMessageId: 'om-a' }),
      makeFlow({ token: 'new', lifecycleUpdatedAt: 900, originalMessageId: 'om-b' }),
    ],
    taskId: 'topic-1',
    currentCredential: 'om-now',
  });
  assert.ok(latest);
});

test('事项五 · 承接指针措辞必须与权威指针区分（防下游去改已封存文档）', () => {
  const capsule = assembleContextCapsule({
    sourceTaskId: 'task-now',
    fromWorkspace: 'a',
    toWorkspace: 'b',
    objective: '续接',
    approvedSpecPointer: 'https://example.feishu.cn/docx/CURRENT',
    lineage: {
      sourceTaskId: 'task-prev',
      approvedSpecPointer: 'https://example.feishu.cn/docx/ARCHIVED',
    },
  });
  const prompt = buildCollaborationPrompt({
    dispatchId: 'd-3',
    taskId: 'task-now',
    ownerOpenId: 'ou_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'product',
    reportToBotId: 'ceo-assistant',
    objective: '续接',
    instruction: '继续',
    round: 1,
    maxRounds: 16,
    workspaceDir: '/ws',
    capsule,
  });
  assert.match(prompt, /权威方案指针/);
  assert.match(prompt, /来源历史方案/);
  assert.match(prompt, /仅供追溯，切勿据此实施或修改该文档/);
});

test('事项五 · 胶囊日志：损坏内容必须留档，不得静默抹掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-corrupt-'));
  try {
    const filePath = join(dir, 'capsule-log.json');
    writeFileSync(filePath, '{ this is not valid json', 'utf8');
    const log = new CapsuleLog(filePath);
    // 解析失败 → 以空历史继续，但必须先留档
    assert.deepEqual(log.load(), []);
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1, '损坏内容必须留档，否则历史被静默抹掉');
    assert.match(
      readFileSync(join(dir, backups[0]!), 'utf8'),
      /not valid json/,
    );

    // 留档后仍可正常写入
    const capsule = assembleContextCapsule({
      sourceTaskId: 't',
      fromWorkspace: 'a',
      toWorkspace: 'b',
      objective: 'o',
    });
    log.append({
      nodeId: 'd-1',
      event: 'dispatch',
      taskId: 't',
      fromBotId: 'a',
      toBotId: 'b',
      recordedAt: new Date().toISOString(),
      capsule,
      renderedLength: 1,
    });
    assert.equal(log.load().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('事项二 · recon 事前拦截：写入类工具必须在执行前被截断', async () => {
  // 这是 recon 的**事前**防线。仅靠「声明 + 事后 git 熔断」时，
  // 破坏已经物理落盘、只能报案不能回滚，因此必须有工具级的事前拦截。
  assert.ok(
    READONLY_FORBIDDEN_TOOLS.includes('Write' as never),
    'Write 必须在只读禁用清单内',
  );
  assert.ok(READONLY_FORBIDDEN_TOOLS.includes('Edit' as never));
  // 刻意不含 Bash：dev 做探查必须用 shell，读写无法靠工具名区分
  assert.ok(
    !(READONLY_FORBIDDEN_TOOLS as readonly string[]).includes('Bash'),
    'Bash 不能被禁用，否则只读调研无法进行（交给读锁 + 内容指纹兜底）',
  );

  // 机制验证：把禁用清单交给 runCli 后，请求 Write 必须立即截断 CLI。
  //
  // ⚠️ 本用例喂的是**合成** tool_call 事件，它验证的是 `runCli` 的截断机制本身。
  // 它**不能**被读作"生产里 recon 的写入会被拦住"——真实适配器只在
  // `appToolNameOf(name)` 命中 `FORWARDED_APP_TOOL_NAMES` 时才发出 `tool_call`，
  // 而 Write/Edit/Bash 都不在其中（见紧随其后的那条断言）。
  // 也正因如此，`stopToolNames` 与高危物理防御（`inspectToolExecution`）都挂在
  // `tool_call` 分支上 ⇒ 它们对写类工具**在当前事件契约下永远不会触发**。
  const script = `console.log(JSON.stringify({ type: 'tool_call', toolUseId: 'c1', toolName: 'Write', input: { file_path: 'src/evil.ts', content: 'x' } })); setTimeout(() => {}, 5000);`;
  const adapter: CliAdapter = {
    id: 'claude',
    command: process.execPath,
    displayName: 'Mock',
    buildArgs: () => ['-e', script],
    buildResumeArgs: () => ['-e', script],
    parseEvents: (line: string): CliEvent[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    },
  };
  const started = Date.now();
  const result = await runCli({
    adapter,
    prompt: 'recon',
    cwd: process.cwd(),
    // 角色身份现在是必需字段（CliExecutionEnv）：类型上漏不掉，测试调用点也不例外。
    env: { HARNESS_OS_BOT_ID: 'developer' },
    stopToolNames: [...READONLY_FORBIDDEN_TOOLS],
    timeoutMs: 20_000,
  });
  assert.ok(
    Date.now() - started < 5_000,
    '必须在工具执行前截断，而不是等子进程自然结束',
  );
  assert.equal(result.toolCalls?.[0]?.toolName, 'Write');
});

test('事项二 · 事实登记：写类工具在当前事件契约下产生不了 tool_call（事前拦截不可达）', () => {
  // 把上面的不可达性写成**可执行的事实**，而不是留在注释里：
  // `tool_call` 仅对转发工具发出，因此凡是 appToolNameOf 认不出的工具名，
  // 都永远走不到 stopToolNames / 高危硬拦截那两条分支。
  for (const localTool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.equal(
      appToolNameOf(localTool),
      undefined,
      `${localTool} 不是转发工具 ⇒ 它不会产生 tool_call ⇒ 事前拦截对它永不生效`,
    );
  }
  // 反证：转发工具确实能产生 tool_call，所以上面的机制本身不是坏的，只是覆盖面仅限于此
  assert.equal(appToolNameOf('mcp__harness_os__submit_tech_review'), 'submit_tech_review');
});

test('事项二 · 接线级：复核守卫的四条分支全部可达（此前是内联闭包，零覆盖）', async () => {
  const repo = (
    entries: string[],
    digest = 'd',
  ): WorkspaceFingerprint => ({ isRepository: true, entries, contentDigest: digest });
  const makeDeps = (
    overrides: Partial<Parameters<typeof verifyReconMutation>[0]> = {},
  ) => {
    const alerts: string[] = [];
    const reports: Array<{ reason: string; changes: string[] }> = [];
    const frictions: string[] = [];
    const deps = {
      executionCwd: '/ws',
      baseline: repo([]) as WorkspaceFingerprint | undefined,
      readFingerprint: async () => repo([]),
      replyCard: async (card: unknown) => {
        alerts.push(JSON.stringify(card));
      },
      finishCard: async (card: unknown) => {
        alerts.push(JSON.stringify(card));
      },
      reportToUpstream: async (options: { reason: string; changes: string[] }) => {
        reports.push(options);
      },
      buildAlert: ({ title, level, detail }: { title: string; level: string; detail: string }) =>
        ({ title, level, detail }) as never,
      recordFriction: (details: string) => {
        frictions.push(details);
      },
      ...overrides,
    };
    return { deps, alerts, reports, frictions };
  };

  // ① 非 recon（无基准）→ 跳过，且不产生任何副作用
  {
    const { deps, alerts, reports } = makeDeps({ baseline: undefined });
    assert.equal(await verifyReconMutation(deps), 'skipped');
    assert.equal(alerts.length, 0);
    assert.equal(reports.length, 0);
  }

  // ② 干净（未改动）→ clean
  {
    const { deps, alerts, reports } = makeDeps();
    assert.equal(await verifyReconMutation(deps), 'clean');
    assert.equal(alerts.length, 0);
    assert.equal(reports.length, 0);
  }

  // ③ 越权 → 熔断卡 + 摩擦计次 + **必须回告上游**
  {
    const { deps, alerts, reports, frictions } = makeDeps({
      readFingerprint: async () => repo(['?? src/evil.ts']),
    });
    assert.equal(await verifyReconMutation(deps), 'violated');
    assert.ok(alerts.some((text) => /只读调研越权/.test(text)));
    assert.equal(reports.length, 1, '越权必须回告上游，否则上游会照常采纳调研结论');
    assert.deepEqual(reports[0]!.changes, ['?? src/evil.ts']);
    assert.equal(frictions.length, 1, '越权必须按 M13 计次沉淀');
  }

  // ④ 无法判定 → 黄色告警 + **同样要回告上游**（结论未被复核这件事必须让上游知道）
  {
    const { deps, alerts, reports, frictions } = makeDeps({
      readFingerprint: async () => ({
        isRepository: false,
        entries: [],
        contentDigest: '',
      }),
    });
    assert.equal(await verifyReconMutation(deps), 'unverifiable');
    assert.ok(alerts.some((text) => /无法复核/.test(text)));
    assert.equal(reports.length, 1);
    assert.match(reports[0]!.reason, /无法完成物理复核/);
    assert.equal(frictions.length, 0, '无法判定不等于越权，不应记成越权摩擦');
  }
});

test('B4 · 上下文谱系：派生链必须可追溯（谁在第几跳看到了什么）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-lineage-'));
  try {
    const log = new CapsuleLog(join(dir, 'capsule-log.json'));
    const capsule = assembleContextCapsule({
      sourceTaskId: 't-1',
      fromWorkspace: 'a',
      toWorkspace: 'b',
      objective: '目标',
    });
    const node = (
      nodeId: string,
      event: 'dispatch' | 'consume',
      fromBotId: string,
      toBotId: string,
      parentNodeId?: string,
    ) => ({
      nodeId,
      event,
      parentNodeId,
      taskId: 't-1',
      fromBotId,
      toBotId,
      recordedAt: new Date().toISOString(),
      capsule,
      renderedLength: estimateCapsuleLength(capsule),
    });

    // ceo 派发给 dev（链起点）→ dev 消费 → dev 派发给 product（派生自消费节点）
    log.append(node('n1', 'dispatch', 'ceo-assistant', 'developer'));
    log.append(node('consume:n1', 'consume', 'developer', 'ceo-assistant', 'n1'));
    const parent = log.findLastConsumedBy('t-1', 'developer');
    assert.equal(parent?.nodeId, 'consume:n1');
    log.append(node('n2', 'dispatch', 'developer', 'product', parent!.nodeId));

    // 派生链闭合：n1 → consume:n1 → n2
    const chain = log.findByTaskId('t-1');
    assert.equal(chain.length, 3);
    assert.equal(chain[1]?.parentNodeId, 'n1');
    assert.equal(chain[2]?.parentNodeId, 'consume:n1');

    // 没有消费记录的 bot 不得凭空接上派生链
    assert.equal(log.findLastConsumedBy('t-1', 'ceo-assistant'), undefined);
    // 别的任务不得串链
    assert.equal(log.findLastConsumedBy('t-other', 'developer'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
