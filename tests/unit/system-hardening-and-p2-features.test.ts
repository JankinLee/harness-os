import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToolRbac } from '../../src/mcp/app-tools-server.js';
import {
  ArbitrationFlowStore,
  type ArbitrationFlow,
} from '../../src/core/collaboration.js';
import {
  buildArbitrationCard,
  buildArbitrationResolvedCard,
  buildTeamCard,
} from '../../src/im/card.js';
import { diagnoseAuthError } from '../../src/core/lark-auth-probe.js';
import { TeamRegistry } from '../../src/core/team-registry.js';
import { ExperienceCandidateStore } from '../../src/core/experience-settlement.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';

test('P2-1: checkToolRbac strictly enforces role boundaries', () => {
  // 1. ceo-assistant: can dispatch & manage schedules, cannot spec approve or clarify (clarify is product exclusive)
  assert.equal(checkToolRbac('ceo-assistant', 'dispatch_task').allowed, true);
  assert.equal(checkToolRbac('ceo-assistant', 'schedule_manage').allowed, true);
  assert.equal(checkToolRbac('ceo-assistant', 'request_approval').allowed, true);
  assert.equal(checkToolRbac('ceo-assistant', 'request_clarification').allowed, false);
  assert.match(checkToolRbac('ceo-assistant', 'request_clarification').reason ?? '', /RBAC 权限拦截.*product/);
  assert.equal(checkToolRbac('ceo-assistant', 'request_spec_approval').allowed, false);
  assert.match(checkToolRbac('ceo-assistant', 'request_spec_approval').reason ?? '', /RBAC 权限拦截.*product/);

  // 2. product: can spec approve & clarify, cannot dispatch
  assert.equal(checkToolRbac('product', 'request_spec_approval').allowed, true);
  assert.equal(checkToolRbac('product', 'request_clarification').allowed, true);
  assert.equal(checkToolRbac('product', 'dispatch_task').allowed, false);
  assert.match(checkToolRbac('product', 'dispatch_task').reason ?? '', /RBAC 权限拦截.*ceo-assistant/);

  // 3. developer: only approval allowed, cannot dispatch or spec approve
  assert.equal(checkToolRbac('developer', 'request_approval').allowed, true);
  assert.equal(checkToolRbac('developer', 'dispatch_task').allowed, false);
  assert.equal(checkToolRbac('developer', 'request_spec_approval').allowed, false);
  assert.equal(checkToolRbac('developer', 'request_clarification').allowed, false);
});

test('P2-2: ArbitrationFlowStore and arbitration cards handle 3-round limit circuit breaker', () => {
  const store = new ArbitrationFlowStore();
  const flow = store.create({
    taskId: 'task-arb-1',
    fromBotId: 'product',
    toBotId: 'ceo-assistant',
    reportToBotId: 'ceo-assistant',
    objective: '多 Agent 辩证争议方案',
    instruction: '双方在数据架构方案存在分歧',
    contradictionReason: '协作已达到 3 轮上限，双方尚未收敛',
    round: 3,
    maxRounds: 3,
    ownerOpenId: 'ou_owner_123',
    workspaceDir: process.cwd(),
  });

  // 三层仲裁链：新建流处于「待 ceo 初裁」，此时**不得**直接推给人类
  assert.equal(flow.status, 'pending_preliminary');
  assert.equal(flow.round, 3);
  assert.deepEqual(flow.narrative, []);

  // 渲染仲裁卡片
  const card = buildArbitrationCard(flow);
  const cardJson = JSON.stringify(card);
  assert.match(cardJson, /多 Agent 辩证争议 · 人工仲裁/);
  assert.match(cardJson, /按 Product 方案继续/);
  assert.match(cardJson, /按 Developer 架构调整/);
  assert.match(cardJson, /终止任务/);
  assert.match(cardJson, /decide_arbitration/);

  // 未初裁前不得裁决：resolve 只接受 pending_human / suspended
  assert.equal(store.resolve(flow.token, { selectedOption: 'adopt_product' }), undefined);

  const prelim = store.recordPreliminary(flow.token, {
    verdict: 'adopt_product',
    reasoning: '排期与取舍属于我的授权边界',
    lowRisk: true,
    riskReasons: [],
  });
  assert.ok(prelim);
  assert.equal(prelim?.status, 'pending_human');
  assert.equal(prelim?.preliminaryVerdict, 'adopt_product');
  assert.ok(prelim?.narrative.some((line) => /ceo 初裁/.test(line)));

  // 裁决流转
  const resolved = store.resolve(flow.token, {
    selectedOption: 'adopt_product',
  });
  assert.ok(resolved);
  assert.equal(resolved?.status, 'resolved');
  assert.equal(resolved?.selectedOption, 'adopt_product');

  // 渲染裁决完成卡片
  const resolvedCard = buildArbitrationResolvedCard(resolved!);
  const resCardJson = JSON.stringify(resolvedCard);
  assert.match(resCardJson, /人工仲裁已完成/);
  assert.match(resCardJson, /按 Product 方案继续推进/);
});

