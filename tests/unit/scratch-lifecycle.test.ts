import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatScratchSurvey, probeScratchOrphans } from '../../src/app/scratch-survey.js';
import { runScratchArchive, runScratchSweep, surveyScratch } from '../../src/app/scratch-cli.js';

const DAY_MS = 86_400_000;

/**
 * 所有用例都在系统临时目录内自建 `.scratch` 并 finally 清理 ——
 * 严禁向真实工作区泄漏测试碎屑（这正是 .scratch 膨胀的历史源头之一）。
 */
function withScratchRoot(run: (root: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'scratch-survey-'));
  const root = join(tmp, '.scratch');
  mkdirSync(root, { recursive: true });
  try {
    run(root);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function makeDir(root: string, name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    const full = join(dir, fileName);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function ageDir(dir: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(dir, when, when);
  // 目录自身的 mtime 不参与判定（取的是目录内文件的最大 mtime）。
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else utimesSync(full, when, when);
    }
  }
}

test('.scratch 探针：区分「有主的活跃目录」与「无主停滞目录」', () => {
  withScratchRoot((root) => {
    const linked = makeDir(root, 'owned-feature', { 'spec.md': '# spec' });
    const stale = makeDir(root, 'abandoned-probe', { 'notes.md': '# notes' });
    const fresh = makeDir(root, 'in-flight-probe', { 'draft.md': '# draft' });
    const empty = makeDir(root, 'empty-shell');
    ageDir(linked, 30);
    ageDir(stale, 12);
    ageDir(fresh, 1);

    const survey = probeScratchOrphans({
      root,
      referencedPaths: ['.scratch/owned-feature/spec.md'],
    });
    const byName = new Map(survey.dirs.map((d) => [d.name, d]));

    assert.equal(byName.get('owned-feature')?.classification, 'linked');
    assert.equal(
      byName.get('owned-feature')?.suggested,
      'keep',
      '被活跃方案流引用的目录即便 30 天没动也不能列为归档候选',
    );

    assert.equal(byName.get('abandoned-probe')?.classification, 'orphan');
    assert.equal(byName.get('abandoned-probe')?.suggested, 'archive');
    assert.equal(byName.get('abandoned-probe')?.staleDays, 12);

    assert.equal(
      byName.get('in-flight-probe')?.suggested,
      'keep',
      '租期内的无主目录可能是在飞的 Ad-hoc 排查，不得列为候选',
    );

    assert.equal(byName.get('empty-shell')?.classification, 'empty');
    assert.equal(byName.get('empty-shell')?.suggested, 'archive');

    assert.equal(survey.totals.archiveCandidates, 2);
    // 目录内含子路径时，引用匹配必须支持前缀路径。
    makeDir(linked, 'issues', { '01.md': '# issue' });
    const nested = probeScratchOrphans({
      root,
      referencedPaths: ['.scratch/owned-feature/issues/01.md'],
    });
    assert.equal(nested.dirs.find((d) => d.name === 'owned-feature')?.classification, 'linked');
  });
});

test('.scratch 探针：暴露根目录散落文件（违反 <feature>/ 纪律的直接证据）', () => {
  withScratchRoot((root) => {
    makeDir(root, 'a-feature', { 'x.md': 'x' });
    writeFileSync(join(root, 'loose-note.md'), 'loose', 'utf8');
    writeFileSync(join(root, 'test-friction-123.json'), '{}', 'utf8');

    const survey = probeScratchOrphans({ root });
    assert.deepEqual(survey.strayFiles.sort(), ['loose-note.md', 'test-friction-123.json']);
    assert.match(formatScratchSurvey(survey), /散落文件 2 个/);
  });
});

test('.scratch 探针：归档区自身不参与候选判定，只作为存量体积呈现', () => {
  withScratchRoot((root) => {
    makeDir(root, '.archive/20260917_old-thing', { 'ARCHIVE_MANIFEST.md': 'x' });
    makeDir(root, 'live-thing', { 'a.md': 'a' });

    const survey = probeScratchOrphans({ root });
    assert.equal(survey.dirs.length, 1, '.archive 不得出现在待治理列表里');
    assert.equal(survey.dirs[0].name, 'live-thing');
    assert.ok(survey.archived.sizeBytes > 0, '归档存量应被计量，否则人看不到真正的沉积规模');
  });
});

