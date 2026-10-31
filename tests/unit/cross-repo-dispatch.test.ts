import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  DispatchTaskRequestSchema,
  collaborationTurnKey,
  type CollaborationMessage,
} from '../../src/core/collaboration.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { WorkspaceResolver } from '../../src/core/workspace-resolver.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { Bot } from '../../src/im/lark.js';

test('DispatchTaskRequestSchema accepts targetWorkspace', () => {
  const parsed = DispatchTaskRequestSchema.parse({
    targetBotId: 'developer',
    objective: 'Implement feature',
    instruction: 'Write code in repo B',
    targetWorkspace: 'example-project',
  });
  assert.equal(parsed.targetWorkspace, 'example-project');
});

test('collaborationTurnKey uses dispatchId to prevent cross-round false duplicate rejection', () => {
  const msg1: CollaborationMessage = {
    dispatchId: 'disp001',
    taskId: 'task-1',
    ownerOpenId: 'u1',
    fromBotId: 'ceo',
    toBotId: 'dev',
    reportToBotId: 'ceo',
    objective: 'Obj',
    instruction: 'Inst',
    round: 1,
    maxRounds: 10,
    workspaceDir: '/ws1',
  };

  const msg2: CollaborationMessage = {
    ...msg1,
    dispatchId: 'disp002',
    round: 1, // Same round and same task, but different dispatch
  };

  assert.equal(collaborationTurnKey(msg1), 'disp001');
  assert.equal(collaborationTurnKey(msg2), 'disp002');
  assert.notEqual(collaborationTurnKey(msg1), collaborationTurnKey(msg2));
});

test('CollaborationService resolves targetWorkspace physically', async () => {
  const baseDir = resolve('.');
  const resolver = new WorkspaceResolver({
    defaultWorkspace: './src',
    workspaces: {
      'core-alias': './src/core',
    },
    baseDirectory: baseDir,
    trustedRoots: [baseDir],
  });

  const registeredMessages: CollaborationMessage[] = [];
  const fakeRuntime = {
    workspaceResolver: resolver,
    botRuntimes: new Map([
      ['developer', { identity: { name: 'Developer', openId: 'dev_1' } }],
      ['ceo-assistant', { identity: { name: 'CEO', openId: 'ceo_1' } }],
    ]),
    collaborationInbox: {
      register: (msg: CollaborationMessage) => registeredMessages.push(msg),
      consume: () => undefined,
    },
  } as unknown as AppRuntime;

  const service = new CollaborationService(fakeRuntime);
  const fakeBot = {
    replyCard: async () => 'card-msg-1',
    replyMention: async () => 'mention-msg-1',
  } as unknown as Bot;

  await service.dispatch({
    senderConfig: { id: 'ceo-assistant' } as any,
    senderBot: fakeBot,
    replyToMessageId: 'm1',
    targetBotId: 'developer',
    taskId: 'task-1',
    ownerOpenId: 'owner-1',
    reportToBotId: 'ceo-assistant',
    objective: 'Cross repo task',
    instruction: 'Build',
    targetWorkspace: 'core-alias',
    round: 1,
    maxRounds: 5,
    workspaceDir: resolve(baseDir, 'src'),
  });

  assert.equal(registeredMessages.length, 1);
  assert.equal(
    registeredMessages[0].workspaceDir,
    resolve(baseDir, 'src/core'),
  );
  assert.equal(registeredMessages[0].targetWorkspace, 'core-alias');
});
