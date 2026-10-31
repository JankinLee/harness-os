import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { requestTaskAbort, type ActiveRun } from '../../src/core/task-abort.js';
import { fingerprintToolInvocation, RunawayDetector } from '../../src/core/runaway-detector.js';
import { inspectToolExecution, inspectReadonlyCommand } from '../../src/core/high-risk-guard.js';
import { parseCliRequest } from '../../src/core/command-parser.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { createCardActionHandler } from '../../src/app/card-action-handler.js';
import { ProductSpecFlowStore, type ProductSpecFlow } from '../../src/core/product-spec.js';
import { WorkspaceResolver } from '../../src/core/workspace-resolver.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { CardAction } from '../../src/im/lark.js';
import type { CollaborationService } from '../../src/app/collaboration-service.js';

test('Bug 5 修复验证：requestTaskAbort 支持管理员应急最高权与普通发起人权限', () => {
  const activeRuns = new Map<string, ActiveRun>();
  const controller = new AbortController();
  activeRuns.set('sess-1', {
    controller,
    ownerOpenId: 'ou_human_author',
  });

  // 1. 非发起人且非管理员 -> forbidden
  assert.equal(requestTaskAbort(activeRuns, 'sess-1', 'ou_stranger'), 'forbidden');

  // 2. 超级管理员 (来自 adminOpenIds) -> stopped
  const adminSet = new Set(['ou_super_admin']);
  assert.equal(requestTaskAbort(activeRuns, 'sess-1', 'ou_super_admin', adminSet), 'stopped');
  assert.equal(controller.signal.aborted, true);

  // 3. 环境变量 OWNER_OPEN_ID -> 自动作为管理员放行
  const ctrl2 = new AbortController();
  activeRuns.set('sess-2', {
    controller: ctrl2,
    ownerOpenId: 'ou_bot_sender', // 模拟此前协作中误存的 bot id
  });
  const oldOwnerEnv = process.env.OWNER_OPEN_ID;
  try {
    process.env.OWNER_OPEN_ID = 'ou_env_admin';
    assert.equal(requestTaskAbort(activeRuns, 'sess-2', 'ou_env_admin'), 'stopped');
    assert.equal(ctrl2.signal.aborted, true);
  } finally {
    process.env.OWNER_OPEN_ID = oldOwnerEnv;
  }
});

test('Bug 2 修复验证：Phase 3 跨 Bot 审批解耦，允许 Developer 渲染的卡片通过 Product 方案审批', async () => {
  const specStore = new ProductSpecFlowStore();
  const prodFlow = specStore.create({
    taskId: 'task-cross-bot',
    botId: 'product',
    sessionId: 'sess-product',
    ownerOpenId: 'ou_user_1',
    request: {
      title: '跨 Bot 方案',
      summary: '测试方案',
      deliveryMode: 'local',
      specPath: '.scratch/spec.md',
      ticketsPath: '.scratch/tickets.md',
    },
  });

  const mockBot = {
    reply: async () => {},
    replyCard: async () => {},
    updateCard: async () => {},
  };

  const sessions = new SessionManager();
  const mockRuntime = {
    sessions,
    productSpecFlows: specStore,
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map([
      ['product', { bot: mockBot, config: { id: 'product', role: '产品经理' } }],
      ['developer', { bot: mockBot, config: { id: 'developer', role: '开发工程师' } }],
    ]),
  } as unknown as AppRuntime;

  // 卡片回调接收者为 developer (因为 Developer 渲染了 Phase 3 审批卡)
  const devHandler = createCardActionHandler({
    runtime: mockRuntime,
    config: { id: 'developer', role: '开发工程师' } as any,
    collaborationService: {} as CollaborationService,
    defaultProductDeliveryMode: 'local',
  });

  const action: CardAction = {
    operatorOpenId: 'ou_user_1',
    messageId: 'msg-phase-3-card',
    value: {
      action: 'approve_product_spec',
      flowToken: prodFlow.token,
    },
    formValue: {},
  };

  const res = await devHandler(action);
  assert.equal(res?.toast?.type, 'success');
  assert.equal(res?.toast?.content, '产品方案已确认。');

  // 方案状态成功跃迁为 approved
  const updated = specStore.get(prodFlow.token);
  assert.equal(updated?.status, 'approved');
});

test('Bug 4 修复验证：fingerprintToolInvocation 强制归一化波动值，杜绝 contentDigest 旁路失效', () => {
  // 模拟两个包含 Windows 绝对路径和时间戳的输入
  const inv1 = {
    toolName: 'Edit',
    input: { file_path: 'C:\\workspace\\harness-os\\src\\index.ts:123', detail: 'line 123' },
    contentDigest: 'C:\\workspace\\harness-os\\src\\index.ts:123:2026-09-29T10:00:00Z',
    resultDigest: 'Error at 10:00:00 ms: 120ms',
    failed: true,
  };

  const inv2 = {
    toolName: 'Edit',
    input: { file_path: 'C:/workspace/harness-os/src/index.ts:456', detail: 'line 456' },
    contentDigest: 'C:/workspace/harness-os/src/index.ts:456:2026-09-29T11:00:00Z',
    resultDigest: 'Error at 11:00:00 ms: 340ms',
    failed: true,
  };

  const fp1 = fingerprintToolInvocation(inv1);
  const fp2 = fingerprintToolInvocation(inv2);

  // 路径与时间戳被归一化后，两者的特征指纹应该一致（识别为同一模式的原地打转）
  assert.equal(fp1, fp2);
});

