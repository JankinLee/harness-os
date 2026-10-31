/**
 * 飞书任务卡片：把 CLI 事件整理成稳定、低噪音的任务进度。
 */
import type { CliRunStats, CliSessionSummary } from '../cli/types.js';
import type { ClarificationFlow } from '../core/clarification.js';
import {
  LIFECYCLE_ARCHIVE_MS,
  type ProductSpecFlow,
} from '../core/product-spec.js';
import type {
  TaskActivity,
  TaskProgressSnapshot,
} from '../core/task-progress.js';
import type { ScheduledTask } from '../core/schedule.js';
import { scheduleDescription, scheduleKindLabel } from '../core/schedule.js';
import type { ScheduledRun } from '../core/schedule-run-store.js';
// lark.ts 对 card.ts 只有 `import type`（编译期擦除），故此处不存在运行时循环依赖。
import { fitFeishuText } from './lark.js';
import type { ApprovalFlow } from '../core/approval.js';
import {
  ARBITRATION_SUSPEND_MS,
  NEGOTIATION_MAX_ROUNDS,
  type ArbitrationFlow,
} from '../core/collaboration.js';

export type CardJson = Record<string, unknown>;
export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled';

function formatScheduleTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export interface TaskCardOptions {
  title: string;
  status: TaskStatus;
  detail: string;
  progress?: TaskProgressSnapshot;
  answer?: string;
  stats?: CliRunStats;
  technicalDetail?: string;
  abortSessionId?: string;
}

export interface ResumeCardOptions {
  agentSessionId: string;
  cliName: string;
  currentCliSessionId?: string;
  sessions: CliSessionSummary[];
}

export interface SessionNoticeCardOptions {
  title: string;
  detail: string;
  template?: 'blue' | 'green' | 'grey';
}

export interface QueueWaitingCardOptions {
  holderId: string;
  holderContext?: {
    id: string;
    botId?: string;
    botRole?: string;
    taskSubject?: string;
    chatId?: string;
    threadId?: string;
    startedAt?: number;
    lastActivityAt?: number;
    renewCount?: number;
  };
  queuePosition: number;
  timeoutMs: number;
  elapsedMs?: number;
  isHolderActive?: boolean;
  renewCount?: number;
  mode?: 'read' | 'write';
  sessionId?: string;
  workspacePath?: string;
  canSpawnWorktree?: boolean;
}

export function buildQueueWaitingCard(options: QueueWaitingCardOptions): CardJson {
  const holder = options.holderContext;
  const holderDisplayName = holder?.botRole
    ? `${holder.botId ?? 'Agent'} (${holder.botRole})`
    : options.holderId;
  const taskSubject = holder?.taskSubject ? `「${holder.taskSubject}」` : '正在执行任务';
  const isActive = options.isHolderActive ?? true;
  const activeBadge = isActive ? '🟢 **活跃中**' : '🟡 **疑似静默**';

  const elapsedSec = Math.floor((options.elapsedMs ?? 0) / 1000);
  const remainingSec = Math.max(0, Math.floor((options.timeoutMs - (options.elapsedMs ?? 0)) / 1000));
  const queuePos = options.queuePosition;
  const queueDesc =
    queuePos <= 1
      ? `队列第 **1** 位（前方无其他排队者）· 已等待 ${elapsedSec} 秒`
      : `队列第 **${queuePos}** 位（前方 ${queuePos - 1} 个任务等待中）· 已等待 ${elapsedSec} 秒`;

  const renewCount = options.renewCount ?? 0;
  const renewText =
    renewCount > 0
      ? `（已触发 ${renewCount} 次自适应阶梯续期，心跳活跃将继续保护）`
      : '（心跳活跃将自适应阶梯续期）';
  const timeoutDesc = `自适应阶梯保护：预计剩余 ${remainingSec} 秒 ${renewText}`;

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**占用者**：${escapeFeishuMarkdown(holderDisplayName)}`,
        `**执行目标**：${escapeFeishuMarkdown(taskSubject)}`,
        `**状态看板**：${activeBadge} · ${queueDesc}`,
        `**保护窗口**：${timeoutDesc}`,
      ].join('\n'),
    },
    { tag: 'hr' },
  ];

  // 交互按钮操作栏
  const buttons: Record<string, unknown>[] = [];

  // 1. [继续等待 (延长 5 分钟)]
  buttons.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '继续等待 (+5m)' },
    type: 'primary',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'extend_queue_wait',
          sessionId: options.sessionId,
          workspacePath: options.workspacePath,
          holderId: options.sessionId ? `session:${options.sessionId.slice(0, 8)}` : undefined,
        },
      },
    ],
  });

  // 2. [转为只读探查]
  if (options.mode === 'write') {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '转为只读探查' },
      type: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'switch_to_readonly',
            sessionId: options.sessionId,
            workspacePath: options.workspacePath,
            holderId: options.sessionId ? `session:${options.sessionId.slice(0, 8)}` : undefined,
          },
        },
      ],
    });
  }

  // 3. [派生 Worktree 并行] (仅在显式配置开启且环境受控时呈现，默认不主动引导普通排队用户派生，以保全宿主依赖环境稳定)
  if (options.canSpawnWorktree === true) {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '派生 Worktree 隔离执行' },
      type: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'spawn_worktree',
            sessionId: options.sessionId,
            workspacePath: options.workspacePath,
          },
        },
      ],
    });
  }

  // 4. [取消排队]
  if (options.sessionId) {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '取消本次排队' },
      type: 'danger',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'abort_task',
            sessionId: options.sessionId,
          },
        },
      ],
    });
  }

  elements.push(...buttons);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `排队等待工作区：前方第 ${queuePos} 位` },
    },
    header: {
      template: isActive ? 'blue' : 'yellow',
      title: { tag: 'plain_text', content: '排队等待工作区' },
      subtitle: {
        tag: 'plain_text',
        content: isActive
          ? `当前被 ${holderDisplayName} 占用中`
          : `⚠️ ${holderDisplayName} 疑似静默无心跳`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export interface TeamCardMember {
  id: string;
  displayName: string;
  role: string;
  cliName: string;
  skills: string[];
  isLeader: boolean;
  ready: boolean;
}

export interface TeamCardOptions {
  members: TeamCardMember[];
}

export interface CollaborationCardOptions {
  senderName: string;
  targetName: string;
  reportToName: string;
  workspaceName: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
}

export interface ClarificationCardOptions {
  flow: ClarificationFlow;
}

const STATUS_STYLE = {
  running: { template: 'blue', label: '执行中' },
  success: { template: 'green', label: '已完成' },
  failed: { template: 'red', label: '执行失败' },
  cancelled: { template: 'grey', label: '已取消' },
} as const;

const COMPACT_ANSWER_LENGTH = 900;
const MAX_CARD_ANSWER_LENGTH = 6_000;
const RUNNING_ACTIVITY_LIMIT = 3;
const FINISHED_ACTIVITY_LIMIT = 8;

const TOOL_ICONS: Record<string, string> = {
  Agent: '🧩',
  Bash: '⌘',
  Edit: '✏️',
  Glob: '📁',
  Grep: '🔎',
  Read: '📄',
  Task: '🧩',
  TaskOutput: '⏳',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Write: '📝',
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}

function formatCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

function escapeInlineCode(value: string): string {
  return value.replaceAll('`', 'ˋ');
}

