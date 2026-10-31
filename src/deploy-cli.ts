import { cac } from 'cac';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { runScratchArchive, runScratchStatus, runScratchSweep } from './app/scratch-cli.js';

const cli = cac('harness-os');

function runCommandSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) {
  if (process.platform === 'win32') {
    return spawnSync(command, args, { ...options, shell: true });
  }
  return spawnSync(command, args, options);
}

function run(parts: string[]): void {
  const result = runCommandSync(parts[0], parts.slice(1), { stdio: 'inherit' });
  if (result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`;
    console.error(`[harness-os] 命令执行失败: ${parts[0]} ${reason}`);
    process.exit(result.status ?? 1);
  }
}

function output(parts: string[]): string {
  const result = runCommandSync(parts[0], parts.slice(1), { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

/** 递归取目录下最新的文件 mtime；目录不存在返回 0 */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
      continue;
    }
    if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function ensureBuild(): void {
  const entry = 'dist/index.js';
  if (!existsSync(entry)) {
    console.log('[harness-os] 未找到 dist/index.js，先执行 pnpm build');
    run(['pnpm', 'build']);
    return;
  }

  // 「存在」不等于「新鲜」。宿主跑的是 dist/，改 src/ 不重建就毫无效果 ——
  // 而此前这里只判断存在性，于是"改动已提交"与"改动已生效"之间没有任何守卫。
  // 本轮真实发生过：公理纠偏写进 src 六小时后，生产仍在向所有 Bot 注入被撤销的旧文本，
  // 而启动命令一路放行、没有任何提示。
  if (newestMtimeMs('src') <= statSync(entry).mtimeMs) return;
  console.log('[harness-os] 检测到 src/ 比 dist/ 新（改动尚未编译进产物），先执行 pnpm build');
  run(['pnpm', 'build']);
}

function requirePm2(): void {
  if (!output(['pm2', '-v'])) {
    console.error('[harness-os] pm2 未安装，请先执行 npm install -g pm2');
    process.exit(1);
  }
}

function requireConfig(): void {
  const missing: string[] = [];
  if (!existsSync('.env')) missing.push('.env');
  if (!existsSync('config/bots.json')) missing.push('config/bots.json');
  if (missing.length) {
    console.error(`[harness-os] 缺少运行配置: ${missing.join(', ')}`);
    console.error(
      '[harness-os] 请先从开发环境复制 .env 和 config/bots.json 到当前目录',
    );
    process.exit(1);
  }
}

function localDoctor(): void {
  const checks: Array<[string, string[]]> = [
    ['node', ['-v']],
    ['pnpm', ['-v']],
    ['pm2', ['-v']],
    ['claude', ['--version']],
    ['codex', ['--version']],
  ];
  for (const [name, checkArgs] of checks) {
    const value = output([name, ...checkArgs]);
    console.log(`${name}: ${value || '未安装'}`);
  }
  console.log(`.env: ${existsSync('.env') ? '存在' : '缺失'}`);
  console.log(
    `config/bots.json: ${existsSync('config/bots.json') ? '存在' : '缺失'}`,
  );
}

function localStart(): void {
  requirePm2();
  requireConfig();
  ensureBuild();
  const running =
    runCommandSync('pm2', ['describe', 'harness-os'], { stdio: 'ignore' })
      .status === 0;
  if (running) {
    run(['pm2', 'restart', 'harness-os']);
  } else {
    run(['pm2', 'start', 'dist/index.js', '--name', 'harness-os']);
  }
  run(['pm2', 'save']);
}

cli.command('doctor', '检查本地环境与 CLI 凭证').action(localDoctor);
cli.command('start', '本地生产启动').action(localStart);
cli.command('stop', '停止本地进程').action(() => {
  requirePm2();
  run(['pm2', 'stop', 'harness-os']);
});
cli.command('restart', '重启本地进程').action(() => {
  requirePm2();
  run(['pm2', 'restart', 'harness-os']);
});
cli.command('status', '查看本地进程状态').action(() => {
  requirePm2();
  run(['pm2', 'status']);
});
cli.command('logs', '查看本地进程日志').action(() => {
  requirePm2();
  run(['pm2', 'logs', 'harness-os']);
});

// .scratch 治理工装：只读对账 + 显式软归档 + 批量清理巡检。
// 注：本版 cac 不派发含空格的命令名，故用位置参数而非 `scratch status` 二级命令。
cli.command('scratch [action] [name]', '对账/软归档/批量巡检 .scratch 滞留资产（status 只读，archive 可逆，sweep 批量巡检）').action(
  (action?: string, name?: string) => {
    if (!action || action === 'status') {
      runScratchStatus();
      return;
    }
    if (action === 'sweep') {
      const result = runScratchSweep();
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === 'archive') {
      if (!runScratchArchive(name).ok) process.exitCode = 1;
      return;
    }
    console.error(`[.scratch] 未知动作: ${action}（可用: status | sweep | archive <name>）`);
    process.exitCode = 1;
  },
);

cli.help();
cli.parse();
