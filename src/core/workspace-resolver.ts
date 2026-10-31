import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { ensureWorkspaceDirectory } from './workspace.js';

export interface WorkspaceMetadata {
  /** 工作区物理根目录路径 */
  path: string;
  /** 该工作区关联的飞书知识库空间 ID（如 <your-wiki-space-id>） */
  wikiSpaceId?: string;
  /** PRD 方案创建时默认挂载的父节点 token（如 <your-prd-parent-node-token>） */
  prdParentNodeToken?: string;
  /**
   * Phase 4 预留架构字段：方案生命周期归档自动化移动时迁移的目标父节点 token。
   * 当前 Phase 3 仅作类型声明与配置预留，不在本阶段触发物理节点移动。
   */
  archivedParentNodeToken?: string;
  /** 知识库空间主页链接 */
  wikiSpaceUrl?: string;
}

export interface WorkspaceMetaConfig {
  path: string;
  wikiSpaceId?: string;
  prdParentNodeToken?: string;
  archivedParentNodeToken?: string;
  wikiSpaceUrl?: string;
}

export interface WorkspaceResolverOptions {
  defaultWorkspace: string;
  workspaces?: Record<string, string | WorkspaceMetaConfig>;
  wikiSpaceId?: string;
  baseDirectory?: string;
  trustedRoots?: string[];
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const normParent = normalize(resolve(parentPath));
  const normChild = normalize(resolve(childPath));

  // Windows 下路径大小写不敏感规范化对比
  if (process.platform === 'win32') {
    const parentLower = normParent.toLowerCase();
    const childLower = normChild.toLowerCase();
    const rel = relative(parentLower, childLower);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }

  const rel = relative(normParent, normChild);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export class WorkspaceResolver {
  private readonly defaultWorkspace: string;
  private readonly aliasMap = new Map<string, string>();
  private readonly hostMetadataMap = new Map<string, WorkspaceMetaConfig>();
  private readonly globalWikiSpaceId?: string;
  private readonly baseDirectory: string;
  private readonly trustedRoots: string[];

  constructor(options: WorkspaceResolverOptions) {
    this.baseDirectory = resolve(options.baseDirectory ?? process.cwd());
    const defaultWs = (options.defaultWorkspace || '').trim();
    if (!defaultWs) {
      throw new Error('defaultWorkspace 不能为空');
    }
    this.defaultWorkspace = isAbsolute(defaultWs)
      ? resolve(defaultWs)
      : resolve(this.baseDirectory, defaultWs);

    this.globalWikiSpaceId = options.wikiSpaceId?.trim() || undefined;

    const workspaces = options.workspaces ?? {};
    for (const [alias, ws] of Object.entries(workspaces)) {
      const trimmedAlias = alias.trim();
      if (!trimmedAlias) continue;
      if (typeof ws === 'string') {
        const trimmedPath = ws.trim();
        if (!trimmedPath) continue;
        const absPath = isAbsolute(trimmedPath)
          ? resolve(trimmedPath)
          : resolve(this.baseDirectory, trimmedPath);
        this.aliasMap.set(trimmedAlias, absPath);
      } else {
        const trimmedPath = ws.path?.trim();
        if (!trimmedPath) continue;
        const absPath = isAbsolute(trimmedPath)
          ? resolve(trimmedPath)
          : resolve(this.baseDirectory, trimmedPath);
        this.aliasMap.set(trimmedAlias, absPath);
        this.hostMetadataMap.set(trimmedAlias, {
          ...ws,
          path: absPath,
        });
      }
    }

    if (options.trustedRoots && options.trustedRoots.length > 0) {
      this.trustedRoots = options.trustedRoots.map((r) => resolve(r));
    } else {
      // 默认受信任根：baseDirectory 的父级目录（支持同级多仓协作）及各已声明工作区的所在目录
      const defaultRoot = resolve(this.baseDirectory, '..');
      const candidateRoots = new Set<string>([
        defaultRoot,
        this.baseDirectory,
        resolve(this.defaultWorkspace, '..'),
        ...[...this.aliasMap.values()].map((p) => resolve(p, '..')),
      ]);
      this.trustedRoots = [...candidateRoots];
    }
  }

  getDefaultWorkspace(): string {
    return this.defaultWorkspace;
  }

  getWorkspaces(): Record<string, string> {
    return Object.fromEntries(this.aliasMap.entries());
  }

  getAlias(targetPath: string): string | undefined {
    const normalizedTarget = normalize(resolve(targetPath)).toLowerCase();
    for (const [alias, absPath] of this.aliasMap.entries()) {
      if (normalize(absPath).toLowerCase() === normalizedTarget) {
        return alias;
      }
    }
    return undefined;
  }

  /**
   * 多源解析工作区元数据（单一真理源优先级）：
   * 1. 目标工作区自包含配置 .harness-os/workspace.json
   * 2. 宿主 bots.json.workspaces[alias] 声明的对象配置
   * 3. 宿主顶层全局 wikiSpaceId 兜底
   */
  getWorkspaceMetadata(targetPathOrAlias?: string): WorkspaceMetadata {
    const resolvedPath = this.resolve(targetPathOrAlias);
    const alias = this.getAlias(resolvedPath);
    let hostMeta = alias ? this.hostMetadataMap.get(alias) : undefined;
    if (!hostMeta) {
      for (const meta of this.hostMetadataMap.values()) {
        if (normalize(meta.path).toLowerCase() === normalize(resolvedPath).toLowerCase()) {
          hostMeta = meta;
          break;
        }
      }
    }

    let localMeta: Partial<WorkspaceMetadata> | undefined;
    try {
      const localConfigFile = join(resolvedPath, '.harness-os', 'workspace.json');
      if (existsSync(localConfigFile)) {
        const content = readFileSync(localConfigFile, 'utf8');
        localMeta = JSON.parse(content);
      }
    } catch {
      // 容错处理：本地配置文件读取或解析失败时不阻断流程
    }

    const toCleanString = (val: unknown): string | undefined => {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        return trimmed ? trimmed : undefined;
      }
      if (typeof val === 'number' && Number.isFinite(val)) {
        return String(val);
      }
      return undefined;
    };

    const wikiSpaceId =
      toCleanString(localMeta?.wikiSpaceId) ||
      toCleanString(hostMeta?.wikiSpaceId) ||
      this.globalWikiSpaceId;
    const prdParentNodeToken =
      toCleanString(localMeta?.prdParentNodeToken) ||
      toCleanString(hostMeta?.prdParentNodeToken);
    const archivedParentNodeToken =
      toCleanString(localMeta?.archivedParentNodeToken) ||
      toCleanString(hostMeta?.archivedParentNodeToken);
    const wikiSpaceUrl =
      toCleanString(localMeta?.wikiSpaceUrl) ||
      toCleanString(hostMeta?.wikiSpaceUrl);

    return {
      path: resolvedPath,
      wikiSpaceId: wikiSpaceId || undefined,
      prdParentNodeToken: prdParentNodeToken || undefined,
      archivedParentNodeToken: archivedParentNodeToken || undefined,
      wikiSpaceUrl: wikiSpaceUrl || undefined,
    };
  }

  resolve(input?: string, currentCwd?: string): string {
    const value = input?.trim();
    if (!value) {
      return this.defaultWorkspace;
    }

    // 1. 别名精准命中
    if (this.aliasMap.has(value)) {
      return this.aliasMap.get(value)!;
    }

    // 2. 相对路径或绝对路径解析
    let base = currentCwd ? resolve(currentCwd) : this.baseDirectory;
    const normValue = value.replace(/\\/g, '/');
    if (/^(?:\.\/)?\.scratch(?:\/|$)/.test(normValue)) {
      const normBase = base.replace(/\\/g, '/');
      const scratchMatch = normBase.match(/(?:^|\/)\.scratch(?:\/|$)/);
      if (scratchMatch && scratchMatch.index !== undefined) {
        base = resolve(normBase.slice(0, scratchMatch.index));
      }
    }
    const resolvedPath = isAbsolute(value) ? resolve(value) : resolve(base, value);

    // 3. 安全沙箱防目录穿越校验
    const isTrusted = this.trustedRoots.some(
      (root) => isPathInside(resolvedPath, root) || resolvedPath === root,
    );

    if (!isTrusted) {
      throw new Error(`目录穿越或非受信任路径拦截: ${value} (解析为 ${resolvedPath})`);
    }

    return resolvedPath;
  }

  async resolveAndEnsure(input?: string, currentCwd?: string): Promise<string> {
    const resolved = this.resolve(input, currentCwd);
    await ensureWorkspaceDirectory(resolved);
    return resolved;
  }
}