export function escapeFeishuMarkdown(value: string): string {
  return value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, '<&zwj;');
}

function activityLine(activity: TaskActivity): string {
  const icon = activity.failed ? '⚠️' : (TOOL_ICONS[activity.toolName] ?? '⚙️');
  const detail = activity.detail
    ? ` · \`${escapeInlineCode(activity.detail)}\``
    : '';
  const duration =
    activity.durationMs >= 1_000
      ? ` · ${formatDuration(activity.durationMs)}`
      : '';
  return `${icon} ${activity.label}${detail}${duration}`;
}

function markdownSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length;
  const paragraph = text.lastIndexOf('\n\n', maxLength);
  if (paragraph >= maxLength * 0.55) return paragraph;
  const line = text.lastIndexOf('\n', maxLength);
  return line >= maxLength * 0.55 ? line : maxLength;
}

function closeOpenFence(markdown: string): string {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown;
}

function markdownPreview(text: string, maxLength: number): string {
  return closeOpenFence(
    text.slice(0, markdownSplitIndex(text, maxLength)).trim(),
  );
}

function compactAnswerPreview(answer: string): string {
  const fenceIndex = answer.search(/\n```/);
  const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer;
  const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
    .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, '')
    .trim();
  return preview.length >= 40
    ? preview
    : '回答包含较多代码与细节，展开后可以查看完整内容。';
}

function usageTotal(stats: CliRunStats | undefined): number | undefined {
  if (!stats) return undefined;
  if (stats.totalTokens !== undefined) return stats.totalTokens;
  const values = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function formatContextUsage(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): string | undefined {
  if (usedTokens === undefined) return undefined;
  if (windowTokens === undefined || windowTokens <= 0) {
    return `当前上下文约 ${formatCount(usedTokens)} tokens`;
  }
  if (usedTokens > windowTokens) return undefined;
  const percentage = Math.round((usedTokens / windowTokens) * 100);
  return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`;
}

function formatContextGrowth(
  usedTokens: number | undefined,
  startTokens: number | undefined,
  startedNewSession = false,
): string | undefined {
  if (usedTokens === undefined || startTokens === undefined) return undefined;
  const delta = usedTokens - startTokens;
  const change =
    delta >= 0
      ? `新增 ${formatCount(delta)}`
      : `减少 ${formatCount(Math.abs(delta))}`;
  const startLabel = startedNewSession ? '新会话基础' : '本轮开始';
  return `${startLabel} ${formatCount(startTokens)} · ${change}`;
}

function buildRunningElements(
  options: TaskCardOptions,
): Record<string, unknown>[] {
  const progress = options.progress;
  const currentIcon = progress?.currentToolName
    ? `${TOOL_ICONS[progress.currentToolName] ?? '⚙️'} `
    : '';
  const currentDetail = progress?.currentDetail
    ? `\n\`${escapeInlineCode(progress.currentDetail)}\``
    : '';
  const meta = progress
    ? `${formatDuration(progress.elapsedMs)} · ${progress.toolCount} 次工具调用`
    : '刚刚开始';
  const context = formatContextUsage(
    progress?.contextUsedTokens,
    progress?.contextWindowTokens,
  );
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  );
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**${currentIcon}${progress?.current ?? options.detail}**${currentDetail}\n\n${meta}${context ? `\n_${context}_` : ''}${contextGrowth ? `\n_${contextGrowth}_` : ''}`,
    },
  ];
  if (progress?.activities.length) {
    const visible = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT);
    elements.push({
      tag: 'markdown',
      content: `**最近完成（${visible.length} / ${progress.completedCount}）**\n${visible.map(activityLine).join('\n')}`,
    });
  }
  if (options.abortSessionId) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '停止任务' },
      type: 'danger',
      width: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'abort_task',
            sessionId: options.abortSessionId,
          },
        },
      ],
    });
  }
  return elements;
}

function buildFinishedElements(
  options: TaskCardOptions,
): Record<string, unknown>[] {
  const progress = options.progress;
  const durationMs = options.stats?.durationMs ?? progress?.elapsedMs;
  const totalTokens = usageTotal(options.stats);
  const context = formatContextUsage(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    options.stats?.contextWindowTokens ?? progress?.contextWindowTokens,
  );
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  );
  const executionMeta = [
    durationMs !== undefined
      ? `**耗时** ${formatDuration(durationMs)}`
      : undefined,
    progress ? `**工具调用** ${progress.toolCount} 次` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const usageMeta = [
    totalTokens !== undefined
      ? `**累计消耗** ${formatCount(totalTokens)} tokens`
      : undefined,
    context
      ? `**当前上下文** ${context.replace(/^当前上下文(?:约)?\s+/, '')}`
      : undefined,
    contextGrowth ? `**本轮变化** ${contextGrowth}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  const meta = [executionMeta, usageMeta].filter(Boolean).join('\n\n');
  const elements: Record<string, unknown>[] = [];

  if (options.status === 'success') {
    const answer = options.answer || options.detail;
    if (answer.length <= COMPACT_ANSWER_LENGTH) {
      elements.push({ tag: 'markdown', content: escapeFeishuMarkdown(answer) });
    } else {
      elements.push({
        tag: 'markdown',
        content: `${escapeFeishuMarkdown(compactAnswerPreview(answer))}\n\n_完整回答已收起_`,
      });
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看完整回答'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [
          {
            tag: 'markdown',
            content: escapeFeishuMarkdown(
              markdownPreview(answer, MAX_CARD_ANSWER_LENGTH),
            ),
          },
        ],
      });
    }
    if (answerNeedsContinuation(answer)) {
      elements.push({
        tag: 'markdown',
        content: '_回答较长，剩余内容已继续发送。_',
      });
    }
  } else {
    elements.push({ tag: 'markdown', content: `**${options.detail}**` });
    if (options.technicalDetail) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看错误详情'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [
          {
            tag: 'markdown',
            content: `\`${escapeInlineCode(options.technicalDetail)}\``,
          },
        ],
      });
    }
  }

  if (meta || progress?.activities.length) {
    const visible =
      progress?.activities.slice(0, FINISHED_ACTIVITY_LIMIT) ?? [];
    const activityText = visible.length
      ? `\n\n**最近执行轨迹**\n${visible.map(activityLine).join('\n')}`
      : '';
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: collapsibleHeader('执行详情'),
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: `${meta || options.detail}${activityText}`,
        },
      ],
    });
  }
  return elements;
}

function collapsibleHeader(content: string): Record<string, unknown> {
  return {
    title: { tag: 'plain_text', content },
    vertical_align: 'center',
    icon: {
      tag: 'standard_icon',
      token: 'down-small-ccm_outlined',
      size: '16px 16px',
    },
    icon_position: 'right',
    icon_expanded_angle: -180,
  };
}