test('.scratch 探针：根目录不存在时降级为空报告，且必须与"扫到了但没东西"可区分', () => {
  const missing = probeScratchOrphans({ root: join(tmpdir(), 'definitely-not-here-xyz') });
  assert.deepEqual(missing.dirs, []);
  assert.equal(missing.rootExists, false);
  // 「扫了个空」与「这里是干净的」对操作者的含义完全相反，不得同渲染。
  assert.match(formatScratchSurvey(missing), /根目录不存在/);
  assert.doesNotMatch(formatScratchSurvey(missing), /无滞留资产/);

  withScratchRoot((root) => {
    const empty = probeScratchOrphans({ root });
    assert.equal(empty.rootExists, true);
    assert.match(formatScratchSurvey(empty), /无滞留资产/);
  });
});

test('.scratch 软归档：被在飞方案流持有的目录必须拒绝，且与探针结论同源', () => {
  withScratchRoot((root) => {
    makeDir(root, 'held-feature', { 'spec.md': '# spec' });
    makeDir(root, 'free-feature', { 'notes.md': '# notes' });

    // 构造一份只含一条 in_development 流的方案流文件
    const flowFile = join(root, '..', 'flows.json');
    writeFileSync(
      flowFile,
      JSON.stringify([
        {
          token: 'tok-held',
          taskId: 'task-1',
          botId: 'product',
          sessionId: 'sess-1',
          ownerOpenId: 'ou_owner',
          lifecycle: 'in_development',
          request: {
            deliveryMode: 'local',
            title: 't',
            summary: 's',
            specPath: '.scratch/held-feature/spec.md',
            ticketsPath: '.scratch/held-feature/tickets.md',
          },
          status: 'approved',
        },
      ]),
      'utf8',
    );

    // 探针说"保留"……
    const survey = surveyScratch(root, flowFile);
    assert.equal(survey.dirs.find((d) => d.name === 'held-feature')?.classification, 'linked');
    assert.equal(survey.dirs.find((d) => d.name === 'held-feature')?.suggested, 'keep');

    // ……归档命令就必须拒绝，否则工具自相矛盾（先建议保留、再照做归档）。
    const refused = runScratchArchive('held-feature', root, flowFile);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /仍被在飞方案流持有/);
    assert.match(refused.message, /tok-held/, '拒绝理由必须点名持有者，否则人无法处置');
    assert.equal(existsSync(join(root, 'held-feature', 'spec.md')), true, '拒绝必须无副作用');

    // 未被持有的目录照常可归档
    assert.equal(runScratchArchive('free-feature', root, flowFile).ok, true);
  });
});

test('.scratch 软归档：显式授权后原子移送，且可一字不差地撤回', () => {
  withScratchRoot((root) => {
    const feature = makeDir(root, 'abandoned-probe', { 'notes.md': '# notes' });
    const outside = join(root, 'keep-me', 'inner.md');
    mkdirSync(join(root, 'keep-me'), { recursive: true });
    writeFileSync(outside, 'untouched', 'utf8');

    const outcome = runScratchArchive('abandoned-probe', root);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.targetDir);
    assert.equal(existsSync(feature), false, '原路径必须已经不存在');
    assert.equal(existsSync(join(outcome.targetDir!, 'notes.md')), true, '内容必须完整保留');
    assert.equal(existsSync(join(outcome.targetDir!, 'ARCHIVE_MANIFEST.md')), true);
    assert.equal(existsSync(outside), true, '同批次其它目录不得被波及');

    // 可逆性：撤回 = rename 回原路径。
    renameSync(outcome.targetDir!, feature);
    assert.equal(existsSync(join(feature, 'notes.md')), true);
  });
});

