import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { WorkspaceResolver } from '../../src/core/workspace-resolver.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { parseCommand } from '../../src/core/command-parser.js';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { WorkspaceLockManager } from '../../src/core/workspace-lock-manager.js';
import { RunawayDetector } from '../../src/core/runaway-detector.js';
import { createScheduledTask } from '../../src/core/schedule.js';
import {
  DispatchTaskRequestSchema,
  collaborationTurnKey,
  type CollaborationMessage,
} from '../../src/core/collaboration.js';
import { getCliAdapter } from '../../src/cli/registry.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { Bot, IncomingMessage } from '../../src/im/lark.js';

test('E2E: Full lifecycle of dynamic mounting, dispatch penetration, lock & guardrails', async () => {
  const baseDir = resolve('.');
  const resolver = new WorkspaceResolver({
    defaultWorkspace: './src',
    workspaces: {
      'src-core': './src/core',
      'src-cli': './src/cli',
    },
    baseDirectory: baseDir,
    trustedRoots: [baseDir],
  });

  const sessionManager = new SessionManager();
  const lockManager = new WorkspaceLockManager();
  const runawayDetector = new RunawayDetector(3);

  const fakeRuntime = {
    sessions: sessionManager,
    workspaceResolver: resolver,
    activeRuns: new Map(),
  } as unknown as AppRuntime;

  const fakeBotReplies: string[] = [];
  const fakeBot = {
    reply: async (_msgId: string, text: string) => {
      fakeBotReplies.push(text);
      return 'reply-id';
    },
  } as unknown as Bot;

  // 1. Session initialization
  const addr = { messageId: 'm1', chatId: 'c1', threadId: 'topic-e2e', rootId: '' };
  const { session } = await sessionManager.resolve(
    addr,
    'claude',
    'bot-test',
    resolve(baseDir, 'src'),
    'src',
  );
  await sessionManager.setCliSessionId(session.id, 'cli-active-1');
  assert.equal(sessionManager.get(session.id)?.cliSessionId, 'cli-active-1');

  // 2. User switches workspace via /mount command
  const cmd = parseCommand('/mount src-core');
  assert.ok(cmd && cmd.name === 'mount');

  const outcome = await handleSessionCommand({
    runtime: fakeRuntime,
    scheduler: {} as any,
    config: { id: 'bot-test' } as any,
    msg: { messageId: 'm1' } as unknown as IncomingMessage,
    bot: fakeBot,
    session: sessionManager.get(session.id)!,
    cliAdapter: getCliAdapter('claude'),
    command: cmd,
    isNew: false,
    hasThread: true,
  });

  assert.equal(outcome, 'handled');
  // Verified cold teardown: cliSessionId cleared
  const updatedSession = sessionManager.get(session.id)!;
  assert.equal(updatedSession.workspaceDir, resolve(baseDir, 'src/core'));
  assert.equal(updatedSession.workspaceAlias, 'src-core');
  assert.equal(updatedSession.cliSessionId, undefined);

  // 3. Cross-repo dispatch penetration verification
  const dispatchReq = DispatchTaskRequestSchema.parse({
    targetBotId: 'developer',
    objective: 'E2E Cross Repo',
    instruction: 'Check files',
    targetWorkspace: 'src-cli',
  });
  const penetratedWs = await resolver.resolveAndEnsure(dispatchReq.targetWorkspace);
  assert.equal(penetratedWs, resolve(baseDir, 'src/cli'));

  const colMsg: CollaborationMessage = {
    dispatchId: 'disp-e2e-1',
    taskId: 'task-e2e',
    ownerOpenId: 'u1',
    fromBotId: 'ceo',
    toBotId: 'developer',
    reportToBotId: 'ceo',
    objective: dispatchReq.objective,
    instruction: dispatchReq.instruction,
    targetWorkspace: dispatchReq.targetWorkspace,
    round: 1,
    maxRounds: 5,
    workspaceDir: penetratedWs,
  };
  assert.equal(collaborationTurnKey(colMsg), 'disp-e2e-1');

  // 4. Workspace Lock Manager排队与互斥测试
  let task1Completed = false;
  let task2Started = false;

  const t1 = lockManager.runWithLock(penetratedWs, 'runner-1', async () => {
    await new Promise((r) => setTimeout(r, 50));
    task1Completed = true;
  });

  const t2 = lockManager.runWithLock(penetratedWs, 'runner-2', async () => {
    assert.equal(task1Completed, true);
    task2Started = true;
  });

  await Promise.all([t1, t2]);
  assert.equal(task1Completed, true);
  assert.equal(task2Started, true);
  assert.equal(lockManager.isLocked(penetratedWs), false);

  // 5. Scheduled task workspace attribute
  const schedTask = createScheduledTask({
    creatorOpenId: 'u1',
    chatId: 'c1',
    targetBotId: 'developer',
    prompt: 'Scheduled check',
    workspace: 'src-core',
    rule: { kind: 'interval', everyMs: 60_000 },
  });
  assert.equal(schedTask.workspace, 'src-core');

  // 6. Runaway circuit breaker detection（分级响应：none → warning → breaker）
  const repeatedFailure = {
    toolName: 'Read',
    input: { path: 'none.txt' },
    resultDigest: 'ENOENT',
    failed: true,
  };
  assert.equal(runawayDetector.record(repeatedFailure).level, 'none');
  assert.equal(runawayDetector.record(repeatedFailure).level, 'warning');
  assert.equal(runawayDetector.record(repeatedFailure).level, 'breaker');
});