export function buildTaskCard(options: TaskCardOptions): CardJson {
  const style = STATUS_STYLE[options.status];
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: {
        tag: 'plain_text',
        content: `${options.title} · ${style.label}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements:
        options.status === 'running'
          ? buildRunningElements(options)
          : buildFinishedElements(options),
    },
  };
}

function clarificationButton(
  flow: ClarificationFlow,
  option: { id: string; label: string },
): Record<string, unknown> {
  const question = flow.request.questions[flow.currentIndex];
  const recommendedOptionId =
    question.recommendedOptionId ?? question.options[0]?.id;
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content:
        option.id === recommendedOptionId
          ? option.label.includes('推荐')
            ? option.label
            : `${option.label}（推荐）`
          : option.label,
    },
    type: 'default',
    width: 'fill',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'answer_clarification',
          flowToken: flow.token,
          questionId: question.id,
          optionId: option.id,
        },
      },
    ],
  };
}

function clarificationAnswerSummary(flow: ClarificationFlow): string {
  return flow.answers
    .map((answer, index) =>
      [
        `${index + 1}. **${escapeFeishuMarkdown(answer.prompt)}**`,
        `${answer.source === 'agent' ? 'Agent 推荐' : '你的选择'}：${escapeFeishuMarkdown(answer.answer)}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function clarificationDecisionButton(
  flow: ClarificationFlow,
  decisionMode: 'current' | 'remaining',
): Record<string, unknown> {
  const question = flow.request.questions[flow.currentIndex];
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content:
        decisionMode === 'current' ? '这一题交给 Agent 决定' : '按推荐方案继续',
    },
    type: decisionMode === 'remaining' ? 'primary' : 'default',
    width: 'fill',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'answer_clarification',
          flowToken: flow.token,
          questionId: question.id,
          decisionMode,
        },
      },
    ],
  };
}

export function buildClarificationCard(
  options: ClarificationCardOptions,
): CardJson {
  const { flow } = options;
  const question = flow.request.questions[flow.currentIndex];
  const current = flow.currentIndex + 1;
  const total = flow.request.questions.length;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}（${current}/${total}）` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: flow.request.title },
      subtitle: { tag: 'plain_text', content: `${current} / ${total}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        ...(flow.request.intro && flow.currentIndex === 0
          ? [
              {
                tag: 'markdown',
                content: escapeFeishuMarkdown(flow.request.intro),
              },
            ]
          : []),
        ...(flow.answers.length
          ? [
              {
                tag: 'markdown',
                content: `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
              },
              { tag: 'hr' },
            ]
          : []),
        {
          tag: 'markdown',
          content: `**${escapeFeishuMarkdown(question.prompt)}**\n\n选择最符合预期的一项：`,
        },
        ...question.options.map((option) => clarificationButton(flow, option)),
        clarificationDecisionButton(flow, 'current'),
        { tag: 'hr' },
        {
          tag: 'form',
          name: `clarify_${flow.token.slice(0, 8)}`,
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'input',
              name: 'custom_answer',
              placeholder: {
                tag: 'plain_text',
                content: '都不合适？在这里写下你的答案',
              },
              max_length: 500,
            },
            {
              tag: 'button',
              name: 'submit_custom',
              action_type: 'form_submit',
              text: { tag: 'plain_text', content: '提交自定义答案' },
              type: 'primary',
              width: 'default',
              size: 'medium',
              value: {
                action: 'answer_clarification',
                flowToken: flow.token,
                questionId: question.id,
                custom: true,
              },
            },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content:
            '不想逐项选择？Agent 会保留你已经确认的答案，并为剩余问题采用推荐方案。',
        },
        clarificationDecisionButton(flow, 'remaining'),
      ],
    },
  };
}

export function buildClarificationContinuingCard(
  flow: ClarificationFlow,
): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：正在整理` },
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `${flow.request.title} · 正在整理`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**答案已收到**',
            '正在基于这些选择整理产品说明，无需重复点击。',
            `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
          ].join('\n\n'),
        },
      ],
    },
  };
}

export function buildClarificationSupersededCard(
  flow: ClarificationFlow,
): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已收到新的补充` },
    },
    header: {
      template: 'grey',
      title: {
        tag: 'plain_text',
        content: `${flow.request.title} · 已更新`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**已收到你在话题里的新消息**',
            '这张卡片已经失效，HarnessOS 正在沿用同一个任务上下文处理新的补充。',
            flow.answers.length
              ? `此前已确认 ${flow.answers.length} 项，相关答案会一并带入。`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  };
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function buildResumeCard(options: ResumeCardOptions): CardJson {
  const elements: Record<string, unknown>[] = options.sessions.length
    ? options.sessions.flatMap((session, index) => {
        const current = session.id === options.currentCliSessionId;
        const row: Record<string, unknown> = {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '12px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 4,
              elements: [
                {
                  tag: 'markdown',
                  content: `**${escapeFeishuMarkdown(session.title)}**\n_${formatSessionTime(session.updatedAt)} · ${session.id.slice(0, 8)}_`,
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              vertical_align: 'center',
              elements: current
                ? [{ tag: 'markdown', content: '**当前会话**' }]
                : [
                    {
                      tag: 'button',
                      text: { tag: 'plain_text', content: '恢复' },
                      type: 'primary_filled',
                      size: 'medium',
                      behaviors: [
                        {
                          type: 'callback',
                          value: {
                            action: 'resume_cli_session',
                            agentSessionId: options.agentSessionId,
                            cliSessionId: session.id,
                          },
                        },
                      ],
                    },
                  ],
            },
          ],
        };
        return index === options.sessions.length - 1
          ? [row]
          : [row, { tag: 'hr' }];
      })
    : [
        {
          tag: 'markdown',
          content:
            '当前工作目录里还没有可以恢复的 CLI 会话。先完成一次任务，再用 `/new` 开启新会话。',
        },
      ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${options.cliName}：选择历史会话` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '恢复历史会话' },
      subtitle: { tag: 'plain_text', content: options.cliName },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: '选择后，当前话题会继续使用对应的 CLI 上下文。',
        },
        ...elements,
      ],
    },
  };
}

export function buildAlertCard(options: {
  title: string;
  template?: 'red' | 'yellow' | 'orange';
  detail: string;
  stderrSnippet?: string;
}): CardJson {
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: options.detail },
  ];
  if (options.stderrSnippet) {
    elements.push({
      tag: 'markdown',
      content: `**最近异常输出 (stderr 摘要)**:\n\`\`\`text\n${options.stderrSnippet.slice(-1000)}\n\`\`\``,
    });
  }
  return {
    schema: '2.0',
    config: { summary: { content: `[告警] ${options.title}` } },
    header: {
      template: options.template ?? 'red',
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export function buildWorktreeConflictCard(options: {
  branchName: string;
  targetBranch: string;
  conflictFiles: string[];
  sessionId?: string;
}): CardJson {
  const filesList = options.conflictFiles.map((f) => `- \`${escapeFeishuMarkdown(f)}\``).join('\n');
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**隔离工作树分支**：\`${escapeFeishuMarkdown(options.branchName)}\``,
        `**目标合并主干**：\`${escapeFeishuMarkdown(options.targetBranch)}\``,
        '**冲突文件列表**：',
        filesList || '_（未识别到具体文件名，检测到 merge-tree 冲突标记）_',
        '\n_系统已严格遵循人机协同安全红线，严禁在后台静默强行合并或挂死。请人工决策裁决：_',
      ].join('\n'),
    },
    { tag: 'hr' },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '保留工作树并提 PR' },
      type: 'primary',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'keep_worktree_pr',
            branchName: options.branchName,
            sessionId: options.sessionId,
          },
        },
      ],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '一键放弃并回滚分支' },
      type: 'danger',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'rollback_worktree',
            branchName: options.branchName,
            sessionId: options.sessionId,
          },
        },
      ],
    },
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `[冲突预警] 分支 ${options.branchName} 变基合并冲突` },
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '代码合并冲突 · 人机协同裁决' },
      subtitle: { tag: 'plain_text', content: '检测到主干已被更新，自动变基受阻' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export function buildSessionNoticeCard(
  options: SessionNoticeCardOptions,
): CardJson {
  return {
    schema: '2.0',
    config: { summary: { content: options.title } },
    header: {
      template: options.template ?? 'blue',
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{ tag: 'markdown', content: options.detail }],
    },
  };
}