test('.scratch 软归档：越界名与受保护目标一律拒绝，且不产生任何副作用', () => {
  withScratchRoot((root) => {
    const probeDir = makeDir(root, 'some-feature', { 'a.md': 'a' });

    for (const bad of ['../src', '..\\src', ' nested ', '..', '.', 'a/b', '']) {
      const outcome = runScratchArchive(bad, root);
      assert.equal(outcome.ok, false, `非法名 ${JSON.stringify(bad)} 必须被拒绝`);
    }

    // .archive 内部不得被移送（archiver 的受保护区域守卫）
    assert.equal(runScratchArchive('.archive', root).ok, false);

    // 全程无副作用：原目录仍在原位
    assert.equal(existsSync(join(probeDir, 'a.md')), true);
  });
});

test('.scratch 软归档：归档目录名取本地日历日，与宿主时区一致', () => {
  withScratchRoot((root) => {
    makeDir(root, 'dated-feature', { 'a.md': 'a' });
    const outcome = runScratchArchive('dated-feature', root);
    assert.equal(outcome.ok, true);
    const now = new Date();
    const localDay = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');
    assert.ok(
      outcome.targetDir!.includes(`${localDay}_dated-feature`),
      `归档目录名应带本地日期前缀 ${localDay}，实际为 ${outcome.targetDir}`,
    );
  });
});

test('.scratch 软归档：目录不存在时给出「不存在」而不是「失败」的区分', () => {
  withScratchRoot((root) => {
    const outcome = runScratchArchive('never-existed', root);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /目录不存在/);
  });
});

