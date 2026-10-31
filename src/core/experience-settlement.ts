import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ExperienceCandidate {
  id: string;
  workspaceKey: string;
  pattern: string;
  description: string;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'candidate' | 'nominated' | 'approved' | 'rejected';
}

export class ExperienceCandidateStore {
  // 内存排队锁：消除火焰式并发异步文件写入下的读改写覆盖 (Lost Update 风险防御)
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async synchronized<T>(operation: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await operation();
    } finally {
      release!();
    }
  }

  async load(): Promise<ExperienceCandidate[]> {
    try {
      if (!existsSync(this.filePath)) return [];
      const content = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      // 形状校验必须显式做：合法 JSON 不等于合法水箱。
      // 若放进一个 `{}` / `null`，load() 会"成功"返回它，随后 recordHit 里的 .find 抛 TypeError，
      // 而调用点（friction-recorder）只 warn 不抛 —— 于是摩擦计次静默停在 1，永远到不了 ≥3。
      // 走 catch 反而更安全：损坏内容会被留档备份，水箱回到空态并从下一次摩擦重新计。
      if (!Array.isArray(parsed)) {
        throw new Error(`水箱内容不是数组（实际为 ${parsed === null ? 'null' : typeof parsed}）`);
      }
      return parsed as ExperienceCandidate[];
    } catch (err) {
      // 损坏内容安全留档备份，绝不静默抹除水箱数据
      if (existsSync(this.filePath)) {
        const corruptBackup = `${this.filePath}.corrupt-${Date.now()}`;
        await copyFile(this.filePath, corruptBackup).catch(() => {});
        console.error(`[经验水箱] 数据解析异常，已自动备份至 ${corruptBackup}: ${(err as Error).message}`);
      }
      return [];
    }
  }

  async save(candidates: ExperienceCandidate[]): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    // 原子落盘：先写临时文件后原子重命名，杜绝断电或进程中断产生半截损坏文件
    const tmpPath = `${this.filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await writeFile(tmpPath, `${JSON.stringify(candidates, null, 2)}\n`, 'utf8');
    await rename(tmpPath, this.filePath);
  }

  /**
   * 自动对系统常见运行摩擦进行归类并记录计次，达到 3 次时触发候选提名
   */
  async recordFriction(options: {
    category: 'CARD_SCHEMA_ERROR' | 'GATE_INTERCEPTION' | 'STEP_TIMEOUT' | 'RUNAWAY_CIRCUIT_BROKEN' | 'COLLABORATION_DISPUTE' | 'SUBPROCESS_ESCAPE' | 'CONTROL_FLOW_UNHANDLED';
    details: string;
    workspaceKey?: string;
    targetDcInboxDir?: string;
  }): Promise<{ candidate: ExperienceCandidate; nominated: boolean; exportPath?: string }> {
    const workspaceKey = options.workspaceKey ?? 'harness-os';
    const id = `friction-${options.category.toLowerCase().replaceAll('_', '-')}`;
    const pattern = `自动摩擦沉淀：${options.category}`;
    const description = options.details.slice(0, 500);

    const candidate = await this.recordHit({
      id,
      workspaceKey,
      pattern,
      description,
    });

    let exportPath: string | undefined;
    const nominated = candidate.hitCount >= 3;
    if (nominated && options.targetDcInboxDir) {
      exportPath = await this.exportToDcArticle(candidate.id, options.targetDcInboxDir);
    }

    return { candidate, nominated, exportPath };
  }

  async recordHit(options: {
    id: string;
    workspaceKey: string;
    pattern: string;
    description: string;
  }): Promise<ExperienceCandidate> {
    return this.synchronized(async () => {
      const list = await this.load();
      const now = new Date().toISOString();
      let found = list.find((c) => c.id === options.id && c.workspaceKey === options.workspaceKey);

      if (found) {
        found.hitCount += 1;
        found.lastSeenAt = now;
        if (found.hitCount >= 3 && found.status === 'candidate') {
          found.status = 'nominated';
        }
      } else {
        found = {
          id: options.id,
          workspaceKey: options.workspaceKey,
          pattern: options.pattern,
          description: options.description,
          hitCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          status: 'candidate',
        };
        list.push(found);
      }

      await this.save(list);
      return found;
    });
  }

  /**
   * 将经过 3 次复现沉淀的经验候选一键反哺输出为 DC 标准 Markdown Pattern
   */
  async exportToDcArticle(candidateId: string, targetDir: string): Promise<string> {
    return this.synchronized(async () => {
      const list = await this.load();
      const item = list.find((c) => c.id === candidateId);
      if (!item) throw new Error(`经验候选不存在: ${candidateId}`);

      const safeTitle = item.pattern.replace(/[/\\?%*:|"<>]/g, '-').toLowerCase();
      const fileName = `pattern-${safeTitle}.md`;
      const targetPath = join(targetDir, fileName);

      const evidenceSection = item.description
        ? `\n### 真实物理证据\n\`\`\`text\n${item.description}\n\`\`\`\n`
        : '';

      const content = [
        '---',
        `title: "${item.pattern}"`,
        `slug: "${item.id}"`,
        `workspace: "${item.workspaceKey}"`,
        `hit_count: ${item.hitCount}`,
        `settled_at: "${new Date().toISOString()}"`,
        'type: "anti-pattern-case"',
        '---',
        '',
        `# 架构经验沉淀：${item.pattern}`,
        '',
        '## 1. 现象与踩坑模式',
        item.description,
        evidenceSection,
        '## 2. 产生机理与根因剖析',
        `本模式已在 \`${item.workspaceKey}\` 工作区复现累计 ${item.hitCount} 次，触发反合理化自愈机制。`,
        '',
        '## 3. 防御量规与标准解法',
        '- 遵循第一性原理与上下文物理隔离（M11 Isolate）；',
        '- 严格执行瘦宿主治理与确定性门禁拦截；',
        '- 定位模式根因，优先通过测试、Linter 或状态机契约物理消除，杜绝依赖人工自觉。',
        '',
      ].filter(Boolean).join('\n');

      await mkdir(targetDir, { recursive: true });
      await writeFile(targetPath, content, 'utf8');

      item.status = 'approved';
      await this.save(list);

      return targetPath;
    });
  }
}
