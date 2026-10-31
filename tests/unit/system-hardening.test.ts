import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProductSpecDocuments } from '../../src/app/product-spec-documents.js';
import { checkLarkAuthStatus, buildLarkAuthAlertCard } from '../../src/core/lark-auth-probe.js';
import { ensureProductSpecSubmission } from '../../src/app/product-spec-submission.js';
import { inspectToolExecution } from '../../src/core/high-risk-guard.js';
import { buildProductSpecApprovalCard } from '../../src/im/card.js';
import { checkToolRbac } from '../../src/core/tool-rbac.js';
import { requestTaskAbort } from '../../src/core/task-abort.js';
import type { LocalProductSpecRequest, ProductSpecFlow } from '../../src/core/product-spec.js';

test('门禁解析双模自适应：支持 tickets.md 单文件模式与 issues/ 切片目录双模解析及自愈兼容', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'harness-os-spec-test-'));

  try {
    const scratchDir = join(tempDir, '.scratch', 'feature-auth');
    await mkdir(scratchDir, { recursive: true });

    const specPath = '.scratch/feature-auth/spec.md';
    await writeFile(join(tempDir, specPath), '# Spec Content\nFeature Specification');

    // 1. 单文件 tickets.md 模式验证
    const ticketsFile = '.scratch/feature-auth/tickets.md';
    await writeFile(join(tempDir, ticketsFile), '# Tickets List\n- [ ] Task 1');

    const requestSingle: LocalProductSpecRequest = {
      title: '认证模块加固',
      summary: '重构认证与授权体系',
      deliveryMode: 'local',
      specPath,
      ticketsPath: ticketsFile,
    };

    await assertProductSpecDocuments(tempDir, requestSingle);
    assert.equal(requestSingle.ticketsPath, ticketsFile);

    // 2. 同级切片目录 issues/ 自动收录兼容验证
    const issuesDir = join(scratchDir, 'issues');
    await mkdir(issuesDir, { recursive: true });
    await writeFile(join(issuesDir, 'TICKET-01.md'), '# Issue 1');

    await assertProductSpecDocuments(tempDir, requestSingle);
    // 当传入 tickets.md 但同级存在 issues/ 时，自动挂载 issuesPath 且绝不抛错
    assert.equal(requestSingle.issuesPath, '.scratch/feature-auth/issues');

    // 3. 切片目录作为 ticketsPath 模式验证
    const requestDir: LocalProductSpecRequest = {
      title: '认证模块切片',
      summary: '采用切片目录组织',
      deliveryMode: 'local',
      specPath,
      ticketsPath: '.scratch/feature-auth/issues',
    };

    await assertProductSpecDocuments(tempDir, requestDir);
    assert.equal(requestDir.ticketsPath, '.scratch/feature-auth/issues');
    // 同级存在 tickets.md 汇总时，issuesPath 保留切片目录以供关联
    assert.equal(requestDir.issuesPath, '.scratch/feature-auth/issues');

    // 4. 路径容错与智能自愈验证：请求单文件但磁盘只有切片目录
    await rm(join(tempDir, ticketsFile));
    const requestMissingFile: LocalProductSpecRequest = {
      title: '自愈测试',
      summary: '测试单文件缺失但存在切片目录时的自愈',
      deliveryMode: 'local',
      specPath,
      ticketsPath: '.scratch/feature-auth/tickets.md',
    };

    await assertProductSpecDocuments(tempDir, requestMissingFile);
    // 自动自愈收敛至真实存在的切片目录
    assert.equal(requestMissingFile.ticketsPath, '.scratch/feature-auth/issues');

    // 5. 缺失文件时的正确抛错提示
    const requestInvalid: LocalProductSpecRequest = {
      title: '无效测试',
      summary: '不存在的文件',
      deliveryMode: 'local',
      specPath: '.scratch/feature-auth/non-existent-spec.md',
      ticketsPath: '.scratch/feature-auth/non-existent-tickets.md',
    };

    await assert.rejects(
      () => assertProductSpecDocuments(tempDir, requestInvalid),
      /产品方案尚未完整写入工作区，不能展示。/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('飞书凭证主动巡检探针：支持提取 refreshExpiresAt 并对 <48h 及已失效凭证触发预警', async () => {
  const fakeNow = new Date('2026-09-09T10:00:00.000Z');

  // 1. 凭证充沛场景 (有效期 > 48小时)
  const healthyOutput = JSON.stringify({
    appId: 'cli_test_123',
    identities: {
      user: {
        status: 'ready',
        available: true,
        userName: '测试工程师',
        openId: 'ou_test_user',
        refreshExpiresAt: '2026-09-15T10:00:00.000Z', // 6天后，>48h
      },
    },
  });

  const healthyResult = await checkLarkAuthStatus({
    execCommand: async () => healthyOutput,
    now: () => fakeNow,
  });
  assert.equal(healthyResult.healthy, true);
  assert.equal(healthyResult.needsAlert, false);

  // 2. 凭证即将过期场景 (< 48小时预警)
  const expiringSoonOutput = JSON.stringify({
    appId: 'cli_test_123',
    identities: {
      user: {
        status: 'ready',
        available: true,
        userName: '测试工程师',
        openId: 'ou_test_user',
        refreshExpiresAt: '2026-09-10T12:00:00.000Z', // 26小时后，<48h
      },
    },
  });

  const expiringResult = await checkLarkAuthStatus({
    execCommand: async () => expiringSoonOutput,
    now: () => fakeNow,
  });
  assert.equal(expiringResult.healthy, false);
  assert.equal(expiringResult.needsAlert, true);
  assert.match(expiringResult.reason!, /不足 48 小时/);

  // 3. 凭证已过期失效场景
  const expiredOutput = JSON.stringify({
    appId: 'cli_test_123',
    identities: {
      user: {
        status: 'expired',
        available: false,
        userName: '测试工程师',
        openId: 'ou_test_user',
        refreshExpiresAt: '2026-09-08T10:00:00.000Z',
      },
    },
  });

  const expiredResult = await checkLarkAuthStatus({
    execCommand: async () => expiredOutput,
    now: () => fakeNow,
  });
  assert.equal(expiredResult.healthy, false);
  assert.equal(expiredResult.needsAlert, true);
  assert.match(expiredResult.reason!, /已失效/);

  // 3.1 异常场景：非法或无法解析的时间字符串 (防御 NaN < 48 逻辑逃逸)
  const invalidDateOutput = JSON.stringify({
    appId: 'cli_test_123',
    identities: {
      user: {
        status: 'ready',
        available: true,
        userName: '测试工程师',
        openId: 'ou_test_user',
        refreshExpiresAt: 'invalid-date-string',
      },
    },
  });

  const invalidDateResult = await checkLarkAuthStatus({
    execCommand: async () => invalidDateOutput,
    now: () => fakeNow,
  });
  assert.equal(invalidDateResult.healthy, false);
  assert.equal(invalidDateResult.needsAlert, true);
  assert.match(invalidDateResult.reason!, /格式无效或无法解析/);

  // 4. 预警卡片构造验证
  const alertCard = buildLarkAuthAlertCard(expiringResult);
  const alertCardJson = JSON.stringify(alertCard);
  assert.match(alertCardJson, /lark-cli auth login/);
  assert.match(alertCardJson, /48h/);
});

test('lark-doc 鉴权失效拦截：因鉴权失效导致由 lark-doc 降级时 fail-closed 拦截并提示重新授权', async () => {
  // 模拟初始执行由于鉴权失效报错
  const mockResult = {
    answer: '调用 lark-cli 遇到 need_user_authorization 错误，试图降级为本地 Spec',
    toolCalls: [
      {
        toolName: 'request_spec_approval',
        input: {
          title: '方案标题',
          summary: '方案摘要',
          deliveryMode: 'local',
          specPath: '.scratch/feat/spec.md',
          ticketsPath: '.scratch/feat/tickets.md',
        },
      },
    ],
  };

  await assert.rejects(
    async () => {
      await ensureProductSpecSubmission({
        result: mockResult as any,
        defaultDeliveryMode: 'lark-doc',
        retry: async () => mockResult as any,
      });
    },
    (err: any) => {
      assert.match(err.message, /飞书云文档鉴权失效/);
      assert.match(err.message, /系统已阻断静默降级/);
      return true;
    },
  );
});

test('非鉴权受阻时的本地降级告警通知：因其他交付受阻降级为 local 时附带显式提示', async () => {
  const mockResult = {
    answer: '云文档写入失败，网络异常',
    toolCalls: [
      {
        toolName: 'request_spec_approval',
        input: {
          title: '方案标题',
          summary: '方案摘要',
          deliveryMode: 'local',
          specPath: '.scratch/feat/spec.md',
          ticketsPath: '.scratch/feat/tickets.md',
        },
      },
    ],
  };

  const submission = await ensureProductSpecSubmission({
    result: mockResult as any,
    defaultDeliveryMode: 'lark-doc',
    retry: async () => mockResult as any,
  });

  assert.equal(submission.request.deliveryMode, 'local');
  assert.match(submission.request.warning!, /飞书云文档交付受阻/);

  // 飞书卡片应显式渲染降级警告横幅
  const flow: ProductSpecFlow = {
    token: 'flow-token-1',
    taskId: 'task-1',
    botId: 'product',
    sessionId: 'session-1',
    ownerOpenId: 'ou_owner',
    request: submission.request,
    status: 'pending',
  };

  const card = buildProductSpecApprovalCard(flow);
  const cardStr = JSON.stringify(card);
  assert.match(cardStr, /降级提示/);
  assert.match(cardStr, /飞书云文档交付受阻/);
});

test('高危物理防御硬拦截Hook：对破坏性 Shell 命令与未审批凭证篡改执行底层刚性拦截', () => {
  // 1. rm -rf 物理递归删除高危命令
  const r1 = inspectToolExecution('Bash', { command: 'rm -rf /' });
  assert.equal(r1.blocked, true);
  assert.match(r1.reason!, /物理硬防御拦截/);
  assert.match(r1.reason!, /rm -rf/);

  const r2 = inspectToolExecution('Bash', { command: 'rm -rf node_modules' });
  assert.equal(r2.blocked, true);

  // 2. git push --force 破坏性强推
  const r3 = inspectToolExecution('Bash', { command: 'git push origin master --force' });
  assert.equal(r3.blocked, true);
  assert.match(r3.reason!, /git push --force/);

  // 3. git reset --hard 破坏性回滚
  const r4 = inspectToolExecution('Bash', { command: 'git reset --hard origin/main' });
  assert.equal(r4.blocked, true);
  assert.match(r4.reason!, /git reset --hard/);

  // 4. kill -9 物理强杀
  const r5 = inspectToolExecution('Bash', { command: 'kill -9 8080' });
  assert.equal(r5.blocked, true);
  assert.match(r5.reason!, /kill -9/);

  // 5. 破坏性数据库操作
  const r6 = inspectToolExecution('Bash', { command: 'mysql -e "DROP TABLE users;"' });
  assert.equal(r6.blocked, true);
  assert.match(r6.reason!, /DROP \/ TRUNCATE/);

  // 6. 直接重定向篡改 .env
  const r7 = inspectToolExecution('Bash', { command: 'echo "EVIL=1" > .env' });
  assert.equal(r7.blocked, true);
  assert.match(r7.reason!, /\.env/);

  // 7. Write/Edit 篡改 .env（涵盖无前缀相对路径与子目录路径）
  const r8 = inspectToolExecution('Write', { file_path: '.env' });
  assert.equal(r8.blocked, true);
  assert.match(r8.reason!, /\.env/);

  const r8_1 = inspectToolExecution('Write', { file_path: '.env.local' });
  assert.equal(r8_1.blocked, true);
  assert.match(r8_1.reason!, /\.env/);

  const r9 = inspectToolExecution('Edit', { file_path: '/project/.env.production' });
  assert.equal(r9.blocked, true);

  const r9_1 = inspectToolExecution('Bash', { command: 'echo "X=1" > ./.env' });
  assert.equal(r9_1.blocked, true);

  // 8. 常规合法命令必须正常放行，严禁误伤
  const safe1 = inspectToolExecution('Bash', { command: 'pnpm test' });
  assert.equal(safe1.blocked, false);

  const safe2 = inspectToolExecution('Bash', { command: 'git status' });
  assert.equal(safe2.blocked, false);

  const safe3 = inspectToolExecution('Write', { file_path: 'src/index.ts' });
  assert.equal(safe3.blocked, false);
});

test('RBAC 身份缺失必须 fail-closed：受限工具一律拒绝，未受限工具不受影响', () => {
  // 此前的 `if (!botId) return { allowed: true }` 是 fail-open：
  // 只要调用点忘了下发 HARNESS_OS_BOT_ID，该角色就"特权全开"，
  // 而本仓真的漏过五次（澄清续跑 / 评论 / 方案修订首轮与重试 / 定时任务）。
  for (const tool of [
    'dispatch_task',
    'request_spec_approval',
    'schedule_manage',
    'request_clarification',
    'request_escalation',
    'submit_tech_review',
    'submit_arbitration_verdict',
  ]) {
    const verdict = checkToolRbac(undefined, tool);
    assert.equal(verdict.allowed, false, `身份缺失时 ${tool} 不得放行`);
    assert.match(String(verdict.reason), /身份缺失/);
  }

  // 未受限工具（不在角色规则表内）不因身份缺失被牵连
  assert.equal(checkToolRbac(undefined, 'request_approval').allowed, true);
  assert.equal(checkToolRbac(undefined, 'relay_to_peer').allowed, true);

  // 有身份时的既有边界不得被改动（定时任务按治理域解耦给长期成员，外来或未授权身份拦截）
  assert.equal(checkToolRbac('developer', 'submit_tech_review').allowed, true);
  assert.equal(checkToolRbac('product', 'submit_tech_review').allowed, false);
  assert.equal(checkToolRbac('ceo-assistant', 'schedule_manage').allowed, true);
  assert.equal(checkToolRbac('developer', 'schedule_manage').allowed, true);
  assert.equal(checkToolRbac('product', 'schedule_manage').allowed, true);
  assert.equal(checkToolRbac('guest', 'schedule_manage').allowed, false);
});

test('任务中止必须校验归属：非发起人、无归属、无操作者一律拒绝', () => {
  const makeRun = (ownerOpenId: string) => ({
    controller: new AbortController(),
    ownerOpenId,
  });

  const runs = new Map([['sess-1', makeRun('ou_alice')]]);

  assert.equal(requestTaskAbort(runs, 'sess-1', 'ou_bob'), 'forbidden');
  assert.equal(runs.get('sess-1')!.controller.signal.aborted, false, '拒绝必须无副作用');

  assert.equal(requestTaskAbort(runs, 'sess-1', ''), 'forbidden');
  assert.equal(requestTaskAbort(runs, 'sess-1', 'ou_alice'), 'stopped');
  assert.equal(runs.get('sess-1')!.controller.signal.aborted, true);

  // 无归属记录的运行同样拒绝：字段缺失不能成为"谁都能停"的理由
  const legacy = new Map([['sess-2', makeRun('')]]);
  assert.equal(requestTaskAbort(legacy, 'sess-2', 'ou_alice'), 'forbidden');
  assert.equal(requestTaskAbort(legacy, 'sess-2', ''), 'forbidden');

  assert.equal(requestTaskAbort(new Map(), 'sess-x', 'ou_alice'), 'not_found');
});