test('.scratch 批量巡检：自动扫描并移送超过 7 天无改动的目录，保留租期内与在飞目录', () => {
  withScratchRoot((root) => {
    const stale = makeDir(root, 'stale-feature', { 'doc.md': '# stale doc' });
    const fresh = makeDir(root, 'fresh-feature', { 'doc.md': '# fresh doc' });
    const held = makeDir(root, 'held-stale-feature', { 'spec.md': '# held spec' });
    const empty = makeDir(root, 'empty-feature');

    ageDir(stale, 10);
    ageDir(fresh, 2);
    ageDir(held, 15);

    const flowFile = join(root, '..', 'flows.json');
    writeFileSync(
      flowFile,
      JSON.stringify([
        {
          token: 'tok-sweep-held',
          taskId: 'task-sweep-1',
          botId: 'product',
          sessionId: 'sess-sweep-1',
          ownerOpenId: 'ou_owner',
          lifecycle: 'in_development',
          request: {
            deliveryMode: 'local',
            title: 'held title',
            summary: 'held summary',
            specPath: '.scratch/held-stale-feature/spec.md',
            ticketsPath: '.scratch/held-stale-feature/tickets.md',
          },
          status: 'approved',
        },
      ]),
      'utf8',
    );

    const result = runScratchSweep(root, flowFile, { staleAfterDays: 7 });

    assert.equal(result.totalScanned, 4);
    assert.equal(result.candidateCount, 2); // stale, empty（held-stale-feature 已被探针识别为 linked/keep）
    assert.equal(result.archivedCount, 2); // stale, empty
    assert.equal(result.preserved.length, 2); // fresh, held-stale-feature
    assert.ok(result.preserved.some((p) => p.name === 'held-stale-feature' && p.classification === 'linked'));

    // 原路径断言
    assert.equal(existsSync(stale), false, '超期无引用目录必须被移出原位置');
    assert.equal(existsSync(empty), false, '空目录必须被移出原位置');
    assert.equal(existsSync(fresh), true, '租期内目录必须保留在原位');
    assert.equal(existsSync(held), true, '被在飞方案流持有的目录即便超期也必须保留在原位');

    // 归档目标与备忘断言
    assert.ok(result.manifestPath);
    assert.equal(existsSync(result.manifestPath!), true, '必须生成 SWEEP_MANIFEST.md');
    const manifestText = readFileSync(result.manifestPath!, 'utf8');
    assert.match(manifestText, /# 工作区清理巡检封存清单/);
    assert.match(manifestText, /stale-feature/);
    assert.match(manifestText, /empty-feature/);
    assert.match(manifestText, /held-stale-feature/);
    assert.match(manifestText, /fresh-feature/);

    // 各目录归档备忘
    const staleArchived = result.archived.find((a) => a.name === 'stale-feature');
    assert.ok(staleArchived?.targetDir);
    assert.equal(existsSync(join(staleArchived.targetDir, 'doc.md')), true);
    assert.equal(existsSync(join(staleArchived.targetDir, 'ARCHIVE_MANIFEST.md')), true);
  });
});

test('.scratch 批量巡检：dryRun 模式下只收集计划归档，不产生物理移送且不写清单', () => {
  withScratchRoot((root) => {
    const emptyFlowFile = join(root, '..', 'empty-flows.json');
    writeFileSync(emptyFlowFile, '[]', 'utf8');
    const stale = makeDir(root, 'dry-stale', { 'a.md': 'a' });
    ageDir(stale, 10);

    const result = runScratchSweep(root, emptyFlowFile, { dryRun: true, staleAfterDays: 7 });
    assert.equal(result.candidateCount, 1);
    assert.equal(result.archivedCount, 1);
    assert.equal(existsSync(stale), true, 'dryRun 不得移动目录');
    assert.equal(result.manifestPath, undefined, 'dryRun 不得写清单');
  });
});

test('.scratch 批量巡检：无候选与根目录不存在时优雅幂等返回', () => {
  withScratchRoot((root) => {
    const emptyFlowFile = join(root, '..', 'empty-flows.json');
    writeFileSync(emptyFlowFile, '[]', 'utf8');
    makeDir(root, 'fresh-only', { 'b.md': 'b' });
    const emptyResult = runScratchSweep(root, emptyFlowFile, { staleAfterDays: 7 });
    assert.equal(emptyResult.candidateCount, 0);
    assert.equal(emptyResult.archivedCount, 0);
    assert.equal(emptyResult.ok, true);
  });

  const missingResult = runScratchSweep(join(tmpdir(), 'missing-scratch-xyz-999'));
  assert.equal(missingResult.totalScanned, 0);
  assert.equal(missingResult.ok, true);
});

test('.scratch 批量巡检：连续多次巡检增量追加清单且标题引言不重复堆叠', () => {
  withScratchRoot((root) => {
    const emptyFlowFile = join(root, '..', 'empty-flows.json');
    writeFileSync(emptyFlowFile, '[]', 'utf8');

    // 第一次巡检：归档 batch1
    const b1 = makeDir(root, 'batch1', { '1.md': '1' });
    ageDir(b1, 10);
    const r1 = runScratchSweep(root, emptyFlowFile, { staleAfterDays: 7 });
    assert.equal(r1.archivedCount, 1);
    assert.ok(r1.manifestPath);

    const manifest1 = readFileSync(r1.manifestPath!, 'utf8');
    assert.equal((manifest1.match(/# 工作区清理巡检封存清单/g) || []).length, 1);
    assert.equal((manifest1.match(/## 巡检批次:/g) || []).length, 1);

    // 第二次巡检：归档 batch2
    const b2 = makeDir(root, 'batch2', { '2.md': '2' });
    ageDir(b2, 10);
    const r2 = runScratchSweep(root, emptyFlowFile, { staleAfterDays: 7 });
    assert.equal(r2.archivedCount, 1);

    const manifest2 = readFileSync(r2.manifestPath!, 'utf8');
    // 断言标题和引言只出现一次
    assert.equal((manifest2.match(/# 工作区清理巡检封存清单/g) || []).length, 1);
    assert.equal((manifest2.match(/软移送（rename）完全可逆/g) || []).length, 1);
    // 断言包含两个批次
    assert.equal((manifest2.match(/## 巡检批次:/g) || []).length, 2);
    assert.match(manifest2, /batch1/);
    assert.match(manifest2, /batch2/);
  });
});
