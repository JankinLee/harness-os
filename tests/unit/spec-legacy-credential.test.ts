import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonProductSpecFlowStore } from '../../src/core/product-spec-store.js';
import {
  isCredentiallessRow,
  type ProductSpecFlow,
} from '../../src/core/product-spec.js';

/**
 * 无任务凭据行（升级引入凭据之前落盘的存量行）必须**退出同话题任务匹配**：
 * `taskId` 是话题级哈希，而缺凭据的行在「双方都有凭据才比较」的旧语义下
 * 会匹配**任意**凭据 —— 既可能把上一个任务的方案指针注入下游，
 * 也可能让陈旧的 pending 永久抑制新任务的完成通知。
 *
 * 关键：该判定由**凭据本身推导**，不依赖任何需要「记得维护」的标记字段。
 */

function row(token: string, credential?: string) {
  return {
    token,
    taskId: 'topic-1',
    botId: 'product',
    sessionId: 's-1',
    ownerOpenId: 'ou-human',
    status: 'pending',
    ...(credential ? { originalMessageId: credential } : {}),
    request: {
      deliveryMode: 'local',
      title: '方案',
      summary: '摘要',
      specPath: '.scratch/f/spec.md',
      ticketsPath: '.scratch/f/tickets.md',
    },
  };
}

function withTempStore(
  rows: unknown[],
  run: (store: JsonProductSpecFlowStore, filePath: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-cred-'));
  const filePath = join(dir, 'product-spec-flows.json');
  try {
    writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    run(new JsonProductSpecFlowStore(filePath), filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('判定由凭据推导：没有凭据 ⇔ 无凭据行（不依赖任何标记字段）', () => {
  assert.equal(isCredentiallessRow({ originalMessageId: undefined }), true);
  assert.equal(isCredentiallessRow({ originalMessageId: '' }), true);
  assert.equal(isCredentiallessRow({ originalMessageId: 'om_real' }), false);
});

test('装载路径：无凭据的存量行不参与同话题匹配（两个查找器）', () => {
  withTempStore([row('t-legacy')], (store) => {
    assert.equal(
      store.findLatestByTaskId('topic-1', { originMessageId: 'om_new_task' }),
      undefined,
      '不得被当成「当前任务的权威方案」注入下游',
    );
    assert.equal(
      store.findPendingByTaskId('topic-1', { originMessageId: 'om_new_task' }),
      undefined,
      '不得永久抑制新任务的完成通知',
    );
  });
});

test('创建路径：新建行缺凭据同样退出匹配，且必须告警（不得静默）', () => {
  withTempStore([], (store) => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    let created: ProductSpecFlow;
    try {
      created = store.create({
        taskId: 'topic-1',
        botId: 'product',
        sessionId: 's-1',
        ownerOpenId: 'ou-human',
        request: row('x').request,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warnings.some((message) => message.includes('缺少任务凭据')),
      '新建行没有凭据是「凭据链在上游断裂」的异常信号，必须留告警',
    );
    assert.equal(
      store.findLatestByTaskId('topic-1', { originMessageId: 'om_new_task' }),
      undefined,
      '缺凭据的新行同样不得参与匹配（fail-closed）',
    );
  });
});

test('回归：有凭据的行仍严格按凭据匹配（收敛不得误伤新数据）', () => {
  withTempStore(
    [row('t-a', 'om_task_a'), row('t-b', 'om_task_b')],
    (store) => {
      assert.equal(
        store.findLatestByTaskId('topic-1', { originMessageId: 'om_task_a' })
          ?.token,
        't-a',
      );
      assert.equal(
        store.findLatestByTaskId('topic-1', { originMessageId: 'om_task_b' })
          ?.token,
        't-b',
      );
    },
  );
});

test('落盘往返：判定不依赖字段，重启后行为一致', () => {
  withTempStore([row('t-legacy')], (store, filePath) => {
    store.approve('t-legacy'); // 触发一次落盘
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as unknown[];
    assert.equal(onDisk.length, 1);

    const reloaded = new JsonProductSpecFlowStore(filePath);
    assert.equal(
      reloaded.findLatestByTaskId('topic-1', { originMessageId: 'om_new' }),
      undefined,
    );
    // 任务级查询刻意**不做**「不传凭据就全放行」的兜底：那是 fail-open，
    // 恰是本次要关掉的那条路径（缺凭据 ⇒ 匹配任意凭据）。
    assert.equal(
      reloaded.findLatestByTaskId('topic-1', { originMessageId: undefined }),
      undefined,
      '无凭据行对任务级查询一律不可见',
    );
    assert.equal(
      reloaded.get('t-legacy')?.token,
      't-legacy',
      '按 token 直取（人类操作路径）必须仍然可达，否则存量行彻底失联',
    );
  });
});
