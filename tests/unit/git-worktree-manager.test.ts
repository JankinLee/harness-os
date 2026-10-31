import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorktreeManager } from '../../src/core/git-worktree-manager.js';
import { buildWorktreeConflictCard } from '../../src/im/card.js';

const execFileAsync = promisify(execFile);

test('P2-1 & P2-3: GitWorktreeManager creates isolated worktree, links node_modules, mirrors .env, and merges or detects conflicts', async (t) => {
  const manager = GitWorktreeManager.getInstance();
  const testRoot = mkdtempSync(join(tmpdir(), 'worktree-test-repo-'));

  try {
    await execFileAsync('git', ['init', '-b', 'master'], { cwd: testRoot });
    await execFileAsync('git', ['config', 'user.name', 'TestBot'], { cwd: testRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRoot });

    // Create mock main files
    mkdirSync(join(testRoot, 'node_modules', 'mock-pkg'), { recursive: true });
    writeFileSync(join(testRoot, 'node_modules', 'mock-pkg', 'index.js'), 'module.exports = "mock";');
    writeFileSync(join(testRoot, '.env'), 'HARNESS_OS_SECRET=token123\n');
    writeFileSync(join(testRoot, 'README.md'), '# Main Repo\nInitial line\n');

    await execFileAsync('git', ['add', 'README.md'], { cwd: testRoot });
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: testRoot });

    const isGit = await manager.isGitRepo(testRoot);
    assert.equal(isGit, true);

    // 1. Create worktree
    const threadId = 'test_thread_p2';
    const worktree = await manager.createWorktree(testRoot, threadId);

    assert.ok(existsSync(worktree.worktreePath));
    assert.match(worktree.branchName, /feat-worktree-test_thread_p2/);

    // Verify node_modules junction/symlink exists
    const targetNodeModules = join(worktree.worktreePath, 'node_modules');
    assert.ok(existsSync(targetNodeModules));
    assert.ok(existsSync(join(targetNodeModules, 'mock-pkg', 'index.js')));

    // Verify .env auto-mirror
    const targetEnv = join(worktree.worktreePath, '.env');
    assert.ok(existsSync(targetEnv));
    assert.equal(readFileSync(targetEnv, 'utf-8'), 'HARNESS_OS_SECRET=token123\n');

    // 2. Commit a change in worktree
    const worktreeFile = join(worktree.worktreePath, 'feature.txt');
    writeFileSync(worktreeFile, 'Worktree parallel feature\n');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: worktree.worktreePath });
    await execFileAsync('git', ['commit', '-m', 'feat: add worktree feature'], { cwd: worktree.worktreePath });

    // 3. Probe and merge non-conflicting branch
    const probe = await manager.probeMergeConflict(testRoot, 'master', worktree.branchName);
    assert.equal(probe.hasConflict, false);

    const mergeResult = await manager.mergeWorktreeBranch(testRoot, worktree.branchName, 'master');
    assert.equal(mergeResult.success, true);
    assert.equal(mergeResult.hasConflict, false);
    assert.ok(existsSync(join(testRoot, 'feature.txt')));

    // 4. Remove worktree
    await manager.removeWorktree(testRoot, worktree.worktreePath);
    assert.equal(existsSync(worktree.worktreePath), false);
  } finally {
    // Cleanup test repo
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('P2-3: buildWorktreeConflictCard renders human-in-the-loop decision card on conflict', () => {
  const card = buildWorktreeConflictCard({
    branchName: 'feat-worktree-conflict-123',
    targetBranch: 'master',
    conflictFiles: ['src/core/config.ts', 'package.json'],
    sessionId: 'sess-conflict',
  });

  assert.equal(card.schema, '2.0');
  const header = card.header as any;
  assert.equal(header.template, 'orange');
  assert.match(header.title.content, /代码合并冲突/);

  const body = card.body as any;
  const markdownElem = body.elements[0];
  assert.match(markdownElem.content, /src\/core\/config\.ts/);
  assert.match(markdownElem.content, /package\.json/);

  const buttons = body.elements.filter((e: any) => e.tag === 'button');
  assert.equal(buttons.length, 2);
  const labels = buttons.map((b: any) => b.text.content);
  assert.ok(labels.includes('保留工作树并提 PR'));
  assert.ok(labels.includes('一键放弃并回滚分支'));
});
