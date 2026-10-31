import { randomUUID } from 'node:crypto';
import type { CliId } from '../cli/types.js';
import type { SessionStore } from './session-store.js';

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed';

export interface Session {
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  cliSessionId?: string;
  engineSessionIds?: Record<string, string>;
  workspaceDir: string;
  workspaceAlias?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
  store?: SessionStore;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'idle', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
};

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  return `${botId}:${chatId}:${threadId}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: SessionStore;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      );
    }
    return manager;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    );
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = 'claude',
    botId = 'default',
    workspaceDir = process.cwd(),
    workspaceAlias?: string,
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(botId, message.chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing) return { session: existing, isNew: false };

    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId,
      workspaceDir,
      workspaceAlias,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      throw error;
    }
    return { session, isNew: true };
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空');
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined);
  }

  /**
   * 动态切换当前会话的执行引擎，并按引擎隔离保存旧 session ID，防止异构引擎恢复报错
   */
  async switchCli(sessionId: string, newCliId: CliId): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.cliId === newCliId) return current;

    const engineSessions: Record<string, string> = {
      ...(current.engineSessionIds ?? {}),
      ...(current.cliSessionId ? { [current.cliId]: current.cliSessionId } : {}),
    };
    const targetCliSessionId = engineSessions[newCliId];

    const updated: Session = {
      ...current,
      cliId: newCliId,
      cliSessionId: targetCliSessionId,
      engineSessionIds: engineSessions,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
    workspaceAlias?: string,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!workspaceDir) throw new Error('工作目录不能为空');
    if (
      current.workspaceDir === workspaceDir &&
      current.workspaceAlias === workspaceAlias
    ) {
      return current;
    }

    // 冷销毁重置核心契约：切换工作区物理目录或别名时，必须彻底清空已绑定的 cliSessionId
    const { cliSessionId: _previousCliSessionId, ...rest } = current;
    const updated: Session = {
      ...rest,
      workspaceDir,
      workspaceAlias,
      cliSessionId: undefined,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()]);
  }
}
