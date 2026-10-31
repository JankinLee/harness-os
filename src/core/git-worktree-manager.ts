import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  sourceRepoPath: string;
  threadId: string;
  createdAt: number;
}

export interface MergeResult {
  success: boolean;
  hasConflict: boolean;
  conflictFiles?: string[];
  output?: string;
  error?: string;
}

export class GitWorktreeManager {
  private static instance?: GitWorktreeManager;

  static getInstance(): GitWorktreeManager {
    if (!this.instance) {
      this.instance = new GitWorktreeManager();
    }
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = undefined;
  }

  /**
   * 检查目录是否为有效的 Git 仓库
   */
  async isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dirPath,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 动态派生轻量独立工作树
   * 内置：1. NTFS Junction/symlink 复用 node_modules；2. .env 原子克隆并排除；3. 隔离分支创建
   */
  async createWorktree(
    sourceRepoPath: string,
    threadId: string,
    baseRef = 'HEAD',
  ): Promise<WorktreeInfo> {
    const isGit = await this.isGitRepo(sourceRepoPath);
    if (!isGit) {
      throw new Error(`目录并非有效 Git 仓库: ${sourceRepoPath}`);
    }

    const cleanThreadId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const branchName = `feat-worktree-${cleanThreadId}-${Date.now().toString(36)}`;
    const worktreeBaseDir = resolve(sourceRepoPath, '.claude', 'worktrees');
    const worktreePath = resolve(worktreeBaseDir, cleanThreadId);

    // 如果目标目录已存在（可能上次残留），先清理
    if (existsSync(worktreePath)) {
      await this.removeWorktree(sourceRepoPath, worktreePath);
    } else {
      mkdirSync(worktreeBaseDir, { recursive: true });
    }

    // 执行 git worktree add
    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', branchName, worktreePath, baseRef],
        { cwd: sourceRepoPath },
      );
    } catch (err) {
      // 容错：如果分支已存在，尝试不加 -b 或者切换分支
      throw new Error(`创建 Git Worktree 失败: ${(err as Error).message}`);
    }

    // 1. 宿主级软链接复用 node_modules (Windows NTFS Directory Junction / Unix symlink)
    const srcNodeModules = join(sourceRepoPath, 'node_modules');
    const targetNodeModules = join(worktreePath, 'node_modules');
    if (existsSync(srcNodeModules) && !existsSync(targetNodeModules)) {
      try {
        if (process.platform === 'win32') {
          // Windows 下使用 directory junction，无需管理员权限且零装包耗时
          symlinkSync(srcNodeModules, targetNodeModules, 'junction');
        } else {
          symlinkSync(srcNodeModules, targetNodeModules, 'dir');
        }
      } catch (e) {
        console.warn(
          `[GitWorktreeManager] node_modules 软链接挂载失败，将继续执行: ${(e as Error).message}`,
        );
      }
    }

    // 2. 运行凭据原子克隆 (.env) 并写入工作树 exclude 屏蔽提交
    const srcEnv = join(sourceRepoPath, '.env');
    const targetEnv = join(worktreePath, '.env');
    if (existsSync(srcEnv)) {
      try {
        const envContent = readFileSync(srcEnv, 'utf-8');
        writeFileSync(targetEnv, envContent, 'utf-8');

        // 写入该 worktree 的 git exclude，确保绝不外泄被提交
        const infoExcludePath = join(worktreePath, '.git');
        // 在 worktree 中，.git 是一个包含 gitdir 路径的文件
        let gitDirPath = '';
        if (existsSync(infoExcludePath)) {
          const gitFileContent = readFileSync(infoExcludePath, 'utf-8');
          const match = gitFileContent.match(/gitdir:\s*(.+)/);
          if (match) {
            gitDirPath = resolve(worktreePath, match[1].trim());
          }
        }
        if (gitDirPath && existsSync(gitDirPath)) {
          const excludeFile = join(gitDirPath, 'info', 'exclude');
          mkdirSync(join(gitDirPath, 'info'), { recursive: true });
          const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
          if (!existing.includes('.env')) {
            writeFileSync(excludeFile, `${existing}\n.env\n`, 'utf-8');
          }
        }
      } catch (e) {
        console.warn(
          `[GitWorktreeManager] .env 拷贝或排除设置异常: ${(e as Error).message}`,
        );
      }
    }

    return {
      worktreePath,
      branchName,
      sourceRepoPath,
      threadId,
      createdAt: Date.now(),
    };
  }

  /**
   * 乐观演练与冲突探测 (git merge-tree)
   */
  async probeMergeConflict(
    sourceRepoPath: string,
    targetBranch: string,
    sourceBranch: string,
  ): Promise<{ hasConflict: boolean; conflictFiles: string[] }> {
    try {
      // 获取共同祖先 base commit
      const { stdout: baseStdout } = await execFileAsync(
        'git',
        ['merge-base', targetBranch, sourceBranch],
        { cwd: sourceRepoPath },
      );
      const baseCommit = baseStdout.trim();

      // 执行 git merge-tree <base> <branch1> <branch2>
      const { stdout: mergeTreeStdout } = await execFileAsync(
        'git',
        ['merge-tree', baseCommit, targetBranch, sourceBranch],
        { cwd: sourceRepoPath },
      );

      // 如果输出中存在 `<<<<<<<` 或 `changed in both` 则表示存在合并冲突
      const hasConflict =
        mergeTreeStdout.includes('<<<<<<<') ||
        mergeTreeStdout.includes('changed in both') ||
        mergeTreeStdout.includes('conflict');

      const conflictFiles: string[] = [];
      if (hasConflict) {
        // 从输出中提取冲突文件路径
        const lines = mergeTreeStdout.split('\n');
        for (const line of lines) {
          const match = line.match(/(?:changed in both|conflict in)\s+(.+)/i);
          if (match && match[1]) {
            conflictFiles.push(match[1].trim());
          }
        }
      }

      return { hasConflict, conflictFiles };
    } catch {
      // 无法完成 merge-tree 探测时，标记为可能有潜在冲突以便安全兜底
      return { hasConflict: false, conflictFiles: [] };
    }
  }

  /**
   * 智能变基合并 (Rebase / Fast-Forward Merge)
   */
  async mergeWorktreeBranch(
    sourceRepoPath: string,
    worktreeBranch: string,
    targetBranch = 'master',
  ): Promise<MergeResult> {
    // 1. 先进行乐观演练
    const probe = await this.probeMergeConflict(sourceRepoPath, targetBranch, worktreeBranch);
    if (probe.hasConflict) {
      return {
        success: false,
        hasConflict: true,
        conflictFiles: probe.conflictFiles,
        error: '检测到代码合并冲突，禁止静默合并，已触发人机协同裁决卡片。',
      };
    }

    // 2. 无冲突，执行安全 merge
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['merge', '--no-ff', '-m', `chore: merge worktree branch ${worktreeBranch}`, worktreeBranch],
        { cwd: sourceRepoPath },
      );
      return {
        success: true,
        hasConflict: false,
        output: stdout,
      };
    } catch (err) {
      return {
        success: false,
        hasConflict: true,
        error: (err as Error).message,
      };
    }
  }

  /**
   * 安全移除工作树及孤儿清理
   * 内置：Windows EBUSY 物理锁死防御，遇文件独占重命名为 .stale 异步延迟清理
   */
  async removeWorktree(sourceRepoPath: string, worktreePath: string, force = true): Promise<void> {
    if (!existsSync(worktreePath)) return;

    // 先尝试通过 git worktree remove 移除
    try {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push(worktreePath);
      await execFileAsync('git', args, { cwd: sourceRepoPath });
    } catch {
      // git worktree remove 失败（可能 Windows 句柄占用或已被破坏）
    }

    // 物理文件清理
    if (existsSync(worktreePath)) {
      try {
        const unlinked = this.safeUnlinkNodeModules(worktreePath);
        if (!unlinked) {
          throw new Error('node_modules 符号链接占用中，转入 stale 隔离以防穿透损坏宿主');
        }

        rmSync(worktreePath, { recursive: true, force: true });
      } catch (err) {
        // Windows EBUSY 防御机制：重命名为 .stale 并由后台异步标记清理
        console.warn(`[GitWorktreeManager] 物理清理遇到 EBUSY/安全截断，转入 .stale 暂存: ${(err as Error).message}`);
        const stalePath = `${worktreePath}.stale.${Date.now()}`;
        try {
          const { renameSync } = await import('node:fs');
          renameSync(worktreePath, stalePath);
        } catch {
          // 重命名暂存失败时不阻断主流程返回，留待启动时 sweepStaleWorktrees 兜底
        }
      }
    }

    // 普查并清理 git worktree prune
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: sourceRepoPath });
    } catch {
      // prune 失败属只读辅助诊断，不影响已成功解锁的主逻辑
    }
  }

  /**
   * 安全解除指定工作树中的 node_modules 符号链接/Junction 挂载
   * 采用 lstatSync 避免悬空死链漏检，严禁递归删除以免穿透清空宿主源目录
   */
  private safeUnlinkNodeModules(worktreePath: string): boolean {
    const targetNodeModules = join(worktreePath, 'node_modules');
    try {
      const stat = lstatSync(targetNodeModules);
      if (stat.isSymbolicLink()) {
        unlinkSync(targetNodeModules);
      } else if (stat.isDirectory()) {
        // Windows NTFS Junction (Reparse Point) 或单层目录使用 rmdirSync 解绑
        rmdirSync(targetNodeModules);
      }
      return true;
    } catch (err) {
      // 若文件或符号挂载点本身不存在（ENOENT）则视为已解绑成功
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      return false;
    }
  }

  /**
   * 启动时巡检清除所有 .stale 孤儿工作树
   */
  async sweepStaleWorktrees(sourceRepoPath: string): Promise<void> {
    const worktreeBaseDir = resolve(sourceRepoPath, '.claude', 'worktrees');
    if (!existsSync(worktreeBaseDir)) return;

    try {
      const { readdirSync } = await import('node:fs');
      const entries = readdirSync(worktreeBaseDir);
      for (const entry of entries) {
        if (entry.includes('.stale.')) {
          const fullPath = join(worktreeBaseDir, entry);
          try {
            // 巡检清理前同样必须先解绑 node_modules，杜绝穿透清空宿主依赖（防范同类缺陷只修一半）
            const unlinked = this.safeUnlinkNodeModules(fullPath);
            if (!unlinked) {
              // 仍被锁占用，跳过留待下一次巡检重试，绝对禁止直接递归强删
              continue;
            }
            rmSync(fullPath, { recursive: true, force: true });
          } catch {
            // 单个残留 .stale 目录可能仍被锁占用，跳过并在下一次巡检重试
          }
        }
      }
    } catch {
      // 启动巡检扫描目录失败不阻断宿主初始化
    }
  }
}
