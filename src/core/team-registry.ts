import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from './bot-registry.js';

export interface MissingSkill {
  botId: string;
  skill: string;
  searchedPaths: string[];
}

export class TeamRegistry {
  private readonly configs = new Map<string, BotConfig>();

  constructor(
    readonly leaderBotId: string,
    configs: BotConfig[],
  ) {
    for (const config of configs) this.configs.set(config.id, config);
    if (!this.configs.has(leaderBotId)) {
      throw new Error(`Team Leader 不存在: ${leaderBotId}`);
    }
  }

  get leader(): BotConfig {
    return this.configs.get(this.leaderBotId)!;
  }

  get members(): BotConfig[] {
    return [...this.configs.values()];
  }

  get(botId: string): BotConfig | undefined {
    return this.configs.get(botId);
  }

  contextFor(currentBotId: string, workspaceDir?: string): string {
    const current = this.configs.get(currentBotId);
    if (!current) throw new Error(`团队成员不存在: ${currentBotId}`);
    const roster = this.members.map((member) => {
      const leader = member.id === this.leaderBotId ? '（Team Leader）' : '';
      const skills =
        member.skills.length > 0
          ? `；Skills：${member.skills.map((skill) => `$${skill}`).join('、')}`
          : '';
      return `- ${member.id}${leader}：${member.role}${skills}`;
    });

    const baseSections = [
      '你所在的 Agent 团队：',
      ...roster,
      `你当前以 ${current.id} 的身份工作。只处理交给你的职责；需要其他成员参与时，清楚说明希望交给谁以及期望结果。`,
      '团队名单中的成员都是真实的飞书 bot。CLI 内部子 Agent 适合处理临时分工，不能冒充这些长期团队成员。',
      '需要把任务交给其他成员时，使用 dispatch_task 工具，由 HarnessOS 发送协作卡片并真正 @ 对方。只有 CEO 助理可以在运行时调用该工具；targetBotId 必须来自上面的团队名单，不能填写自己。',
    ];

    // JIT 工作区轻量资产探针（<200 tokens，纯确定性检查，保护 KV Cache 前缀）
    const effectiveWorkspace = workspaceDir ?? current.workspaceDir;
    if (effectiveWorkspace) {
      const assetLines: string[] = [];
      const readmePath = join(effectiveWorkspace, 'README.md');
      const architecturePath = join(effectiveWorkspace, 'docs', 'ARCHITECTURE.md');
      const claudeMdPath = join(effectiveWorkspace, 'CLAUDE.md');
      const pkgPath = join(effectiveWorkspace, 'package.json');
      const scratchPath = join(effectiveWorkspace, '.scratch');
      const docsPath = join(effectiveWorkspace, 'docs');

      if (existsSync(readmePath)) {
        assetLines.push('- 项目说明：README.md');
      }
      if (existsSync(architecturePath)) {
        assetLines.push('- 公开架构文档：docs/ARCHITECTURE.md');
      } else if (existsSync(docsPath)) {
        assetLines.push('- 系统架构文档：docs/ (架构决策与全局契约)');
      }
      if (existsSync(claudeMdPath)) {
        assetLines.push('- 项目指令契约：CLAUDE.md');
      }
      if (existsSync(pkgPath)) {
        assetLines.push('- 依赖与脚本清单：package.json');
      }
      if (existsSync(scratchPath)) {
        assetLines.push('- 本地特性工作区：.scratch/');
      }

      if (assetLines.length > 0) {
        baseSections.push('【当前工作区资产探针】', ...assetLines);
      }
    }

    return baseSections.join('\n');
  }

  async findMissingSkills(): Promise<MissingSkill[]> {
    const missing: MissingSkill[] = [];
    for (const config of this.members) {
      for (const skill of config.skills) {
        const searchedPaths = [
          join(config.workspaceDir, '.agents', 'skills', skill, 'SKILL.md'),
          join(config.workspaceDir, '.claude', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.agents', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.claude', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.codex', 'skills', skill, 'SKILL.md'),
        ];
        if (!(await somePathExists(searchedPaths))) {
          missing.push({ botId: config.id, skill, searchedPaths });
        }
      }
    }
    return missing;
  }
}

async function somePathExists(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await access(path);
      return true;
    } catch {
      // 继续检查另一个项目级 Skill 目录。
    }
  }
  return false;
}
