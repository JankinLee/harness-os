import type { Bot, BotIdentity } from '../im/lark.js';
import type { ActiveRun } from '../core/task-abort.js';
import type { BotConfig } from '../core/bot-registry.js';
import type {
  ArbitrationFlowStore,
  CollaborationInbox,
  TechReviewFlowStore,
} from '../core/collaboration.js';
import type { ClarificationFlowStore } from '../core/clarification.js';
import type { ProductSpecFlowStore } from '../core/product-spec.js';
import type { ApprovalFlowStore } from '../core/approval.js';
import type { CapsuleLog } from '../core/capsule-log.js';
import type { SessionManager } from '../core/session-manager.js';
import type { TeamRegistry } from '../core/team-registry.js';
import type { WorkspaceResolver } from '../core/workspace-resolver.js';

export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

export interface AppRuntime {
  sessions: SessionManager;
  teamRegistry: TeamRegistry;
  workspaceResolver: WorkspaceResolver;
  activeRuns: Map<string, ActiveRun>;
  contextWindows: Map<string, number>;
  botRuntimes: Map<string, BotRuntime>;
  processedCollaborationTurns: Set<string>;
  collaborationInbox: CollaborationInbox;
  clarificationFlows: ClarificationFlowStore;
  productSpecFlows: ProductSpecFlowStore;
  approvalFlows: ApprovalFlowStore;
  arbitrationFlows?: ArbitrationFlowStore;
  techReviewFlows?: TechReviewFlowStore;
  /** 胶囊供给日志：让「下游到底看到了什么」在事后可审计、可归因 */
  capsuleLog?: CapsuleLog;
}
