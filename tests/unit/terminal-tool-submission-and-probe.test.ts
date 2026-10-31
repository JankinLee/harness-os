import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TERMINAL_CONTROL_TOOLS } from '../../src/cli/app-tools.js';
import { runCli } from '../../src/cli/runner.js';
import type { CliAdapter, CliEvent } from '../../src/cli/types.js';
import { ApprovalRequestSchema, findApprovalRequest } from '../../src/core/approval.js';
import { findRelayRequest } from '../../src/core/collaboration.js';
import { inspectToolCall } from '../../src/core/tool-call-inspection.js';
import type { CliRunResult } from '../../src/cli/types.js';
import {
  TERMINAL_TOOL_FORMS,
  mergeToolCallLists,
  repairTerminalToolSubmissions,
} from '../../src/app/terminal-tool-submission.js';
import {
  detectUnhandledTerminalCall,
  skillGatedTerminalTools,
} from '../../src/app/terminal-tool-probe.js';
import {
  attachObservedToolCalls,
  markTerminalToolRejected,
  readObservedToolCalls,
  readTerminalToolRejected,
} from '../../src/cli/failure-metadata.js';

type ToolCalls = Array<{ toolName: string; input: unknown }>;

function runResult(toolCalls: ToolCalls, answer = '本轮结论'): CliRunResult {
  return {
    answer,
    sessionId: 's-1',
    toolCalls: toolCalls.map((call, index) => ({
      toolUseId: `t-${index}`,
      ...call,
    })),
  };
}

const VALID_APPROVAL = {
  operation: '重启服务',
  detail: '重启 harness-os',
  impact: '短暂中断',
  rollback: '重新启动',
};

// ---------------------------------------------------------------- 反漂移

test('反漂移：每个终结工具的入参模板必须能通过各自的 schema 校验', () => {
  for (const form of TERMINAL_TOOL_FORMS) {
    const parsed = form.schema.safeParse(JSON.parse(form.template));
    const detail = parsed.success
      ? ''
      : parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
          .join('; ');
    assert.ok(
      parsed.success,
      `${form.toolName} 的模板已与 schema 脱节，模型照抄后仍会失败：${detail}`,
    );
  }
});

test('反漂移：全部终结型控制工具都必须在清单中登记', () => {
  const registered = new Set(TERMINAL_TOOL_FORMS.map((form) => form.toolName));
  const missing = TERMINAL_CONTROL_TOOLS.filter(
    (name) => !registered.has(name),
  );
  assert.deepEqual(
    missing,
    [],
    '新增终结工具却漏登记，会让它的调用既得不到入参纠错、也无法被准确归因',
  );
});

// ---------------------------------------------------------------- inspect*

test('inspectToolCall：调过但没解析成功时 hasCall=true，并带出最近一次错误', () => {
  const result = inspectToolCall(
    [{ toolName: 'request_approval', input: { operation: 'x' } }],
    'request_approval',
    ApprovalRequestSchema,
  );
  assert.equal(result.hasCall, true, '「调错了」不能被误判成「没调」');
  assert.equal(result.request, undefined);
  assert.match(result.lastError ?? '', /detail/);
});

test('inspectToolCall：任一调用成功即可用，且优先最近的', () => {
  const invalid = { toolName: 'request_approval', input: { operation: 'x' } };
  const valid = { toolName: 'request_approval', input: VALID_APPROVAL };
  assert.deepEqual(
    inspectToolCall([invalid, valid], 'request_approval', ApprovalRequestSchema)
      .request,
    VALID_APPROVAL,
  );
  assert.deepEqual(
    inspectToolCall([valid, invalid], 'request_approval', ApprovalRequestSchema)
      .request,
    VALID_APPROVAL,
  );
});

