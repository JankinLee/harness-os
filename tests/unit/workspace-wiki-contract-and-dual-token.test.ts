import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  WorkspaceResolver,
  type WorkspaceMetadata,
} from '../../src/core/workspace-resolver.js';
import {
  parseHarnessOsConfig,
  loadHarnessOsConfig,
} from '../../src/core/bot-registry.js';
import {
  assembleContextCapsule,
  estimateCapsuleLength,
  formatTargetWorkspaceMeta,
  targetWorkspaceMetaLengthOf,
  buildCollaborationPrompt,
  CAPSULE_CHAR_BUDGET,
  type TargetWorkspaceMetaPrompt,
} from '../../src/core/collaboration.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import {
  ProductSpecFlowStore,
  type ProductSpecFlow,
} from '../../src/core/product-spec.js';
import { JsonProductSpecFlowStore } from '../../src/core/product-spec-store.js';
import {
  buildProductSpecApprovalCard,
} from '../../src/im/card.js';
import { resolveDocumentObjToken } from '../../src/im/lark.js';
import type { AppRuntime } from '../../src/app/runtime.js';

test('Ticket 01: WorkspaceMetadata 契约与 WorkspaceResolver 多源解析优先级', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'harness-os-ws-test-'));

  try {
    const wsDefaultDir = join(tmpRoot, 'default-ws');
    const wsShorthandDir = join(tmpRoot, 'shorthand-ws');
    const wsConfigDir = join(tmpRoot, 'config-ws');
    const wsOverrideDir = join(tmpRoot, 'override-ws');

    mkdirSync(wsDefaultDir, { recursive: true });
    mkdirSync(wsShorthandDir, { recursive: true });
    mkdirSync(wsConfigDir, { recursive: true });
    mkdirSync(join(wsOverrideDir, '.harness-os'), { recursive: true });

    // 在 override-ws 写入本地自包含配置
    writeFileSync(
      join(wsOverrideDir, '.harness-os', 'workspace.json'),
      JSON.stringify({
        wikiSpaceId: 'local_space_override',
        prdParentNodeToken: 'local_active_node',
        archivedParentNodeToken: 'local_archive_node',
        wikiSpaceUrl: 'https://example.feishu.cn/wiki/local_space',
      }),
      'utf8',
    );

    const env = {
      FEISHU_LEADER_APP_ID: 'cli_leader',
      FEISHU_LEADER_APP_SECRET: 'sec_leader',
    };

    const configInput = {
      teamLeader: 'leader',
      defaultWorkspace: wsDefaultDir,
      wikiSpaceId: 'global_fallback_space',
      workspaces: {
        'shorthand': wsShorthandDir,
        'structured': {
          path: wsConfigDir,
          wikiSpaceId: 'host_space_123',
          prdParentNodeToken: 'host_prd_token_456',
          archivedParentNodeToken: 'host_archive_token_789',
          wikiSpaceUrl: 'https://example.feishu.cn/wiki/host_space',
        },
        'override': {
          path: wsOverrideDir,
          wikiSpaceId: 'host_will_be_overridden',
          prdParentNodeToken: 'host_prd_will_be_overridden',
        },
      },
      bots: [
        {
          id: 'leader',
          appIdEnv: 'FEISHU_LEADER_APP_ID',
          appSecretEnv: 'FEISHU_LEADER_APP_SECRET',
          defaultCli: 'claude',
          role: 'Team Leader',
        },
      ],
    };

    // 1. parseHarnessOsConfig 支持简写路径与扩展对象配置混用
    const parsed = parseHarnessOsConfig(configInput, env, tmpRoot);
    assert.equal(parsed.wikiSpaceId, 'global_fallback_space');
    assert.equal(parsed.workspaces['shorthand'], resolve(wsShorthandDir));
    assert.equal(typeof parsed.workspaces['structured'], 'object');
    assert.equal(
      (parsed.workspaces['structured'] as any).wikiSpaceId,
      'host_space_123',
    );
    assert.equal(
      (parsed.workspaces['structured'] as any).prdParentNodeToken,
      'host_prd_token_456',
    );
    // 显式校验 Phase 4 预留架构字段
    assert.equal(
      (parsed.workspaces['structured'] as any).archivedParentNodeToken,
      'host_archive_token_789',
    );

    const resolver = new WorkspaceResolver({
      defaultWorkspace: parsed.defaultWorkspaceDir,
      workspaces: parsed.workspaces,
      wikiSpaceId: parsed.wikiSpaceId,
      baseDirectory: tmpRoot,
      trustedRoots: [tmpRoot],
    });

    // 2. 场景 A: 简写路径命中全局兜底 wikiSpaceId
    const shorthandMeta = resolver.getWorkspaceMetadata('shorthand');
    assert.equal(shorthandMeta.path, resolve(wsShorthandDir));
    assert.equal(shorthandMeta.wikiSpaceId, 'global_fallback_space');
    assert.equal(shorthandMeta.prdParentNodeToken, undefined);

    // 3. 场景 B: 扩展对象配置生效
    const structuredMeta = resolver.getWorkspaceMetadata('structured');
    assert.equal(structuredMeta.path, resolve(wsConfigDir));
    assert.equal(structuredMeta.wikiSpaceId, 'host_space_123');
    assert.equal(structuredMeta.prdParentNodeToken, 'host_prd_token_456');
    assert.equal(structuredMeta.archivedParentNodeToken, 'host_archive_token_789');
    assert.equal(structuredMeta.wikiSpaceUrl, 'https://example.feishu.cn/wiki/host_space');

    // 4. 场景 C: 本地自包含配置优先覆盖宿主集中配置 (瘦宿主分流)
    const overrideMeta = resolver.getWorkspaceMetadata('override');
    assert.equal(overrideMeta.path, resolve(wsOverrideDir));
    assert.equal(overrideMeta.wikiSpaceId, 'local_space_override');
    assert.equal(overrideMeta.prdParentNodeToken, 'local_active_node');
    assert.equal(overrideMeta.archivedParentNodeToken, 'local_archive_node');
    assert.equal(overrideMeta.wikiSpaceUrl, 'https://example.feishu.cn/wiki/local_space');

    // 5. 场景 D: 默认工作区命中全局兜底
    const defaultMeta = resolver.getWorkspaceMetadata();
    assert.equal(defaultMeta.path, resolve(wsDefaultDir));
    assert.equal(defaultMeta.wikiSpaceId, 'global_fallback_space');

    // 6. 场景 E: 本地配置包含数值型 spaceId 防御性转换（防止 .trim() 崩溃）
    const wsNumericDir = join(tmpRoot, 'numeric-ws');
    mkdirSync(join(wsNumericDir, '.harness-os'), { recursive: true });
    writeFileSync(
      join(wsNumericDir, '.harness-os', 'workspace.json'),
      JSON.stringify({
        wikiSpaceId: 1234567890123456,
      }),
      'utf8',
    );
    const numericMeta = resolver.getWorkspaceMetadata(wsNumericDir);
    assert.equal(numericMeta.wikiSpaceId, '1234567890123456');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Ticket 02: 协作上下文胶囊中知识空间元数据的确定性注入与 100% 预算保真', async () => {
  const meta: TargetWorkspaceMetaPrompt = {
    alias: 'example-project',
    path: '/path/to/example-project',
    wikiSpaceId: '1234567890123456',
    prdParentNodeToken: 'FAKE_PRD_PARENT_TOKEN',
  };

  // 1. 验证目标工作区资产格式化纯函数
  const formatted = formatTargetWorkspaceMeta(meta);
  assert.ok(formatted.includes('【目标工作区知识空间资产】'));
  assert.ok(formatted.includes('目标工作区: example-project (/path/to/example-project)'));
  assert.ok(formatted.includes('Wiki 空间 ID: 1234567890123456'));
  assert.ok(formatted.includes('PRD 直建父节点: FAKE_PRD_PARENT_TOKEN'));
  assert.ok(
    formatted.includes(
      '操作纪律: 创建方案时必须携带 --parent-token FAKE_PRD_PARENT_TOKEN 直建挂载至目标 Wiki 节点。',
    ),
  );

  // 2. 验证纯同步装配纯函数
  const capsule = assembleContextCapsule({
    sourceTaskId: 'task_001',
    fromWorkspace: 'harness-os',
    toWorkspace: 'example-project',
    objective: '设计知识空间挂载协议',
    tier: 'M',
    targetWorkspaceMeta: meta,
  });

  assert.equal(capsule.toWorkspace, 'example-project');
  assert.deepEqual(capsule.targetWorkspaceMeta, meta);

  // 3. 验证估算器与装配开销 100% 保真
  const estLength = estimateCapsuleLength(capsule);
  assert.ok(estLength > 0);
  assert.ok(estLength <= CAPSULE_CHAR_BUDGET);

  // 4. 验证在超长输入极限边界下，仍然严格受限 CAPSULE_CHAR_BUDGET
  const superLongObjective = 'X'.repeat(3000);
  const superLongSummary = 'Y'.repeat(3000);
  const constrainedCapsule = assembleContextCapsule({
    sourceTaskId: 'task_002',
    fromWorkspace: 'harness-os',
    toWorkspace: 'example-project',
    objective: superLongObjective,
    distilledDecisionsSummary: superLongSummary,
    tier: 'L',
    targetWorkspaceMeta: meta,
  });

  const constrainedLength = estimateCapsuleLength(constrainedCapsule);
  assert.ok(
    constrainedLength <= CAPSULE_CHAR_BUDGET,
    `估算长度 ${constrainedLength} 必须 <= ${CAPSULE_CHAR_BUDGET}`,
  );

  // 5. 验证协作提示词正确渲染元数据章节
  const prompt = buildCollaborationPrompt({
    dispatchId: 'disp_123',
    taskId: 'task_001',
    ownerOpenId: 'u_1',
    fromBotId: 'ceo-assistant',
    toBotId: 'product',
    reportToBotId: 'ceo-assistant',
    objective: '编制方案',
    instruction: '请产出 PRD',
    round: 1,
    maxRounds: 16,
    workspaceDir: '/path/to/example-project',
    capsule,
  });

  assert.ok(prompt.includes('【目标工作区知识空间资产】'));
  assert.ok(prompt.includes('目标工作区: example-project (/path/to/example-project)'));
  assert.ok(prompt.includes('Wiki 空间 ID: 1234567890123456'));
  assert.ok(prompt.includes('--parent-token FAKE_PRD_PARENT_TOKEN'));
});

