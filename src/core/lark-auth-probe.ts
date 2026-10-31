import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { CardJson } from '../im/card.js';
import { escapeFeishuMarkdown } from '../im/card.js';

const execAsync = promisify(exec);

export type LarkAuthDiagnosisKind =
  | 'MISSING_SCOPE'
  | 'TOKEN_EXPIRED_OR_NEED_LOGIN'
  | 'WIKI_SPACE_FORBIDDEN'
  | 'UNKNOWN';

export interface LarkAuthStatusResult {
  healthy: boolean;
  needsAlert: boolean;
  diagnosisKind?: LarkAuthDiagnosisKind;
  appId?: string;
  userName?: string;
  openId?: string;
  refreshExpiresAt?: string;
  remainingHours?: number;
  reason?: string;
  guidance?: string;
}

export function diagnoseAuthError(text: string): {
  kind: LarkAuthDiagnosisKind;
  reason: string;
  guidance: string;
} {
  if (
    /missing.*scope|scope.*(missing|denied|unauthorized)|permission.*(denied|lack)|缺少.*权限|need.*scope/i.test(
      text,
    )
  ) {
    return {
      kind: 'MISSING_SCOPE',
      reason: '应用在飞书开放平台缺少必要的 docx:* 或 wiki:* 权限',
      guidance:
        '请登录飞书开放平台 (https://open.feishu.cn/app/) -> 进入应用 -> 权限管理 -> 申请开启对应权限并发布版本，企业管理员审批通过后生效。',
    };
  }

  if (/wiki.*403|space.*forbidden|知识库.*权限不足|非知识库成员/i.test(text)) {
    return {
      kind: 'WIKI_SPACE_FORBIDDEN',
      reason: '目标知识库空间为私有空间，当前授权身份尚未加入空间成员 (403 Forbidden)',
      guidance:
        '请联系该知识空间管理员，在飞书客户端打开目标知识库 -> 空间设置 -> 成员管理，将当前操作账号或应用添加为成员。',
    };
  }

  if (/expired|need_user_authorization|401|token.*invalid|用户身份.*失效/i.test(text)) {
    return {
      kind: 'TOKEN_EXPIRED_OR_NEED_LOGIN',
      reason: '飞书用户代行授权凭证已过期或未登录',
      guidance: '请在宿主终端执行 `lark-cli auth login` 完成网页一键扫码/授权确认。',
    };
  }

  return {
    kind: 'UNKNOWN',
    reason: text || '未知飞书鉴权异常',
    guidance: '请在宿主终端执行 `lark-cli auth status` 查看详细凭证诊断信息。',
  };
}

export async function checkLarkAuthStatus(options?: {
  execCommand?: (cmd: string) => Promise<string>;
  now?: () => Date;
}): Promise<LarkAuthStatusResult> {
  const runner =
    options?.execCommand ??
    (async (cmd: string) => {
      const { stdout } = await execAsync(cmd, { windowsHide: true });
      return stdout;
    });

  let rawOutput = '';
  try {
    rawOutput = await runner('lark-cli auth status --json');
  } catch (error) {
    const errorMsg = (error as Error).message;
    const diag = diagnoseAuthError(errorMsg);
    return {
      healthy: false,
      needsAlert: true,
      diagnosisKind: diag.kind,
      reason: `执行 lark-cli auth status 失败: ${errorMsg}`,
      guidance: diag.guidance,
    };
  }

  try {
    const data = JSON.parse(rawOutput);
    const user = data?.identities?.user;
    if (!user) {
      return {
        healthy: false,
        needsAlert: true,
        diagnosisKind: 'TOKEN_EXPIRED_OR_NEED_LOGIN',
        appId: data?.appId,
        reason: '飞书凭证中未检测到用户身份授权（identities.user 为空）',
        guidance: '请在宿主终端执行 `lark-cli auth login` 进行用户授权绑定。',
      };
    }

    if (user.status === 'expired' || user.available === false) {
      return {
        healthy: false,
        needsAlert: true,
        diagnosisKind: 'TOKEN_EXPIRED_OR_NEED_LOGIN',
        appId: data?.appId,
        userName: user.userName,
        openId: user.openId,
        refreshExpiresAt: user.refreshExpiresAt,
        remainingHours: 0,
        reason: `飞书用户凭证已失效（status=${user.status}, available=${user.available}）`,
        guidance: '请在宿主终端执行 `lark-cli auth login` 重新扫码登录。',
      };
    }

    if (!user.refreshExpiresAt) {
      return {
        healthy: false,
        needsAlert: true,
        diagnosisKind: 'UNKNOWN',
        appId: data?.appId,
        userName: user.userName,
        openId: user.openId,
        reason: '飞书凭证缺失 refreshExpiresAt 生命周期字段',
        guidance: '建议重新执行 `lark-cli auth login` 刷新凭证元数据。',
      };
    }

    const refreshExpiryTime = new Date(user.refreshExpiresAt).getTime();
    if (Number.isNaN(refreshExpiryTime)) {
      return {
        healthy: false,
        needsAlert: true,
        diagnosisKind: 'UNKNOWN',
        appId: data?.appId,
        userName: user.userName,
        openId: user.openId,
        reason: `飞书凭证到期时间格式无效或无法解析: "${String(user.refreshExpiresAt)}"`,
        guidance: '建议重新执行 `lark-cli auth login` 重新生成凭证。',
      };
    }

    const currentTime = (options?.now?.() ?? new Date()).getTime();
    const remainingMs = refreshExpiryTime - currentTime;
    const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));

    // 剩余时间 < 48 小时触发预警
    if (remainingHours < 48) {
      return {
        healthy: false,
        needsAlert: true,
        diagnosisKind: 'TOKEN_EXPIRED_OR_NEED_LOGIN',
        appId: data?.appId,
        userName: user.userName,
        openId: user.openId,
        refreshExpiresAt: user.refreshExpiresAt,
        remainingHours: Math.max(0, remainingHours),
        reason:
          remainingHours <= 0
            ? '飞书 Refresh Token 已物理过期'
            : `飞书 Refresh Token 剩余有效时间不足 48 小时（仅剩 ${remainingHours} 小时）`,
        guidance: '请在宿主终端执行 `lark-cli auth login` 提前续期 Refresh Token。',
      };
    }

    return {
      healthy: true,
      needsAlert: false,
      appId: data?.appId,
      userName: user.userName,
      openId: user.openId,
      refreshExpiresAt: user.refreshExpiresAt,
      remainingHours,
    };
  } catch (error) {
    return {
      healthy: false,
      needsAlert: true,
      diagnosisKind: 'UNKNOWN',
      reason: `解析 lark-cli auth status 结果异常: ${(error as Error).message}`,
      guidance: '请检查 lark-cli 是否正确安装或运行 `lark-cli auth status` 诊断。',
    };
  }
}