test('inspectToolCall：多次失败时报**最近一次**的错误（修正提示要指出上次错在哪）', () => {
  // 两条用例的缺失字段必须**互斥**，否则旧实现（留下最早一条）同样能通过，断言名不副实
  const result = inspectToolCall(
    [
      // 最早一次：缺 impact / rollback
      { toolName: 'request_approval', input: { operation: 'a', detail: 'd' } },
      // 最近一次：缺 detail（且 impact/rollback 齐备）
      { toolName: 'request_approval', input: { operation: 'b', impact: 'i', rollback: 'r' } },
    ],
    'request_approval',
    ApprovalRequestSchema,
  );
  assert.match(result.lastError ?? '', /detail/);
  assert.doesNotMatch(
    result.lastError ?? '',
    /impact/,
    '若报的是最早一条，这里会命中 impact —— 说明取了错误的失败记录',
  );
});

// ---------------------------------------------------------------- 入参纠错

test('纠错：没有解析失败时**不重试**', async () => {
  let retried = false;
  const original = runResult([
    { toolName: 'request_approval', input: VALID_APPROVAL },
  ]);
  const result = await repairTerminalToolSubmissions({
    result: original,
    retry: async () => {
      retried = true;
      return original;
    },
  });
  assert.equal(retried, false, '无失败却重试 = 白烧一轮 token');
  assert.equal(result, original);
});

test('纠错：把 schema 错误与工具名写进提示词，并采用重试后的结果', async () => {
  let prompt = '';
  const retried = runResult([], '重试后的结论');
  const result = await repairTerminalToolSubmissions({
    result: runResult([
      { toolName: 'dispatch_task', input: { targetBotId: 'product' } },
    ]),
    retry: async (nextPrompt) => {
      prompt = nextPrompt;
      return retried;
    },
  });
  assert.match(prompt, /dispatch_task/);
  assert.match(prompt, /objective/, '必须把 zod 的字段级错误回传给模型');
  assert.match(prompt, /targetBotId/, '必须给出最小合法入参示例');
  // 正文以首轮为准：重试轮通常只回一句「已重新提交」，让它成为交付简报就是失真
  assert.equal(result.answer, '本轮结论');
  assert.equal(result.sessionId, 's-1');
});

test('纠错：工具调用必须**并集**而非替换 —— 同批里已成功的终结调用不得消失', async () => {
  const original = runResult([
    { toolName: 'relay_to_peer', input: { targetBotId: 'product', instruction: '' } },
    { toolName: 'request_approval', input: VALID_APPROVAL },
  ]);
  const result = await repairTerminalToolSubmissions({
    result: original,
    retry: async () =>
      runResult([
        {
          toolName: 'relay_to_peer',
          input: { targetBotId: 'product', instruction: '补齐' },
        },
      ]),
  });
  const names = (result.toolCalls ?? []).map((call) => call.toolName);
  assert.ok(
    names.includes('request_approval'),
    '替换语义会让同批的审批请求整条消失——高危操作的人工门禁静默失效',
  );
  assert.deepEqual(
    findApprovalRequest(result.toolCalls),
    VALID_APPROVAL,
    '审批请求必须仍能被提取到',
  );
  assert.deepEqual(
    findRelayRequest(result.toolCalls),
    { targetBotId: 'product', instruction: '补齐' },
    '修正后的调用排在末尾，从后往前扫时优先命中',
  );
});

test('纠错：重试空手而归时保留原始失败调用（否则探针静默、还会谎报完成）', async () => {
  const original = runResult(
    [{ toolName: 'request_clarification', input: { questions: [] } }],
    '首轮结论',
  );
  const result = await repairTerminalToolSubmissions({
    result: original,
    retry: async () => runResult([], '我无法调用该工具'),
  });
  assert.equal(result.answer, '首轮结论', '道歉式正文不得成为本轮结论');
  const found = detectUnhandledTerminalCall({
    toolCalls: result.toolCalls,
    handledToolNames: [],
    skillGatedToolNames: [],
  });
  assert.equal(found?.cause, 'schema', '失败证据必须留给探针');
});

test('纠错：恒等重试（recon 的收口式不重试）不合并、不重复记账', async () => {
  const original = runResult([
    { toolName: 'request_escalation', input: { reason: '' } },
  ]);
  const result = await repairTerminalToolSubmissions({
    result: original,
    retry: async () => original,
  });
  assert.equal(result, original);
  assert.equal(result.toolCalls?.length, 1, '同一次调用不能被记两遍');
});