test('Ticket 02: CollaborationService.dispatch 唯一定点收口元数据并严格绑定目标工作区', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'harness-os-dispatch-test-'));

  try {
    const wsDir = join(tmpRoot, 'workspace-target');
    mkdirSync(wsDir, { recursive: true });

    const resolver = new WorkspaceResolver({
      defaultWorkspace: wsDir,
      workspaces: {
        'target-ws': {
          path: wsDir,
          wikiSpaceId: 'target_space_999',
          prdParentNodeToken: 'target_node_888',
        },
      },
      baseDirectory: tmpRoot,
      trustedRoots: [tmpRoot],
    });

    let repliedCard: any = null;
    const mockBot = {
      replyCard: async (_msgId: string, card: any) => {
        repliedCard = card;
        return 'card_msg_123';
      },
      replyMention: async () => 'mention_msg_123',
    };

    const targetBotRuntime = {
      identity: { name: 'ProductBot', openId: 'bot_product' },
    };
    const senderBotRuntime = {
      identity: { name: 'CeoAssistant', openId: 'bot_ceo' },
    };

    const runtime = {
      sessions: new Map(),
      workspaceResolver: resolver,
      botRuntimes: new Map([
        ['product', targetBotRuntime],
        ['ceo-assistant', senderBotRuntime],
      ]),
      collaborationInbox: {
        register: (msg: any) => {
          assert.ok(msg.capsule);
          assert.equal(msg.capsule.toWorkspace, 'workspace-target');
          assert.ok(msg.capsule.targetWorkspaceMeta);
          assert.equal(
            msg.capsule.targetWorkspaceMeta.wikiSpaceId,
            'target_space_999',
          );
          assert.equal(
            msg.capsule.targetWorkspaceMeta.prdParentNodeToken,
            'target_node_888',
          );
        },
      },
    } as unknown as AppRuntime;

    const service = new CollaborationService(runtime);
    await service.dispatch({
      senderConfig: { id: 'ceo-assistant' } as any,
      senderBot: mockBot as any,
      replyToMessageId: 'msg_001',
      targetBotId: 'product',
      taskId: 'topic-test',
      ownerOpenId: 'user_1',
      reportToBotId: 'ceo-assistant',
      objective: '调研新特性',
      instruction: '请直建 Wiki PRD',
      tier: 'M',
      workspaceDir: tmpRoot,
      targetWorkspace: 'target-ws',
      round: 1,
      maxRounds: 16,
    });

    assert.ok(repliedCard);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Ticket 03: Product 角色规范与 Wiki 直建执行流加固（含降级回滚与卡片警示）', async () => {
  // 1. 验证配置文件中 Product 角色 prompt 包含直建与优雅降级契约
  const env = {
    FEISHU_CEO_ASSISTANT_APP_ID: 'id1',
    FEISHU_CEO_ASSISTANT_APP_SECRET: 'sec1',
    FEISHU_PRODUCT_APP_ID: 'id2',
    FEISHU_PRODUCT_APP_SECRET: 'sec2',
    FEISHU_DEVELOPER_APP_ID: 'id3',
    FEISHU_DEVELOPER_APP_SECRET: 'sec3',
  };
  const config = await loadHarnessOsConfig('config/bots.example.json', env, resolve('.'));
  const productBot = config.bots.find((b) => b.id === 'product');
  assert.ok(productBot);
  assert.ok(
    productBot.systemPrompt.includes('Wiki 直建与优雅降级契约'),
    'Product 提示词必须包含 Wiki 直建与优雅降级契约',
  );
  assert.ok(
    productBot.systemPrompt.includes('--parent-token <prdParentNodeToken>'),
    '必须引导携带 --parent-token 参数',
  );
  assert.ok(
    productBot.systemPrompt.includes('安全降级为不带 `--parent-token` 的个人云盘默认创建'),
    '必须包含降级为个人盘创建的声明',
  );
  assert.ok(
    productBot.systemPrompt.includes('携带 warning 参数说明降级原因'),
    '必须指导提审时携带 warning 参数',
  );

  // 2. 验证降级发生时，审批卡片呈现 warning 警示横幅
  const degradedFlow: ProductSpecFlow = {
    token: 'flow_degraded_01',
    taskId: 'task_deg',
    botId: 'product',
    sessionId: 'session_deg',
    ownerOpenId: 'u_1',
    status: 'pending',
    request: {
      deliveryMode: 'lark-doc',
      documentUrl: 'https://example.feishu.cn/docx/fallback_token_123',
      title: '已安全降级的 PRD 方案',
      warning:
        'Wiki 直建挂载受阻 (空间权限不足或父节点无效)，已安全降级至个人云盘创建。请管理员核查工作区知识空间配置与权限。',
    },
  };

  const card = buildProductSpecApprovalCard(degradedFlow);
  const cardJson = JSON.stringify(card);
  assert.ok(cardJson.includes('降级提示'));
  assert.ok(
    cardJson.includes(
      'Wiki 直建挂载受阻 (空间权限不足或父节点无效)，已安全降级至个人云盘创建',
    ),
  );
});

