import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceResolver, isPathInside } from '../../src/core/workspace-resolver.js';
import { parseHarnessOsConfig, loadHarnessOsConfig } from '../../src/core/bot-registry.js';
import { TeamRegistry } from '../../src/core/team-registry.js';

test('isPathInside correctly checks boundary', () => {
  const parent = resolve('/repo/parent');
  const child = resolve('/repo/parent/sub/dir');
  const outside = resolve('/repo/other');

  assert.equal(isPathInside(child, parent), true);
  assert.equal(isPathInside(outside, parent), false);
  assert.equal(isPathInside(parent, parent), true);
});

test('WorkspaceResolver resolves default and aliases', () => {
  const baseDir = resolve('/mock/base');
  const resolver = new WorkspaceResolver({
    defaultWorkspace: '../default-repo',
    workspaces: {
      'core': '../core-repo',
      'app': './sub-app',
    },
    baseDirectory: baseDir,
    trustedRoots: [resolve('/mock')],
  });

  // Default
  assert.equal(resolver.resolve(), resolve('/mock/default-repo'));
  assert.equal(resolver.resolve(''), resolve('/mock/default-repo'));

  // Alias hit
  assert.equal(resolver.resolve('core'), resolve('/mock/core-repo'));
  assert.equal(resolver.resolve('app'), resolve('/mock/base/sub-app'));
  assert.equal(resolver.getAlias(resolve('/mock/core-repo')), 'core');

  // Relative path within trusted root
  assert.equal(
    resolver.resolve('./custom', baseDir),
    resolve('/mock/base/custom'),
  );
});

test('WorkspaceResolver blocks directory traversal attack', () => {
  const baseDir = resolve('/mock/base');
  const resolver = new WorkspaceResolver({
    defaultWorkspace: './safe',
    baseDirectory: baseDir,
    trustedRoots: [baseDir],
  });

  // Traversal attack
  assert.throws(
    () => {
      resolver.resolve('../../outside', baseDir);
    },
    {
      message: /目录穿越或非受信任路径拦截/,
    },
  );
});

test('parseHarnessOsConfig parses root defaultWorkspace and workspaces', () => {
  const env = {
    FEISHU_LEADER_APP_ID: 'cli_123',
    FEISHU_LEADER_APP_SECRET: 'sec_123',
  };
  const input = {
    teamLeader: 'leader',
    defaultWorkspace: '../default-ws',
    workspaces: {
      'proj-a': '../proj-a',
    },
    bots: [
      {
        id: 'leader',
        appIdEnv: 'FEISHU_LEADER_APP_ID',
        appSecretEnv: 'FEISHU_LEADER_APP_SECRET',
        defaultCli: 'claude',
        role: 'Team Leader',
      },
    ],
  };

  const parsed = parseHarnessOsConfig(input, env, resolve('/mock/app'));
  assert.equal(parsed.defaultWorkspaceDir, resolve('/mock/default-ws'));
  assert.equal(parsed.workspaces['proj-a'], resolve('/mock/proj-a'));
  assert.equal(parsed.bots[0].workspaceDir, resolve('/mock/default-ws'));
});

test('loadHarnessOsConfig loads and validates bots.example.json with updated product & developer prompts', async () => {
  const env = {
    FEISHU_CEO_ASSISTANT_APP_ID: 'test_id',
    FEISHU_CEO_ASSISTANT_APP_SECRET: 'test_sec',
    FEISHU_PRODUCT_APP_ID: 'test_id',
    FEISHU_PRODUCT_APP_SECRET: 'test_sec',
    FEISHU_DEVELOPER_APP_ID: 'test_id',
    FEISHU_DEVELOPER_APP_SECRET: 'test_sec',
    FEISHU_GUARDRAIL_APP_ID: 'test_id',
    FEISHU_GUARDRAIL_APP_SECRET: 'test_sec',
  };

  const exampleConfig = await loadHarnessOsConfig('config/bots.example.json', env, resolve('.'));
  assert.equal(exampleConfig.teamLeaderId, 'ceo-assistant');
  assert.equal(exampleConfig.wikiSpaceId, '<your-wiki-space-id>');
  const productBot = exampleConfig.bots.find((b) => b.id === 'product');
  assert.ok(productBot?.skills.includes('lark-wiki'));
  assert.ok(productBot?.systemPrompt.includes('lark-cli wiki/docs 执行空间与文档治理'));

  const devBot = exampleConfig.bots.find((b) => b.id === 'developer');
  assert.ok(devBot?.systemPrompt.includes('lark-cli docs +fetch'));
});

test('loadHarnessOsConfig loads the local-only example without lark skills', async () => {
  const env = {
    FEISHU_CEO_ASSISTANT_APP_ID: 'test_id',
    FEISHU_CEO_ASSISTANT_APP_SECRET: 'test_sec',
    FEISHU_PRODUCT_APP_ID: 'test_id',
    FEISHU_PRODUCT_APP_SECRET: 'test_sec',
    FEISHU_DEVELOPER_APP_ID: 'test_id',
    FEISHU_DEVELOPER_APP_SECRET: 'test_sec',
  };

  const localConfig = await loadHarnessOsConfig(
    'config/bots.local.example.json',
    env,
    resolve('.'),
  );
  assert.equal(localConfig.teamLeaderId, 'ceo-assistant');
  assert.equal(localConfig.defaultProductDeliveryMode, 'local');
  assert.equal(localConfig.wikiSpaceId, undefined);
  const productBot = localConfig.bots.find((b) => b.id === 'product');
  assert.ok(productBot?.skills.includes('grill-me'));
  assert.ok(!productBot?.skills.some((skill) => skill.startsWith('lark-')));
  const devBot = localConfig.bots.find((b) => b.id === 'developer');
  assert.ok(devBot?.skills.includes('implement-ticket'));
});

test('TeamRegistry.contextFor JIT asset probe includes public workspace docs', async () => {
  const env = {
    FEISHU_CEO_ASSISTANT_APP_ID: 'test_id',
    FEISHU_CEO_ASSISTANT_APP_SECRET: 'test_sec',
    FEISHU_PRODUCT_APP_ID: 'test_id',
    FEISHU_PRODUCT_APP_SECRET: 'test_sec',
    FEISHU_DEVELOPER_APP_ID: 'test_id',
    FEISHU_DEVELOPER_APP_SECRET: 'test_sec',
  };

  const exampleConfig = await loadHarnessOsConfig('config/bots.example.json', env, resolve('.'));
  const registry = new TeamRegistry(exampleConfig.teamLeaderId, exampleConfig.bots);
  const tempWorkspace = mkdtempSync(join(tmpdir(), 'harness-os-team-context-'));

  try {
    writeFileSync(join(tempWorkspace, 'README.md'), '# Example workspace\n', 'utf8');
    mkdirSync(join(tempWorkspace, 'docs'), { recursive: true });
    writeFileSync(
      join(tempWorkspace, 'docs', 'ARCHITECTURE.md'),
      '# Architecture\n',
      'utf8',
    );
    writeFileSync(join(tempWorkspace, 'package.json'), '{}\n', 'utf8');

    const context = registry.contextFor('developer', tempWorkspace);
    assert.ok(context.includes('项目说明：README.md'));
    assert.ok(context.includes('公开架构文档：docs/ARCHITECTURE.md'));
    assert.ok(context.includes('依赖与脚本清单：package.json'));
  } finally {
    rmSync(tempWorkspace, { recursive: true, force: true });
  }
});