test('Bug 6 修复验证：只读并发运行时防护 inspectReadonlyCommand 拦截写命令与重定向', () => {
  // 1. 放行纯读探查命令
  assert.equal(inspectReadonlyCommand('git status').blocked, false);
  assert.equal(inspectReadonlyCommand('git log -n 5').blocked, false);
  assert.equal(inspectReadonlyCommand('ls -la src/').blocked, false);
  assert.equal(inspectReadonlyCommand('grep -rn "TODO" src/').blocked, false);
  assert.equal(inspectReadonlyCommand('echo "test" > /dev/null').blocked, false);

  // 2. 拦截写命令
  assert.equal(inspectReadonlyCommand('echo "hello" > output.txt').blocked, true);
  assert.equal(inspectReadonlyCommand('echo "append" >> log.txt').blocked, true);
  assert.equal(inspectReadonlyCommand('rm -f src/temp.ts').blocked, true);
  assert.equal(inspectReadonlyCommand('touch newfile.ts').blocked, true);
  assert.equal(inspectReadonlyCommand('git commit -m "feat"').blocked, true);
  assert.equal(inspectReadonlyCommand('npm install axios').blocked, true);
  assert.equal(inspectReadonlyCommand('pnpm add lodash').blocked, true);

  // 3. inspectToolExecution 在 readonly 选项下联动拦截 Bash 命令与 Write/Edit 工具
  const res = inspectToolExecution('Bash', { command: 'mkdir -p test-dir' }, { readonly: true });
  assert.equal(res.blocked, true);
  assert.match(res.reason ?? '', /只读并发防御/);

  const resWrite = inspectToolExecution('Write', { file_path: 'src/index.ts', content: 'test' }, { readonly: true });
  assert.equal(resWrite.blocked, true);
  assert.match(resWrite.reason ?? '', /只读并发防御/);

  const resEdit = inspectToolExecution('Edit', { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' }, { readonly: true });
  assert.equal(resEdit.blocked, true);
  assert.match(resEdit.reason ?? '', /只读并发防御/);
});

test('Bug 7 修复验证：parseCliRequest 解析 /use 与 /engine 语法，SessionManager.switchCli 隔离 session ID', async () => {
  // 1. 命令解析
  const r1 = parseCliRequest('/use codex');
  assert.deepEqual(r1, { cliId: 'codex', prompt: '' });

  const r2 = parseCliRequest('/engine claude 帮我分析需求');
  assert.deepEqual(r2, { cliId: 'claude', prompt: '帮我分析需求' });

  const r3 = parseCliRequest('/codex 帮我编写单测');
  assert.deepEqual(r3, { cliId: 'codex', prompt: '帮我编写单测' });

  // 2. 状态机动态切换与隔离
  const sessions = new SessionManager();
  const resolved = await sessions.resolve(
    { messageId: 'm1', chatId: 'c1', threadId: 't1', rootId: '' },
    'claude',
    'developer',
  );
  const s1 = resolved.session;
  assert.equal(s1.cliId, 'claude');

  // 记录 Claude 会话 ID
  await sessions.setCliSessionId(s1.id, 'claude-session-uuid-1');

  // 切换为 Codex
  const s2 = await sessions.switchCli(s1.id, 'codex');
  assert.equal(s2.cliId, 'codex');
  // Codex session ID 应该为空（不混用 Claude ID）
  assert.equal(s2.cliSessionId, undefined);
  // 但旧的 Claude session ID 应该保存在 engineSessionIds 中
  assert.equal(s2.engineSessionIds?.claude, 'claude-session-uuid-1');

  // 记录 Codex 会话 ID
  await sessions.setCliSessionId(s1.id, 'codex-thread-uuid-2');

  // 切回 Claude
  const s3 = await sessions.switchCli(s1.id, 'claude');
  assert.equal(s3.cliId, 'claude');
  // Claude session ID 自动恢复
  assert.equal(s3.cliSessionId, 'claude-session-uuid-1');
  assert.equal(s3.engineSessionIds?.codex, 'codex-thread-uuid-2');
});

test('Bug 3 现场异常验证：WorkspaceResolver 根锚定防双重叠加', () => {
  // WorkspaceResolver 防双重相对路径拼接 (.scratch/xxx/.scratch/xxx)
  const baseDir = resolve('/mock/repo');
  const resolver = new WorkspaceResolver({
    defaultWorkspace: '.',
    workspaces: {},
    baseDirectory: baseDir,
    trustedRoots: [baseDir],
  });

  // 当 currentCwd 已经在 .scratch 子目录中时，输入 .scratch/feature 不得叠加为 /mock/repo/.scratch/feature/.scratch/feature
  const nestedCwd = resolve('/mock/repo/.scratch/feature');
  const resolved = resolver.resolve('.scratch/feature', nestedCwd);
  assert.equal(resolved, resolve('/mock/repo/.scratch/feature'));

  // 边界防御：同名前缀目录（如 .scratch-storage）不得被误截断
  const customCwd = resolve('/mock/repo/.scratch-storage/feature');
  const customResolved = resolver.resolve('./sub', customCwd);
  assert.equal(customResolved, resolve('/mock/repo/.scratch-storage/feature/sub'));
});