export function buildCollaborationCard(
  options: CollaborationCardOptions,
): CardJson {
  const isLastRound = options.round >= options.maxRounds;
  const title = '协作任务已派发';
  const footer = isLastRound
    ? `这是当前任务允许的最后一次交接；结果会通知 ${options.reportToName}，由他决定下一步。`
    : `完成后，结果会自动交回 ${options.reportToName} 继续组织后续工作。`;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${title}：${options.objective}` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
      subtitle: {
        tag: 'plain_text',
        content: `${options.senderName} → ${options.targetName}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: `**${options.targetName}，请接手：${escapeFeishuMarkdown(options.objective)}**`,
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '16px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 3,
              elements: [
                {
                  tag: 'markdown',
                  content: `**项目**\n${escapeFeishuMarkdown(options.workspaceName)}`,
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 2,
              elements: [
                {
                  tag: 'markdown',
                  content: `**结果交给**\n${escapeFeishuMarkdown(options.reportToName)}`,
                },
              ],
            },
          ],
        },
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: collapsibleHeader('查看任务说明'),
          vertical_spacing: '8px',
          padding: '8px 8px 8px 8px',
          elements: [
            {
              tag: 'markdown',
              content: escapeFeishuMarkdown(
                markdownPreview(options.instruction, MAX_CARD_ANSWER_LENGTH),
              ),
            },
          ],
        },
        ...(options.expectedOutput
          ? [
              { tag: 'hr' },
              {
                tag: 'markdown',
                content: `**期望产出**\n${escapeFeishuMarkdown(options.expectedOutput)}`,
              },
            ]
          : []),
        { tag: 'hr' },
        { tag: 'markdown', content: `_${footer}_` },
      ],
    },
  };
}

export function buildScheduleCreatedCard(task: ScheduledTask): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `定时任务已创建：${task.id}` },
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '定时任务已创建' },
      subtitle: {
        tag: 'plain_text',
        content: `目标成员：${task.targetBotId}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**任务编号** \`${task.id}\``,
            `**执行内容**\n${escapeFeishuMarkdown(task.prompt)}`,
            `**调度规则** ${scheduleKindLabel(task.rule)} · ${escapeFeishuMarkdown(scheduleDescription(task.rule))}`,
            task.nextRunAt
              ? `**下一次执行** ${escapeFeishuMarkdown(formatScheduleTime(task.nextRunAt))} (Asia/Shanghai)`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  };
}

export function buildScheduleListCard(tasks: ScheduledTask[]): CardJson {
  const content = tasks.length
    ? tasks
        .map((task) =>
          [
            `**${task.id}** · ${task.status}`,
            `${escapeFeishuMarkdown(task.prompt.slice(0, 80))}`,
            `${scheduleKindLabel(task.rule)} · ${escapeFeishuMarkdown(scheduleDescription(task.rule))} · 交给 ${task.targetBotId}`,
            task.nextRunAt
              ? `下一次执行 ${escapeFeishuMarkdown(formatScheduleTime(task.nextRunAt))} (Asia/Shanghai)`
              : '下一次执行 未计算',
          ].join('\n'),
        )
        .join('\n\n')
    : '当前还没有定时任务。';
  return {
    schema: '2.0',
    config: { summary: { content: `定时任务列表：${tasks.length} 条` } },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '定时任务列表' },
      subtitle: {
        tag: 'plain_text',
        content: `${tasks.length} 条计划`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{ tag: 'markdown', content }],
    },
  };
}

/**
 * 调度回执卡片的补充上下文（执行者、耗时、模型结论）。
 *
 * 之所以把这些放在**可选**的第二参里：本渲染器此前是**零调用点的死代码**，
 * 只凭 `ScheduledRun` 无法回答"是谁跑的、跑了多久、跑出了什么"——
 * 而这三个问题恰恰是"黑盒静默跑完"里人最想知道的。
 */
export interface ScheduleRunCardContext {
  taskPrompt?: string;
  targetBotId?: string;
  targetRole?: string;
  durationMs?: number;
  /** 模型本轮的最终结论文本 */
  answer?: string;
}

const SCHEDULE_SUMMARY_LIMIT = 600;

