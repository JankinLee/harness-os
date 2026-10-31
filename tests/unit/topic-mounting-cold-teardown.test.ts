import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/core/command-parser.js';
import { SessionManager, type Session } from '../../src/core/session-manager.js';
import { WorkspaceResolver } from '../../src/core/workspace-resolver.js';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { Bot, IncomingMessage } from '../../src/im/lark.js';
import { getCliAdapter } from '../../src/cli/registry.js';
import { resolve } from 'node:path';

test('command-parser parses /mount and /workspace correctly', () => {
  assert.deepEqual(parseCommand('/mount example-project'), {
    name: 'mount',
    path: 'example-project',
  });
  assert.deepEqual(parseCommand('/workspace'), {
    name: 'workspace',
    path: undefined,
  });
  assert.deepEqual(parseCommand('/workspace ../another'), {
    name: 'workspace',
    path: '../another',
  });
  assert.deepEqual(parseCommand('/cd'), {
    name: 'cd',
    path: undefined,
  });
  assert.deepEqual(parseCommand('/status'), {
    name: 'status',
  });
});

test('SessionManager sets workspaceDir and resets cliSessionId', async () => {
  const manager = new SessionManager();
  const address = {
    messageId: 'm1',
    chatId: 'c1',
    threadId: 't1',
    rootId: '',
  };

  const { session } = await manager.resolve(address, 'claude', 'bot1', '/dir1', 'alias1');
  assert.equal(session.workspaceDir, '/dir1');
  assert.equal(session.workspaceAlias, 'alias1');

  // Set cliSessionId
  await manager.setCliSessionId(session.id, 'cli-sess-123');
  assert.equal(manager.get(session.id)?.cliSessionId, 'cli-sess-123');

  // Cold teardown: switch workspaceDir
  const updated = await manager.setWorkspaceDir(session.id, '/dir2', 'alias2');
  assert.equal(updated.workspaceDir, '/dir2');
  assert.equal(updated.workspaceAlias, 'alias2');
  // cliSessionId MUST be cleared
  assert.equal(updated.cliSessionId, undefined);
  assert.equal(manager.get(session.id)?.cliSessionId, undefined);
});

test('handleSessionCommand Busy Guard blocks workspace switch when active', async () => {
  const baseDir = resolve('/mock/base');
  const resolver = new WorkspaceResolver({
    defaultWorkspace: './ws1',
    workspaces: { ws1: './ws1', ws2: './ws2' },
    baseDirectory: baseDir,
    trustedRoots: [baseDir],
  });

  const manager = new SessionManager();
  const address = {
    messageId: 'm1',
    chatId: 'c1',
    threadId: 't1',
    rootId: '',
  };
  const { session } = await manager.resolve(address, 'claude', 'bot1', resolve(baseDir, 'ws1'));
  await manager.transition(session.id, 'active');

  const replies: string[] = [];
  const fakeBot = {
    reply: async (_msgId: string, text: string) => {
      replies.push(text);
      return 'sent-1';
    },
  } as unknown as Bot;

  const fakeRuntime = {
    sessions: manager,
    workspaceResolver: resolver,
    activeRuns: new Map(),
  } as unknown as AppRuntime;

  const outcome = await handleSessionCommand({
    runtime: fakeRuntime,
    scheduler: {} as any,
    config: { id: 'bot1' } as any,
    msg: { messageId: 'm1' } as unknown as IncomingMessage,
    bot: fakeBot,
    session: manager.get(session.id)!,
    cliAdapter: getCliAdapter('claude'),
    command: { name: 'mount', path: 'ws2' },
    isNew: false,
    hasThread: true,
  });

  assert.equal(outcome, 'handled');
  assert.match(replies[0], /当前任务仍在执行中，无法切换工作区/);
  // Session workspaceDir did NOT change
  assert.equal(manager.get(session.id)?.workspaceDir, resolve(baseDir, 'ws1'));
});