test('纠错：重试自身失败时保留原始结果（绝不丢掉本轮已产出的结论）', async () => {
  const original = runResult([
    { toolName: 'relay_to_peer', input: { instruction: '' } },
  ]);
  const result = await repairTerminalToolSubmissions({
    result: original,
    retry: async () => {
      throw new Error('CLI 挂了');
    },
  });
  assert.equal(result, original, '纠错是增强项，失败不得拖垮本轮结论');
});

test('纠错：request_spec_approval 交给专属处置，不在此重复重试', async () => {
  let retried = false;
  const original = runResult([
    { toolName: 'request_spec_approval', input: { deliveryMode: 'local' } },
  ]);
  const result = await repairTerminalToolSubmissions({
    result: original,
    retry: async () => {
      retried = true;
      return original;
    },
  });
  assert.equal(retried, false);
  assert.equal(result, original);
});

// ---------------------------------------------------------------- 探针

test('探针：已被状态机承接的调用不告警', () => {
  const calls: ToolCalls = [
    { toolName: 'dispatch_task', input: { targetBotId: 'product' } },
  ];
  assert.equal(
    detectUnhandledTerminalCall({
      toolCalls: calls,
      handledToolNames: ['dispatch_task'],
      skillGatedToolNames: [],
    }),
    undefined,
  );
});

test('探针：非终结型工具不告警', () => {
  assert.equal(
    detectUnhandledTerminalCall({
      toolCalls: [{ toolName: 'Read', input: {} }],
      handledToolNames: [],
      skillGatedToolNames: [],
    }),
    undefined,
  );
});

test('探针：越权（权限真源拒绝）→ cause=rbac，且与「没有处理流」区分开', () => {
  const found = detectUnhandledTerminalCall({
    toolCalls: [{ toolName: 'request_escalation', input: { reason: 'r' } }],
    handledToolNames: [],
    skillGatedToolNames: [],
    rbacDeniedToolNames: ['request_escalation'],
  });
  assert.equal(found?.cause, 'rbac');
  assert.match(found?.detail ?? '', /不属于当前角色的职权/);
});

test('合并：无重试时不得把同一次调用记两遍', () => {
  const calls = [
    { toolUseId: 'c1', toolName: 'request_approval', input: VALID_APPROVAL },
  ];
  assert.equal(mergeToolCallLists(calls, calls).length, 1);
  // 同 id 不同工具名一律保留：误删真实调用比重复更危险
  assert.equal(
    mergeToolCallLists(calls, [
      { toolUseId: 'c1', toolName: 'relay_to_peer', input: { instruction: 'i' } },
    ]).length,
    2,
  );
});

test('探针：技能未启用 → cause=skill（此时查配置才是对的）', () => {
  const found = detectUnhandledTerminalCall({
    toolCalls: [{ toolName: 'request_clarification', input: {} }],
    handledToolNames: [],
    skillGatedToolNames: ['request_clarification'],
  });
  assert.equal(found?.cause, 'skill');
  assert.match(found?.detail ?? '', /技能配置/);
});

test('探针：入参校验失败 → cause=schema 且带出真实错误（不再引导去查配置）', () => {
  const found = detectUnhandledTerminalCall({
    toolCalls: [
      { toolName: 'request_clarification', input: { questions: [] } },
    ],
    handledToolNames: [],
    skillGatedToolNames: [],
  });
  assert.equal(found?.cause, 'schema');
  assert.match(found?.detail ?? '', /入参未通过校验/);
  assert.match(found?.detail ?? '', /questions/);
  assert.doesNotMatch(
    found?.detail ?? '',
    /技能配置/,
    '两条成因共用一套文案正是本次要修掉的归因误导',
  );
});

test('探针：入参合规但无处理流 → cause=unroutable', () => {
  const found = detectUnhandledTerminalCall({
    toolCalls: [{ toolName: 'request_approval', input: VALID_APPROVAL }],
    handledToolNames: [],
    skillGatedToolNames: [],
  });
  assert.equal(found?.cause, 'unroutable');
});