export function buildScheduleRunCard(
  run: ScheduledRun,
  context: ScheduleRunCardContext = {},
): CardJson {
  const title = context.taskPrompt
    ? context.taskPrompt.replace(/\s+/g, ' ').slice(0, 40)
    : run.scheduleId;
  const durationLabel =
    typeof context.durationMs === 'number'
      ? `${(context.durationMs / 1000).toFixed(1)}s`
      : '';
  const executor = context.targetBotId
    ? `${context.targetRole ?? '成员'} (@${context.targetBotId})`
    : '';
  const answer = context.answer?.trim();

  return {
    schema: '2.0',
    config: { summary: { content: `定时任务回执：${run.status}` } },
    header: {
      template:
        run.status === 'succeeded'
          ? 'green'
          : run.status === 'failed'
            ? 'red'
            : 'grey',
      title: { tag: 'plain_text', content: `【定时任务回执】${title}` },
      subtitle: {
        tag: 'plain_text',
        content: `${run.scheduleId} · ${run.status}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            executor ? `**执行者** ${escapeFeishuMarkdown(executor)}` : '',
            `**计划触发** ${escapeFeishuMarkdown(run.scheduledFor)}`,
            durationLabel ? `**耗时** ${durationLabel}` : '',
            run.taskId ? `**协作任务** \`${run.taskId}\`` : '',
            run.error ? `**错误**\n${escapeFeishuMarkdown(run.error)}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        {
          tag: 'markdown',
          content: answer
            ? `**执行摘要**\n${escapeFeishuMarkdown(fitFeishuText(answer, SCHEDULE_SUMMARY_LIMIT))}`
            : '_本轮无正文结论产出（宿主已回收执行结果，见上方状态与错误）。_',
        },
      ],
    },
  };
}

export function buildTeamCard(options: TeamCardOptions): CardJson {
  const leader = options.members.find((member) => member.isLeader);
  const memberElements = options.members.map((member) => {
    const badges = [
      member.isLeader ? 'Team Leader' : '',
      member.ready ? '已连接' : '未连接',
    ]
      .filter(Boolean)
      .join(' · ');
    const skills =
      member.skills.length > 0
        ? member.skills.map((skill) => `$${skill}`).join('、')
        : '无';
    const ownership =
      member.id === 'product'
        ? '阵地：产品知识库 Wiki 与云文档 PRD 编制与归档权'
        : member.id === 'developer'
          ? '阵地：代码仓 docs/、测试套件与 ADR 写主权'
          : member.id === 'ceo-assistant'
            ? '阵地：跨项目总纲只读权与全局大盘生成权'
            : '';
    return {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(member.displayName)}**  _${badges}_`,
        `${escapeFeishuMarkdown(member.role)}`,
        `引擎：${escapeFeishuMarkdown(member.cliName)}　Skill：${escapeFeishuMarkdown(skills)}`,
        ownership ? `资产主权：${escapeFeishuMarkdown(ownership)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });

  return {
    schema: '2.0',
    config: {
      summary: { content: `Agent 团队：${options.members.length} 位成员` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Agent 团队' },
      subtitle: {
        tag: 'plain_text',
        content: leader
          ? `${options.members.length} 位成员 · ${leader.displayName} 负责统筹`
          : `${options.members.length} 位成员`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content:
            '每位成员使用自己的飞书身份、执行引擎和项目 Skill，工作目录与会话彼此独立。',
        },
        { tag: 'hr' },
        ...memberElements,
      ],
    },
  };
}

function productDocumentList(flow: ProductSpecFlow): string {
  if (flow.request.deliveryMode === 'lark-doc') {
    if (flow.request.documentUrl.includes('/wiki/')) {
      return `📚 **知识库文档 (Wiki)** · [打开文档](${flow.request.documentUrl})`;
    }
    return `☁️ **飞书云文档** · [打开文档](${flow.request.documentUrl})`;
  }
  const lines = [
    `📘 **Spec** · \`${escapeFeishuMarkdown(flow.request.specPath)}\``,
    `🎫 **Tickets** · \`${escapeFeishuMarkdown(flow.request.ticketsPath)}\``,
  ];
  if (flow.request.issuesPath) {
    lines.push(`📂 **Issues** · \`${escapeFeishuMarkdown(flow.request.issuesPath)}\``);
  }
  return lines.join('\n');
}

export function buildProductSpecApprovalCard(flow: ProductSpecFlow): CardJson {
  const elements: Record<string, unknown>[] = [];

  if (flow.request.warning) {
    elements.push({
      tag: 'markdown',
      content: `⚠️ **降级提示**：${escapeFeishuMarkdown(flow.request.warning)}`,
    });
    elements.push({ tag: 'hr' });
  }

  const specTitle = flow.request.title || '飞书云文档产品需求方案 (PRD)';
  const specSummary = flow.request.summary;

  elements.push(
    {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(specTitle)}**`,
        specSummary ? escapeFeishuMarkdown(specSummary) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**共享产物**\n${productDocumentList(flow)}`,
    },
  );

  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '确认产品方案' },
    type: 'primary_filled',
    width: 'fill',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'approve_product_spec',
          flowToken: flow.token,
        },
      },
    ],
  });

  elements.push({ tag: 'hr' });

  elements.push({
    tag: 'form',
    name: `spec_revision_${flow.token.slice(0, 8)}`,
    vertical_spacing: '8px',
    elements: [
      {
        tag: 'input',
        name: 'revision_notes',
        placeholder: {
          tag: 'plain_text',
          content: '请输入具体的修改建议（支持换行分条目描述，如：\n1. 审查轮次限制...\n2. 增加特定模块...）',
        },
        max_length: 1000,
      },
      {
        tag: 'button',
        name: 'submit_revision',
        action_type: 'form_submit',
        text: { tag: 'plain_text', content: '提出修改意见' },
        type: 'danger',
        width: 'fill',
        size: 'medium',
        value: {
          action: 'reject_product_spec',
          flowToken: flow.token,
        },
      },
    ],
  });

  elements.push({
    tag: 'markdown',
    content: '_如方案符合预期请点击确认；如有修改意见请填写后退回，产品经理将重新调整。_',
  });

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${specTitle}：待确认` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '产品文档已生成' },
      subtitle: {
        tag: 'plain_text',
        content:
          flow.request.deliveryMode === 'lark-doc'
            ? '飞书云文档待确认'
            : '本地 Spec · Tickets 待确认',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export function buildProductSpecApprovedCard(flow: ProductSpecFlow): CardJson {
  const specTitle = flow.request.title || '飞书云文档产品需求方案 (PRD)';
  const specSummary = flow.request.summary;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${specTitle}：已确认` },
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '产品方案已确认' },
      subtitle: { tag: 'plain_text', content: '产品阶段已就绪' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(specTitle)}**`,
            specSummary ? escapeFeishuMarkdown(specSummary) : '',
            `**已确认文档**\n${productDocumentList(flow)}`,
            flow.approvedAt
              ? `确认时间：${escapeFeishuMarkdown(flow.approvedAt)}`
              : '',
            '_确认结果已交回团队负责人，等待下一步安排。_',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  };
}

export function buildProductSpecExpiredCard(flow: ProductSpecFlow): CardJson {
  const specTitle = flow.request.title || '飞书云文档产品需求方案 (PRD)';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${specTitle}：已失效` },
    },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '产品方案确认已失效' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(specTitle)}**`,
            '同一任务已经提交了更新的产品方案，请查看话题中最新的确认卡。',
          ].join('\n\n'),
        },
      ],
    },
  };
}

export function buildProductSpecRevisionCard(
  flow: ProductSpecFlow,
  notes?: string,
): CardJson {
  const specTitle = flow.request.title || '飞书云文档产品需求方案 (PRD)';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${specTitle}：已退回修改` },
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '产品方案已退回修改' },
      subtitle: { tag: 'plain_text', content: '产品经理正在重修方案' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(specTitle)}**`,
            notes
              ? `**修改意见**：\n${escapeFeishuMarkdown(notes)}`
              : '用户已退回方案并提出修改要求。',
            '_产品经理正在根据修改意见重新调整方案，请稍候..._',
          ].join('\n\n'),
        },
      ],
    },
  };
}

function approvalButton(
  flow: ApprovalFlow,
  decision: 'approve' | 'reject',
  label: string,
  type: 'primary_filled' | 'danger',
  description: string,
): Record<string, unknown> {
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: `${label} · ${description}`,
    },
    type,
    width: 'default',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'decide_approval',
          flowToken: flow.token,
          decision,
        },
      },
    ],
  };
}

export function buildApprovalCard(flow: ApprovalFlow): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `高危操作审批：${flow.request.operation}` },
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '高危操作审批' },
      subtitle: {
        tag: 'plain_text',
        content: '需要你拍板才能继续',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(flow.request.operation)}**`,
            escapeFeishuMarkdown(flow.request.detail),
          ].join('\n\n'),
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: [
            `**影响范围**\n${escapeFeishuMarkdown(flow.request.impact)}`,
            `**回滚方式**\n${escapeFeishuMarkdown(flow.request.rollback)}`,
            `**处理截止** ${escapeFeishuMarkdown(formatScheduleTime(flow.expiresAt))}，超时自动拒绝`,
          ].join('\n\n'),
        },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'default',
          horizontal_spacing: '8px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'top',
              elements: [
                approvalButton(
                  flow,
                  'approve',
                  '放行',
                  'primary_filled',
                  '单次执行',
                ),
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'top',
              elements: [
                approvalButton(flow, 'reject', '拒绝', 'danger', '停止操作'),
              ],
            },
          ],
        },
        {
          tag: 'markdown',
          content:
            '_放行后开发者会继续执行已批准的操作；拒绝或超时都会让开发者停手并汇报。_',
        },
      ],
    },
  };
}