test('Ticket 04: Wiki 双代币映射、底盘解析、交付回写与卡片受控资产标识', async () => {
  // 1. 测试 resolveDocumentObjToken
  let requestedToken: string | undefined;
  const mockClient = {
    wiki: {
      v2: {
        space: {
          getNode: async (payload: any) => {
            requestedToken = payload?.params?.token;
            return {
              data: {
                node: {
                  node_token: requestedToken,
                  obj_token: 'docx_underlying_obj_token_888',
                  obj_type: 'docx',
                },
              },
            };
          },
        },
      },
    },
    docx: {
      v1: {
        documentBlockChildren: {
          create: async (payload: any) => {
            return { code: 0, data: payload };
          },
        },
      },
    },
  } as any;

  // 1a. Docx 链接直接返回 docx token
  const docxUrl = 'https://example.feishu.cn/docx/direct_docx_token_111';
  const resolvedDocxToken = await resolveDocumentObjToken(mockClient, docxUrl);
  assert.equal(resolvedDocxToken, 'direct_docx_token_111');

  // 1b. Wiki 链接通过 space.getNode 穿透解析为底层 obj_token
  const wikiUrl = 'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_3';
  const resolvedWikiToken = await resolveDocumentObjToken(mockClient, wikiUrl);
  assert.equal(requestedToken, 'FAKE_WIKI_TOKEN_3');
  assert.equal(resolvedWikiToken, 'docx_underlying_obj_token_888');

  // 1c. 混淆防御：Wiki URL query 带有 /docx/ 标记时不得被误判为 docx
  requestedToken = undefined;
  const wikiUrlWithQuery =
    'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_3?from=/docx/other_ref';
  const resolvedQueryToken = await resolveDocumentObjToken(
    mockClient,
    wikiUrlWithQuery,
  );
  assert.equal(requestedToken, 'FAKE_WIKI_TOKEN_3');
  assert.equal(resolvedQueryToken, 'docx_underlying_obj_token_888');

  // 2. 测试 findCommentRoutableByDocument 与 findPendingByDocument 双代币匹配
  const store = new ProductSpecFlowStore();
  const createdFlow = store.create({
    taskId: 'topic-wiki-01',
    botId: 'product',
    sessionId: 'sess_01',
    ownerOpenId: 'u_01',
    originalMessageId: 'orig_msg_01',
    request: {
      deliveryMode: 'lark-doc',
      documentUrl: 'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_3',
      title: 'Wiki 方案',
    },
    objToken: 'docx_underlying_obj_token_888',
  });

  assert.equal(createdFlow.objToken, 'docx_underlying_obj_token_888');

  // 2a. 通过 Wiki node_token 成功匹配
  const matchedByNodeToken = store.findCommentRoutableByDocument(
    'product',
    'FAKE_WIKI_TOKEN_3',
  );
  assert.equal(matchedByNodeToken?.token, createdFlow.token);

  // 2b. 通过底盘 Docx obj_token 成功匹配（Webhook 评论下发真实 token）
  const matchedByObjToken = store.findCommentRoutableByDocument(
    'product',
    'docx_underlying_obj_token_888',
  );
  assert.equal(matchedByObjToken?.token, createdFlow.token);

  // 2c. findPendingByDocument 同样支持双代币匹配
  const pendingByNode = store.findPendingByDocument(
    'product',
    'FAKE_WIKI_TOKEN_3',
  );
  assert.equal(pendingByNode?.token, createdFlow.token);
  const pendingByObj = store.findPendingByDocument(
    'product',
    'docx_underlying_obj_token_888',
  );
  assert.equal(pendingByObj?.token, createdFlow.token);

    // 3. 测试持久化存储 JsonProductSpecFlowStore 对 objToken 的持久化不丢失与 setObjToken
    const tmpRoot = mkdtempSync(join(tmpdir(), 'harness-os-store-test-'));
    try {
      const storePath = join(tmpRoot, 'flows.json');
      const jsonStore1 = new JsonProductSpecFlowStore(storePath);
      const created1 = jsonStore1.create({
        taskId: 'topic-persist',
        botId: 'product',
        sessionId: 'sess_persist',
        ownerOpenId: 'u_persist',
        originalMessageId: 'orig_persist',
        request: {
          deliveryMode: 'lark-doc',
          documentUrl: 'https://example.feishu.cn/wiki/wiki_node_persist',
        },
      });

      assert.equal(created1.objToken, undefined);
      // 验证 setObjToken 变更并持久化
      jsonStore1.setObjToken(created1.token, 'docx_obj_set_dynamically');

      // 重新加载验证落盘未被 Zod 剥离
      const jsonStore2 = new JsonProductSpecFlowStore(storePath);
      const persistedFlow = jsonStore2.findCommentRoutableByDocument(
        'product',
        'docx_obj_set_dynamically',
      );
      assert.ok(persistedFlow, '重启后通过 setObjToken 注入的代币必须可检索');
      assert.equal(persistedFlow?.objToken, 'docx_obj_set_dynamically');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }

  // 4. 测试审批卡片中 Wiki 链接呈现受控资产标识 📚 **知识库文档 (Wiki)**
  const wikiCard = buildProductSpecApprovalCard({
    token: 'flow_wiki_card',
    taskId: 'task_wiki',
    botId: 'product',
    sessionId: 'sess_wiki',
    ownerOpenId: 'u_1',
    status: 'pending',
    request: {
      deliveryMode: 'lark-doc',
      documentUrl: 'https://example.feishu.cn/wiki/FAKE_WIKI_TOKEN_3',
      title: '受控知识库 PRD',
    },
  });
  const wikiCardJson = JSON.stringify(wikiCard);
  assert.ok(
    wikiCardJson.includes('📚 **知识库文档 (Wiki)**'),
    'Wiki 链接必须呈现受控资产标识 📚 **知识库文档 (Wiki)**',
  );

  const docxCard = buildProductSpecApprovalCard({
    token: 'flow_docx_card',
    taskId: 'task_docx',
    botId: 'product',
    sessionId: 'sess_docx',
    ownerOpenId: 'u_1',
    status: 'pending',
    request: {
      deliveryMode: 'lark-doc',
      documentUrl: 'https://example.feishu.cn/docx/regular_docx_123',
      title: '普通云文档 PRD',
    },
  });
  const docxCardJson = JSON.stringify(docxCard);
  assert.ok(
    docxCardJson.includes('☁️ **飞书云文档**'),
    'Docx 链接保持 ☁️ **飞书云文档**',
  );
});