test('P2-3: Lark Auth 3-Level Diagnosis & /team asset navigation', () => {
  // Diagnosis A: Missing Scope
  const scopeDiag = diagnoseAuthError('Error: missing scope docx:document:create');
  assert.equal(scopeDiag.kind, 'MISSING_SCOPE');
  assert.match(scopeDiag.guidance, /open\.feishu\.cn/);

  // Diagnosis B: Token Expired
  const tokenDiag = diagnoseAuthError('Error: user token expired, need_user_authorization');
  assert.equal(tokenDiag.kind, 'TOKEN_EXPIRED_OR_NEED_LOGIN');
  assert.match(tokenDiag.guidance, /lark-cli auth login/);

  // Diagnosis C: Wiki 403 Forbidden
  const wikiDiag = diagnoseAuthError('Error: wiki space 403 forbidden, non-member');
  assert.equal(wikiDiag.kind, 'WIKI_SPACE_FORBIDDEN');
  assert.match(wikiDiag.guidance, /成员/);

  // Team Card Asset Ownership
  const teamCard = buildTeamCard({
    members: [
      {
        id: 'product',
        displayName: 'Product Bot',
        role: '产品经理',
        cliName: 'claude',
        skills: ['to-spec', 'lark-doc'],
        isLeader: false,
        ready: true,
      },
      {
        id: 'developer',
        displayName: 'Developer',
        role: '开发工程师',
        cliName: 'claude',
        skills: ['implement-ticket'],
        isLeader: false,
        ready: true,
      },
    ],
  });
  const teamCardJson = JSON.stringify(teamCard);
  assert.match(teamCardJson, /产品知识库 Wiki 与云文档 PRD/);
  assert.match(teamCardJson, /代码仓 docs/);
});

test('P2-4: ExperienceCandidateStore tracks pattern hitCount and exports to DC article', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'harness-os-exp-'));
  const storePath = join(tempDir, 'experience_candidates.json');
  const store = new ExperienceCandidateStore(storePath);

  // 1. Record hits
  await store.recordHit({
    id: 'anti-pattern-1',
    workspaceKey: 'harness-os',
    pattern: 'Unescaped Spawn Args',
    description: 'Windows spawn cmd 吞双引号导致参数解析失败',
  });
  await store.recordHit({
    id: 'anti-pattern-1',
    workspaceKey: 'harness-os',
    pattern: 'Unescaped Spawn Args',
    description: 'Windows spawn cmd 吞双引号导致参数解析失败',
  });
  const thirdHit = await store.recordHit({
    id: 'anti-pattern-1',
    workspaceKey: 'harness-os',
    pattern: 'Unescaped Spawn Args',
    description: 'Windows spawn cmd 吞双引号导致参数解析失败',
  });

  assert.equal(thirdHit.hitCount, 3);
  assert.equal(thirdHit.status, 'nominated');

  // 2. Export to DC article
  const dcExportDir = join(tempDir, 'articles');
  const exportedPath = await store.exportToDcArticle('anti-pattern-1', dcExportDir);
  assert.ok(exportedPath.endsWith('pattern-unescaped spawn args.md'));

  const exportedContent = await readFile(exportedPath, 'utf8');
  assert.match(exportedContent, /架构经验沉淀：Unescaped Spawn Args/);
  assert.match(exportedContent, /复现累计 3 次/);
  assert.match(exportedContent, /M11 Isolate/);
});