export function buildApprovalDecidedCard(flow: ApprovalFlow): CardJson {
  const approved = flow.status === 'approved';
  const expired = flow.status === 'expired';
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `高危操作审批：${flow.status}` },
    },
    header: {
      template: approved ? 'green' : 'red',
      title: {
        tag: 'plain_text',
        content: approved
          ? '操作已放行'
          : expired
            ? '审批已超时'
            : '操作已拒绝',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**操作**\n${escapeFeishuMarkdown(flow.request.operation)}`,
            flow.decidedAt
              ? `处理时间：${escapeFeishuMarkdown(flow.decidedAt)}`
              : '',
            approved
              ? '_已通知开发者继续执行。_'
              : '_已通知开发者停止该操作。_',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  };
}

export function buildApprovalContinuingCard(flow: ApprovalFlow): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: '审批结果已收到' },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '审批结果已收到' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**正在恢复开发者会话**',
            flow.status === 'approved'
              ? '审批通过，开发者会继续执行已批准的操作。'
              : '审批未通过，开发者会停止该操作并汇报结果。',
          ].join('\n\n'),
        },
      ],
    },
  };
}

export function buildArbitrationCard(flow: ArbitrationFlow): CardJson {
  // 阈值必须渲染真实值：曾把副标题硬编码为「3 轮上限」，与正文的 flow.maxRounds
  // 在 16 轮链路下自相矛盾，人类据此判断会得到错误的争议烈度。
  const negotiationMax = flow.negotiationMaxRounds ?? NEGOTIATION_MAX_ROUNDS;
  const negotiationRound = flow.negotiationRound ?? 1;
  // 触发来源必须如实呈现：升级僵局与辩证僵局是两种不同的烈度，
  // 统一渲染成「辩证 N 轮触顶」会让人类按错误的理由判断该不该亲自介入。
  const triggerLine =
    flow.trigger === 'escalation'
      ? `**收敛界状态**：下游穿刺升级次数已达上限（第 ${flow.escalations ?? '?'} / 2 次），双方无法就任务复杂度收敛（链跳第 ${flow.round} / ${flow.maxRounds} 跳）。`
      : `**收敛界状态**：辩证第 **${negotiationRound} / ${negotiationMax}** 轮触顶（链跳第 ${flow.round} / ${flow.maxRounds} 跳）。`;
  const thresholdLine = [
    triggerLine,
    '为防止无限震荡与死循环，总线已自动熔断，请人工介入裁决：',
  ].join('');

  const preliminaryLines: string[] = [];
  if (flow.preliminaryVerdict) {
    const verdictLabel =
      flow.preliminaryVerdict === 'adopt_product'
        ? '采纳 Product 方案'
        : flow.preliminaryVerdict === 'adopt_developer'
          ? '采纳 Developer 架构调整建议'
          : '弃权（争议超出 ceo 授权边界，须由人类裁定）';
    preliminaryLines.push(
      '**第一层 · ceo 初步仲裁**',
      `初裁结论：**${verdictLabel}**`,
      flow.preliminaryReasoning
        ? `初裁理由：${escapeFeishuMarkdown(flow.preliminaryReasoning)}`
        : '',
    );
  } else {
    preliminaryLines.push(
      '**第一层 · ceo 初步仲裁**',
      'ceo 未在时限内给出初裁，争议直接上浮至人类。',
    );
  }
  if (flow.preliminaryVerdict && flow.preliminaryVerdict !== 'abstain') {
    const suspendHours = Math.round(ARBITRATION_SUSPEND_MS / 3_600_000);
    preliminaryLines.push(
      flow.lowRisk
        ? `低风险判定：**通过**（探针事实 ∧ ceo 自评双条件成立）。若 ${suspendHours} 小时内无人裁决，系统将按初裁自动推进，并在交付物上显式标注本次自动采纳。`
        : `低风险判定：**未通过**（${(flow.riskReasons ?? ['条件不满足']).join('；')}）。超时后任务将转入停滞休眠等待你交互，**不会**自动推进。`,
    );
  }

  const narrativeLines = flow.narrative.length
    ? ['**仲裁叙事**', ...flow.narrative.map((line) => `- ${escapeFeishuMarkdown(line)}`)]
    : [];

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**协作目标**：${escapeFeishuMarkdown(flow.objective)}`,
        `**争议焦点 / 熔断原因**：${escapeFeishuMarkdown(flow.contradictionReason)}`,
        thresholdLine,
      ].join('\n\n'),
    },
    { tag: 'hr' },
    { tag: 'markdown', content: preliminaryLines.filter(Boolean).join('\n') },
    ...(narrativeLines.length
      ? [{ tag: 'hr' }, { tag: 'markdown', content: narrativeLines.join('\n') }]
      : []),
    { tag: 'hr' },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '按 Product 方案继续' },
      type: 'primary',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'decide_arbitration',
            flowToken: flow.token,
            decision: 'adopt_product',
          },
        },
      ],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '按 Developer 架构调整' },
      type: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'decide_arbitration',
            flowToken: flow.token,
            decision: 'adopt_developer',
          },
        },
      ],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '终止任务' },
      type: 'danger',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'decide_arbitration',
            flowToken: flow.token,
            decision: 'terminate',
          },
        },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'form',
      name: `arbitrate_${flow.token.slice(0, 8)}`,
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'input',
          name: 'custom_guidance',
          placeholder: {
            tag: 'plain_text',
            content: '或者输入你的具体仲裁裁决指令...',
          },
          max_length: 1000,
        },
        {
          tag: 'button',
          name: 'submit_custom_arbitration',
          action_type: 'form_submit',
          text: { tag: 'plain_text', content: '提交自定义仲裁裁决' },
          type: 'primary_filled',
          width: 'fill',
          size: 'medium',
          value: {
            action: 'decide_arbitration',
            flowToken: flow.token,
            custom: true,
          },
        },
      ],
    },
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `[人工仲裁] ${flow.objective} 争议熔断` },
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '多 Agent 辩证争议 · 人工仲裁' },
      subtitle: {
        tag: 'plain_text',
        content:
          flow.trigger === 'escalation'
            ? '任务复杂度争议升级触顶，触发安全熔断'
            : `辩证第 ${negotiationRound} / ${negotiationMax} 轮触顶，触发安全熔断`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

/**
 * 发散防护网熔断卡（**不是仲裁**）。
 *
 * 与仲裁的本质区别：仲裁是「双方各有道理，请第三方选一个」；
 * 熔断终止是「这条链已经跑了 16 跳仍未收敛，继续跑下去只会烧资源」。
 * 因此本卡**不提供任何立场选项**，只做告知与交接，避免把它们混为一谈。
 */
export function buildChainCircuitBreakCard(options: {
  objective: string;
  hopCount: number;
  maxHops: number;
  lastResult?: string;
}): CardJson {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**协作目标**：${escapeFeishuMarkdown(options.objective)}`,
        `**熔断原因**：链路已消耗 **${options.hopCount} / ${options.maxHops}** 跳仍未收敛，触发发散防护网熔断终止。`,
        '这与「辩证争议」不同：不是双方各有道理需要选边，而是链路本身失去了收敛趋势。系统的处置是**终止本链**，而非把分歧转交仲裁。',
        '若任务仍然成立，请在话题内重新描述目标并缩小范围重启 —— 重启会获得一条全新的链路额度。',
      ].join('\n\n'),
    },
  ];
  if (options.lastResult) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**终止时的最后一跳产出**\n\n${escapeFeishuMarkdown(options.lastResult.slice(0, 1500))}`,
      },
    );
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: {
        content: `[链路熔断] ${options.objective} 已达 ${options.maxHops} 跳上限`,
      },
    },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: '协作链路发散熔断 · 已终止' },
      subtitle: {
        tag: 'plain_text',
        content: `链跳 ${options.hopCount} / ${options.maxHops} 触顶`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

/** 生命周期的人类可读标签（治理大盘与验收卡共用，避免两处措辞漂移） */
export const LIFECYCLE_LABELS: Record<string, string> = {
  pending: '待人类确认方案',
  in_development: '研发实施中',
  delivered: '已交付待验收',
  archived: '已归档（终态）',
};

/**
 * 治理大盘（归档通道③ + 胶囊供给审计入口）。
 *
 * 两个能力合并在同一屏，是因为它们回答的是同一个问题的两面：
 * 「这份方案走到哪一步了」与「这一路上下游到底看到了什么」。
 */
export function buildGovernanceCard(options: {
  /** 超期未验收的已交付方案（delivered 且静默超过阈值） */
  staleFlows: Array<{
    token: string;
    title: string;
    taskId: string;
    idleDays: number;
  }>;
  /** 仍在生的方案（供对照，不可批量归档） */
  activeFlows: Array<{ title: string; stage: string; taskId: string }>;
  /** 最近的上下文谱系节点（谁把什么交给了谁、由哪个节点派生、摘要由谁署名） */
  capsuleEntries: Array<{
    recordedAt: string;
    fromBotId: string;
    toBotId: string;
    taskId: string;
    objective: string;
    event: 'dispatch' | 'consume';
    nodeId: string;
    parentNodeId?: string;
    summaryAuthor?: string;
    /**
     * 是否确为本链第一个节点（由调用方按完整窗口判定）。
     * 缺省时**不得**渲染成「链起点」——窗口滚走后中段节点会丢失父引用，
     * 把「上游已滚出窗口」显示成「链起点」是在界面上输出一句可证伪的假话。
     */
    isChainHead?: boolean;
  }>;
}): CardJson {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        '**超期未验收（已交付·观察期）**',
        options.staleFlows.length
          ? options.staleFlows
              .map(
                (flow) =>
                  `- ${escapeFeishuMarkdown(flow.title)}（静默 ${flow.idleDays} 天，任务 ${flow.taskId.slice(0, 8)}）`,
              )
              .join('\n')
          : '（无）',
      ].join('\n\n'),
    },
    {
      tag: 'markdown',
      content: [
        '**在生方案**',
        options.activeFlows.length
          ? options.activeFlows
              .map(
                (flow) =>
                  `- ${escapeFeishuMarkdown(flow.title)}（${flow.stage}）`,
              )
              .join('\n')
          : '（无）',
      ].join('\n\n'),
    },
    {
      tag: 'markdown',
      content: [
        '**最近上下文谱系（谁把什么交给了谁、由哪个节点派生）**',
        options.capsuleEntries.length
          ? options.capsuleEntries
              .map((entry) => {
                const arrow = entry.event === 'consume' ? '读取' : '派发';
                // 派生关系必须显式呈现：只列孤立快照时，
                // 「第 N 跳看到的与第 1 跳是否一致」在界面上无从回答。
                const derived = entry.parentNodeId
                  ? `（派生自 ${entry.parentNodeId.slice(0, 8)}）`
                  : entry.isChainHead
                    ? '（链起点）'
                    : '（上游节点已滚出审计窗口）';
                const author = entry.summaryAuthor
                  ? `｜摘要署名 ${entry.summaryAuthor}`
                  : '';
                return `- [${arrow}] ${entry.fromBotId} → ${entry.toBotId}｜${escapeFeishuMarkdown(entry.objective)}${derived}${author}`;
              })
              .join('\n')
          : '（暂无记录：只有装配了上下文胶囊的派发才会落档）',
      ].join('\n\n'),
    },
  ];

  if (options.staleFlows.length > 0) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: `批量归档全部 ${options.staleFlows.length} 份超期方案`,
        },
        type: 'danger',
        width: 'fill',
        size: 'medium',
        behaviors: [
          {
            type: 'callback',
            value: { action: 'archive_stale_specs' },
          },
        ],
      },
    );
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: '[治理大盘] 生命周期与上下文供给' },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '治理大盘 · 生命周期与上下文供给' },
      subtitle: {
        tag: 'plain_text',
        content: `${options.staleFlows.length} 份超期 · ${options.activeFlows.length} 份在生`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export interface DeliveryReviewCardOptions {
  flow: ProductSpecFlow;
  devSummary?: string;
  testPassed?: boolean;
  /**
   * 卡片所处阶段。同一张卡在生命周期内**原地演进**，而不是每变一次就新发一张——
   * 新发卡片在语义上暗示「这是一件新事」，而验收/打回只是同一件事的下一状态。
   */
  stage?: 'review' | 'accepted' | 'rejected';
  /** 打回原因（stage='rejected' 时展示） */
  rejectReason?: string;
}

export function buildDeliveryReviewCard(options: DeliveryReviewCardOptions): CardJson {
  const { flow, devSummary, testPassed } = options;
  const stage = options.stage ?? 'review';
  const specTitle = flow.request.title || '产品功能方案';

  // 观察期信息：**必须与归档巡检共用同一计时基准**（lifecycleUpdatedAt），
  // 否则卡片上写着「还剩 3 天」而巡检当天就归档了——显示与实际不一致比不显示更糟。
  const acceptedAt = flow.acceptedAt ? new Date(flow.acceptedAt) : undefined;
  const observedDays = acceptedAt
    ? Math.max(0, Math.floor((Date.now() - acceptedAt.getTime()) / 86_400_000))
    : 0;
  const archiveDueAt = flow.lifecycleUpdatedAt
    ? new Date(flow.lifecycleUpdatedAt + LIFECYCLE_ARCHIVE_MS)
    : undefined;
  const stageLine =
    stage === 'accepted'
      ? [
          '🟢 **业务已验收 · 观察中**',
          `已观察 ${observedDays} 天${
            archiveDueAt
              ? `，预计 ${archiveDueAt.toISOString().slice(0, 10)} 自动归档`
              : ''
          }`,
        ].join('｜')
      : stage === 'rejected'
        ? '🟡 **验收未通过 · 已打回研发**'
        : '🔵 **待人类验收**';

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**方案名称**：${escapeFeishuMarkdown(specTitle)}`,
        `**生命周期**：${LIFECYCLE_LABELS[flow.lifecycle ?? 'pending']}`,
        stageLine,
        stage === 'rejected' && options.rejectReason
          ? `**打回原因**：${escapeFeishuMarkdown(options.rejectReason)}`
          : '',
        `**交付文档**：\n${productDocumentList(flow)}`,
        devSummary ? `**研发实施简报**：\n${escapeFeishuMarkdown(devSummary)}` : '',
        flow.devReport?.writtenBackToDocument
          ? '📄 研发实施简报**已回写云文档**，与话题内卡片同源。'
          : '',
        // 三态而非二态：缺省时**不得**渲染成"已全绿通过"——那是拿未提供的字段当背书
        testPassed === true
          ? '🟢 **自动化测试与代码审查**：已全绿通过'
          : testPassed === false
            ? '🟡 **测试状态**：部分测试待人工复验'
            : '⚪ **测试状态**：未提供（请在验收时人工确认）',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  // 按阶段渲染可操作项：
  // - review：验收 / 立即归档 / 打回（三选一）
  // - accepted：只留二级【立即归档封存】——验收已完成，再给验收按钮就是自相矛盾的界面
  // - rejected：不留任何操作（等研发回传新交付）
  if (stage === 'review') {
    elements.push(
    { tag: 'hr' },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '确认业务验收 (进入观察期)' },
      type: 'primary_filled',
      width: 'fill',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'accept_delivery',
            flowToken: flow.token,
          },
        },
      ],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '立即归档并释放监听' },
      type: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'archive_spec',
            flowToken: flow.token,
          },
        },
      ],
    },
    { tag: 'hr' },
    {
      // 打回归正是两段式验收的必要另一极：只有「通过」没有「退回」时，
      // 验收卡会把「不确定」逼成「勉强通过」，问题被推到观察期之后才暴露。
      tag: 'form',
      name: `delivery_reject_${flow.token.slice(0, 8)}`,
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'input',
          name: 'reject_reason',
          placeholder: {
            tag: 'plain_text',
            content: '打回归正：请写明未通过验收的具体原因与需返工的部分...',
          },
          max_length: 1000,
        },
        {
          tag: 'button',
          name: 'submit_delivery_reject',
          action_type: 'form_submit',
          text: { tag: 'plain_text', content: '打回归正（退回研发）' },
          type: 'danger',
          width: 'fill',
          size: 'medium',
          value: {
            action: 'reject_delivery',
            flowToken: flow.token,
          },
        },
      ],
    },
    );
  } else if (stage === 'accepted') {
    // 两段式的第二段：验收通过后透出【立即归档封存】
    elements.push({ tag: 'hr' }, {
      tag: 'button',
      text: { tag: 'plain_text', content: '立即归档封存' },
      type: 'default',
      width: 'fill',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: { action: 'archive_spec', flowToken: flow.token },
        },
      ],
    });
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `[交付验收] ${specTitle}` },
    },
    header: {
      template:
        stage === 'accepted' ? 'green' : stage === 'rejected' ? 'yellow' : 'blue',
      title: {
        tag: 'plain_text',
        content:
          stage === 'accepted'
            ? '业务已验收 · 观察期中'
            : stage === 'rejected'
              ? '验收未通过 · 已打回研发'
              : '研发实施已完成 · 业务验收',
      },
      subtitle: {
        tag: 'plain_text',
        content:
          stage === 'accepted'
            ? '文档维持已交付，监听保持就绪'
            : stage === 'rejected'
              ? '已退回研发阶段'
              : '已完成单测与代码审查，请人类拍板',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

/** 归档完成卡（三通道共用同一张，只替换通道文案） */
export function buildProductSpecArchivedCard(
  flow: ProductSpecFlow,
  channelLabel: string,
): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `[已归档] ${flow.request.title ?? '产品方案'}` },
    },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '方案已归档 · 监听已释放' },
      subtitle: { tag: 'plain_text', content: channelLabel },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**方案名称**：${escapeFeishuMarkdown(flow.request.title ?? '产品功能方案')}`,
            `**归档通道**：${escapeFeishuMarkdown(channelLabel)}`,
            '该方案已走完「待确认 → 研发中 → 已交付 → 已归档」全生命周期，云文档评论监听已释放。',
            '归档是终态：后续如需继续推进，请在话题内重新发起（会建立一份全新的方案流）。',
          ].join('\n\n'),
        },
      ],
    },
  };
}