test('探针：带 MCP 前缀的工具名同样能识别', () => {
  const found = detectUnhandledTerminalCall({
    toolCalls: [
      { toolName: 'mcp__harness_os__submit_tech_review', input: { verdict: 'approved' } },
    ],
    handledToolNames: [],
    skillGatedToolNames: [],
  });
  assert.equal(found?.toolName, 'submit_tech_review');
  assert.equal(found?.cause, 'schema', '前缀形式也必须能走进 schema 归因');
});

test('探针：第三方 MCP 的同类后缀名不得被误判为本宿主工具', () => {
  assert.equal(
    detectUnhandledTerminalCall({
      toolCalls: [{ toolName: 'mcp__other__request_approval', input: {} }],
      handledToolNames: [],
      skillGatedToolNames: [],
    }),
    undefined,
    '无约束的后缀匹配会为别人的工具发一张归因错误的卡，并污染 M13 计次',
  );
});

test('探针：从后往前取**最后一次**未被承接的调用', () => {
  const found = detectUnhandledTerminalCall({
    toolCalls: [
      { toolName: 'request_approval', input: VALID_APPROVAL },
      { toolName: 'relay_to_peer', input: { instruction: '' } },
    ],
    handledToolNames: ['request_approval'],
    skillGatedToolNames: [],
  });
  assert.equal(found?.toolName, 'relay_to_peer');
});

test('skillGatedTerminalTools：是「哪些工具没有处理流」的唯一构造点', () => {
  assert.deepEqual(
    skillGatedTerminalTools({ grillMeEnabled: true, managesProductSpec: true }),
    [],
  );
  assert.deepEqual(
    skillGatedTerminalTools({ grillMeEnabled: false, managesProductSpec: false }),
    ['request_clarification', 'request_spec_approval'],
  );
});

// ---------------------------------------------------------------- 失败路径的成因附件

test('异常附件：已观测到的工具调用可往返读写', () => {
  const error = attachObservedToolCalls(new Error('挂了'), [
    { toolName: 'submit_tech_review', input: { flowToken: 'x' } },
  ]);
  assert.deepEqual(readObservedToolCalls(error), [
    { toolName: 'submit_tech_review', input: { flowToken: 'x' } },
  ]);
  assert.equal(readObservedToolCalls(new Error('无附件')), undefined);
  assert.equal(readObservedToolCalls('不是 Error'), undefined);
});

test('异常附件：被宿主规则拒绝的调用可往返读写（用于跳过重复告警）', () => {
  const error = markTerminalToolRejected(new Error('无权限'), 'dispatch_task');
  assert.equal(readTerminalToolRejected(error), 'dispatch_task');
  assert.equal(readTerminalToolRejected(new Error('未标记')), undefined);
});

test('失败路径的探针：能据异常附件报出未被承接的调用', () => {
  const error = attachObservedToolCalls(new Error('执行超时'), [
    { toolName: 'dispatch_task', input: { targetBotId: 'product' } },
  ]);
  const found = detectUnhandledTerminalCall({
    toolCalls: readObservedToolCalls(error),
    handledToolNames: [],
    skillGatedToolNames: [],
  });
  assert.equal(found?.toolName, 'dispatch_task');
  assert.equal(found?.cause, 'schema', '缺 objective/instruction 属入参问题');
});

test('失败路径的探针：被宿主拒绝的调用不重复告警', () => {
  const error = markTerminalToolRejected(
    attachObservedToolCalls(new Error('只有 CEO 助理可以派发'), [
      { toolName: 'dispatch_task', input: { targetBotId: 'product' } },
    ]),
    'dispatch_task',
  );
  const rejected = readTerminalToolRejected(error);
  assert.equal(
    detectUnhandledTerminalCall({
      toolCalls: readObservedToolCalls(error),
      handledToolNames: rejected ? [rejected] : [],
      skillGatedToolNames: [],
    }),
    undefined,
    '失败卡已经说明了原因，探针再发一张就是重复告警',
  );
});

// ---------------------------------------------------------------- 接线级：runCli 的调用回收

/**
 * 这条测试守的是**真实链路**上的静默丢弃（不是纯函数）：
 * 同一批里既有普通工具、又有失败的终结调用时，终结调用曾被整条丢掉 ——
 * 宿主既不派发、也不报错、也不告警，而模型正文很可能写着「已派发」。
 * 用 mock CLI 复现：普通工具成功 + 终结工具失败（MCP 校验/权限被拒的等价形态）。
 */
