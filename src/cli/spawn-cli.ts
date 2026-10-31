import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export function killCli(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!child.pid) return void child.kill(signal);
  if (process.platform !== 'win32') return void child.kill(signal);
  // taskkill /T 把 cmd 连同它下面的 claude.exe/codex.exe 整棵进程树一起杀
  spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

// shell:true 时 Node 只拼接参数不转义，cmd.exe 会把参数里的双引号当语法吃掉
// （例如 JSON 参数变成 {mcpServers:...}）。这里整体包双引号、内部双引号写成 \"，
// cmd 在引号区内会把 \" 还原为字面引号。
function escapeCmdArg(arg: string): string {
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['ignore', 'pipe', 'pipe'] },
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions['stdio'] },
): ChildProcessByStdio<any, any, any> {
  if (process.platform !== 'win32') {
    return spawn(command, args, options);
  }
  const formattedCommand = command.includes(' ') && !command.startsWith('"')
    ? `"${command}"`
    : command;
  return spawn(formattedCommand, args.map(escapeCmdArg), {
    ...options,
    shell: true,
    windowsHide: true,
  });
}
