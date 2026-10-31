import { getCliAdapter } from '../cli/registry.js';
import type { ProductSpecFlow } from '../core/product-spec.js';
import type { Bot, IncomingDocumentComment } from '../im/lark.js';
import { executeCli } from './cli-execution.js';
import { markSessionIdle } from './session-view.js';
import type { AppRuntime } from './runtime.js';

export async function runProductDocumentComment(options: {
  runtime: AppRuntime;
  bot: Bot;
  flow: ProductSpecFlow;
  comment: IncomingDocumentComment;
}): Promise<void> {
  const { runtime, bot, flow, comment } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || session.status === 'closed') {
    throw new Error('评论对应的产品会话已经失效');
  }
  if (session.status !== 'idle') {
    throw new Error('评论对应的产品会话仍在执行其他任务');
  }

  const run = new AbortController();
  await runtime.sessions.transition(session.id, 'active');
  runtime.activeRuns.set(session.id, {
    controller: run,
    ownerOpenId: flow.ownerOpenId,
  });

  try {
    const adapter = getCliAdapter(session.cliId);
    const result = await executeCli(
      adapter,
      documentCommentPrompt(flow, comment),
      session.workspaceDir,
      session.cliSessionId,
      run.signal,
      [],
      () => undefined,
      // 角色身份必须下发，否则 MCP 侧 `checkToolRbac(undefined, …)` 直接放行。
      // 本函数只拿到 flow（没有 config），故身份取自 flow.botId —— 它正是建立该流的成员。
      { HARNESS_OS_BOT_ID: flow.botId },
      {
        holderId: `session:${session.id.slice(0, 8)}`,
      },
    );
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    await bot.replyToDocumentComment(
      comment,
      result.answer || '已按评论更新原文档，请复查。',
    );
  } finally {
    if (runtime.activeRuns.get(session.id)?.controller === run) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}

function documentCommentPrompt(
  flow: ProductSpecFlow,
  comment: IncomingDocumentComment,
): string {
  if (flow.request.deliveryMode !== 'lark-doc') {
    throw new Error('本地产品方案不能处理飞书文档评论');
  }

  const stageInstruction =
    flow.lifecycle === 'in_development'
      ? '方案当前已进入研发实施阶段（基线已锁定）。使用 lark-drive 读取评论内容并回答用户疑问或澄清细节。若评论要求修改核心契约/接口/范围，请在回复中说明该改动属于需求变更，需在群聊中沟通或在交付验收时打回归正，不得私自篡改核心验收契约；若仅为答疑或说明文字澄清，请给出清晰解答。'
      : flow.lifecycle === 'delivered'
        ? '方案当前处于已交付待验收/业务观察期。使用 lark-drive 读取评论与反馈，回答业务方疑问或记录缺陷反馈。'
        : '用户在待确认的飞书产品方案中通过评论明确提及了你。使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。';

  return [
    stageInstruction,
    `文档 URL：${flow.request.documentUrl}`,
    `文档类型：${comment.fileType}`,
    `评论 ID：${comment.commentId}`,
    comment.replyId ? `触发回复 ID：${comment.replyId}` : '',
    '最终回答只写一段给评论者看的简短说明，讲清楚答复内容或修改情况。HarnessOS 会把最终回答写回原评论。',
    '不要调用评论回复或解决接口，评论是否解决由用户复查后决定。',
    '不要调用 request_spec_approval，不要生成新的确认卡。',
  ]
    .filter(Boolean)
    .join('\n\n');
}