export function buildLarkAuthAlertCard(
  status: LarkAuthStatusResult,
): CardJson {
  const isExpired = (status.remainingHours ?? 0) <= 0;
  const isScopeMissing = status.diagnosisKind === 'MISSING_SCOPE';
  const isWikiForbidden = status.diagnosisKind === 'WIKI_SPACE_FORBIDDEN';

  const title = isScopeMissing
    ? '⚠️ 飞书开放平台缺少应用权限'
    : isWikiForbidden
      ? '🔒 知识库空间访问受限 (403)'
      : isExpired
        ? '🚨 飞书用户凭证已过期失效'
        : '⚠️ 飞书凭证即将到期预警（<48h）';

  const subtitle = isScopeMissing
    ? '需在开放平台开启对应 Scope 权限'
    : isWikiForbidden
      ? '目标私有空间需添加当前用户为成员'
      : isExpired
        ? '云文档与高级协同操作将直接受阻'
        : `剩余有效时间约 ${status.remainingHours} 小时，请尽快续期`;

  const guidanceText =
    status.guidance ??
    '**续期指南（请在宿主终端执行）**：\n```bash\nlark-cli auth login\n```\n完成后凭证将自动刷新续期，无需重启 HarnessOS 核心服务。';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${title}：${status.reason ?? ''}` },
    },
    header: {
      template: isExpired || isWikiForbidden ? 'red' : 'orange',
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: subtitle },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**诊断结果**\n${escapeFeishuMarkdown(status.reason ?? '凭证状态异常')}`,
            status.appId ? `**应用 App ID** \`${status.appId}\`` : '',
            status.userName
              ? `**授权用户** ${escapeFeishuMarkdown(status.userName)}${status.openId ? ` (\`${status.openId}\`)` : ''}`
              : '',
            status.refreshExpiresAt
              ? `**Refresh Token 到期时间** \`${escapeFeishuMarkdown(status.refreshExpiresAt)}\``
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**操作指引**\n${guidanceText}`,
        },
      ],
    },
  };
}

export async function sendAuthPatrolAlert(
  status: LarkAuthStatusResult,
  webhookUrl?: string,
): Promise<boolean> {
  const url = webhookUrl ?? process.env.PATROL_WEBHOOK_URL;
  if (!url) {
    console.warn('[授权巡检] 未配置 PATROL_WEBHOOK_URL，跳过飞书推送');
    return false;
  }

  const card = buildLarkAuthAlertCard(status);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card,
      }),
    });
    const result = (await response.json()) as { code?: number; msg?: string };
    if (result.code !== 0) {
      console.error('[授权巡检] 推送告警卡片失败:', result.msg);
      return false;
    }
    console.log('[授权巡检] 预警卡片已成功推送到运维群');
    return true;
  } catch (error) {
    console.error('[授权巡检] 推送异常:', (error as Error).message);
    return false;
  }
}