export function buildArbitrationResolvedCard(flow: ArbitrationFlow): CardJson {
  const isTerminated = flow.selectedOption === 'terminate';
  const decisionText =
    flow.selectedOption === 'adopt_product'
      ? '按 Product 方案继续推进'
      : flow.selectedOption === 'adopt_developer'
        ? '按 Developer 架构建议调整'
        : isTerminated
          ? '终止当前协作任务'
          : flow.customGuidance || '已完成人工裁决';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `[仲裁已裁决] ${flow.objective}` },
    },
    header: {
      template: isTerminated ? 'grey' : 'green',
      title: { tag: 'plain_text', content: '人工仲裁已完成' },
      subtitle: { tag: 'plain_text', content: '已将裁决注入后续任务流' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**协作目标**\n${escapeFeishuMarkdown(flow.objective)}`,
            `**裁决结论**\n${escapeFeishuMarkdown(decisionText)}`,
            flow.resolvedAt ? `**裁决时间**\n${escapeFeishuMarkdown(flow.resolvedAt)}` : '',
            isTerminated
              ? '_任务已由人工仲裁终止。_'
              : '_已将裁决指令注入 CEO 助理，团队将按新指令推进。_',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  };
}

export function answerNeedsContinuation(answer: string): boolean {
  return answer.length > MAX_CARD_ANSWER_LENGTH;
}

export function answerContinuation(answer: string): string {
  return answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH));
}

export function splitLongText(text: string, maxLength = 4_000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const newline = remaining.lastIndexOf('\n', maxLength);
    const splitAt = newline > maxLength / 2 ? newline : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

type UpdateCard = (card: CardJson) => Promise<void>;

/** 一秒窗口内无论 push 多少次，只提交最新的一张卡片。 */
export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private updateChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 1_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) return;
    this.pendingCard = card;
    this.schedule();
  }

  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain.catch(() => undefined);
    await this.updateCard(finalCard);
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain.catch(() => undefined);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, this.intervalMs);
  }

  private flushPending(): void {
    const card = this.pendingCard;
    this.pendingCard = undefined;
    if (!card || this.closed) return;

    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      // catch 必须挂在链上、且**吞掉**异常：
      // 1) 链条一旦进入 rejected 状态，后续所有 .then 回调都会被跳过 ——
      //    一次瞬时的 PATCH 失败会让进度卡永久冻结在最后一帧，而 CLI 还在继续跑，
      //    人看到的是一张"运行中"的活卡，实际早已停止更新，且没有任何提示；
      // 2) 这个 promise 在 finish()/cancel() 认领之前无人接管，
      //    悬空的 rejected promise 会走 unhandledRejection（Node 22 默认终止进程）。
      .catch((error) => {
        console.warn(
          '[卡片] 进度更新失败（已降级，后续更新继续进行）:',
          (error as Error).message,
        );
      })
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule();
      });
  }
}