test('接线级：终结调用即使失败，也必须随本轮 toolCalls 一起回收', async () => {
  const script = [
    `const emit = (o) => console.log(JSON.stringify(o));`,
    `emit({ type: 'tool_call', toolUseId: 'c1', toolName: 'Read', input: { file_path: 'foo.ts' } });`,
    `emit({ type: 'tool_end', toolUseId: 'c1', failed: false });`,
    `emit({ type: 'tool_call', toolUseId: 'c2', toolName: 'dispatch_task', input: { targetBotId: 'product', objective: 'o', instruction: 'i' } });`,
    `emit({ type: 'tool_end', toolUseId: 'c2', failed: true });`,
    `setTimeout(() => {}, 5000);`,
  ].join('');

  const adapter: CliAdapter = {
    id: 'claude',
    command: process.execPath,
    displayName: 'Mock Claude',
    buildArgs: () => ['-e', script],
    buildResumeArgs: () => ['-e', script],
    parseEvents: (line: string): CliEvent[] => {
      try {
        return [JSON.parse(line) as CliEvent];
      } catch {
        return [];
      }
    },
  };

  const result = await runCli({
    adapter,
    prompt: 'test',
    cwd: process.cwd(),
    env: { HARNESS_OS_BOT_ID: 'developer' },
    stopToolNames: [...TERMINAL_CONTROL_TOOLS],
  });

  const names = (result.toolCalls ?? []).map((call) => call.toolName);
  assert.ok(
    names.includes('dispatch_task'),
    `终结调用被静默丢弃（实际回收：${names.join(',') || '空'}）`,
  );
  assert.ok(names.includes('Read'), '普通工具不应被顺带丢掉');
});

test('权限真源唯一：MCP 与宿主必须共用同一份 checkToolRbac', async () => {
  const [fromCore, fromMcp] = await Promise.all([
    import('../../src/core/tool-rbac.js'),
    import('../../src/mcp/app-tools-server.js'),
  ]);
  assert.equal(
    fromMcp.checkToolRbac,
    fromCore.checkToolRbac,
    '两侧各写一份判定，迟早漂移成两套权限边界（宿主侧覆盖面会先残缺）',
  );
  assert.equal(
    fromCore.checkToolRbac('developer', 'submit_tech_review').allowed,
    true,
  );
  assert.equal(
    fromCore.checkToolRbac('product', 'submit_tech_review').allowed,
    false,
  );
});

// ---------------------------------------------------------------- 接线哨兵

/**
 * 接线哨兵（**不是**行为验证）。
 *
 * 纯函数单测全绿不能证明接线存在 —— 本仓已有两次「设施建好、调用点不在」的事故。
 * 完整端到端需要构造整个消息处理链（成本极高），故此处退而求其次：
 * 用源码断言钉住**调用点存在**与**判定先于通知**这两个不变式。
 * 它证明不了行为正确，但能在重构时立刻抓住「调用点被删」和「顺序被调回去」。
 */
test('接线哨兵：index.ts 中两条路径都接了探针，且完成通知前先做判定', () => {
  const source = readFileSync(
    new URL('../../src/index.ts', import.meta.url),
    'utf8',
  );

  const probeCalls = source.match(/detectUnhandledTerminalCall\(\{/g) ?? [];
  assert.equal(
    probeCalls.length,
    2,
    '成功路径与失败路径必须各有一处探针调用',
  );

  const repairCalls = source.match(/repairTerminalToolSubmissions\(\{/g) ?? [];
  assert.equal(repairCalls.length, 1, '入参纠错必须且只能有一个收口调用点');

  const probeIndex = source.indexOf('const unhandledTerminal = !isCompacting');
  const notifyIndex = source.indexOf('任务已完成，请查看上方结果。');
  assert.ok(probeIndex > 0 && notifyIndex > 0, '两处锚点都必须存在');
  assert.ok(
    probeIndex < notifyIndex,
    '判定必须先于完成通知：反过来就又会出现「告警」与「任务已完成」并存',
  );
});
