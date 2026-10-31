import type { ProductDeliveryMode } from '../core/bot-registry.js';
import {
  inspectProductSpecRequest,
  type ProductSpecRequest,
} from '../core/product-spec.js';
import type { CliRunResult } from '../cli/types.js';
import { markTerminalToolRejected } from '../cli/failure-metadata.js';
import { mergeToolCallLists } from './terminal-tool-submission.js';

export interface ProductSpecSubmission {
  result: CliRunResult;
  request?: ProductSpecRequest;
}

/**
 * 检查执行结果中是否存在鉴权失败/需授权错误特征
 */
function detectAuthFailure(result: CliRunResult): boolean {
  const textToScan = [
    result.answer,
    ...(result.toolCalls?.map((t) => JSON.stringify(t)) ?? []),
  ].join('\n');
  return (
    /need_user_authorization/i.test(textToScan) ||
    /lark-cli auth login/i.test(textToScan) ||
    /token.*(expired|invalid)/i.test(textToScan) ||
    /用户身份.*(过期|失效|未授权)/.test(textToScan) ||
    /401 Unauthorized/i.test(textToScan)
  );
}

/**
 * 校验产品方案提审（探讨态与提审态客观事实解耦）：
 * 1. 如果 Product 显式调用了 request_spec_approval 且参数合规，严格解析并进入提审流；
 * 2. 如果显式调用了 request_spec_approval 但参数不合规（inspection.hasCall 为真），触发针对性参数重试纠错引导；
 * 3. 如果未调用 request_spec_approval，无论 Prompt 包含何种词汇，均视为非提审态，安全放行原始结果（支持自由探讨与 relay_to_peer 协作转发）。
 */
export async function ensureProductSpecSubmission(options: {
  result: CliRunResult;
  defaultDeliveryMode: ProductDeliveryMode;
  promptText?: string;
  retry: (
    prompt: string,
    sessionId: string | undefined,
  ) => Promise<CliRunResult>;
}): Promise<ProductSpecSubmission> {
  const inspection = inspectProductSpecRequest(options.result.toolCalls);
  let finalResult = options.result;
  let finalRequest = inspection.request;

  // 如果没有成功解析出合法提审请求
  if (!finalRequest) {
    // 唯有在模型确实发起了 request_spec_approval 调用但参数解析失败时，才进入 retry 引导
    if (inspection.hasCall) {
      const retried = await options.retry(
        missingSubmissionPrompt(options.defaultDeliveryMode, inspection.lastError),
        options.result.sessionId,
      );
      // 重试被**收口禁用**时（recon 轮次由 `retryAfterGuard` 退化为不重试）返回的就是原结果：
      // 此时绝不能据「重试后仍无合法调用」判定提审失败并抛错 —— 那会把一次
      // 「模型写错入参、本可由探针准确告警」的情形升级成**整轮硬失败**，
      // 连本轮的调研正文一起丢掉。把这一事实原样交回调用点与探针即可。
      if (retried === options.result) {
        return { result: finalResult, request: finalRequest };
      }
      const retryInspection = inspectProductSpecRequest(retried.toolCalls);
      if (retryInspection.request) {
        finalResult = {
          ...retried,
          toolCalls: mergeToolCallLists(
            options.result.toolCalls,
            retried.toolCalls,
          ),
        };
        finalRequest = retryInspection.request;
      } else {
        const reasonDetail = retryInspection.lastError || inspection.lastError;
        // 带标记抛出：失败卡上已经写明是哪一项参数错了，
        // 失败路径的「控制流未承接」探针据此跳过，不重复告警。
        throw markTerminalToolRejected(
          new Error(
            reasonDetail
              ? `产品方案提审参数校验失败: ${reasonDetail}`
              : '产品方案提审参数校验失败',
          ),
          'request_spec_approval',
        );
      }
    }
  }

  // 如果经过上述流程成功拿到了 finalRequest，进行显式降级告警检测
  if (
    finalRequest &&
    options.defaultDeliveryMode === 'lark-doc' &&
    finalRequest.deliveryMode === 'local'
  ) {
    const hasAuthError =
      detectAuthFailure(options.result) || detectAuthFailure(finalResult);
    if (hasAuthError) {
      throw markTerminalToolRejected(
        new Error(
          '飞书云文档鉴权失效（登录态过期或未授权），系统已阻断静默降级为本地 Spec。请完成飞书授权后重新提交产品方案。',
        ),
        'request_spec_approval',
      );
    }
    if (!finalRequest.warning) {
      finalRequest.warning = '检测到飞书云文档交付受阻，已自动降级为本地 Spec 产物';
    }
  }

  return { result: finalResult, request: finalRequest };
}

function missingSubmissionPrompt(
  defaultDeliveryMode: ProductDeliveryMode,
  lastError?: string,
): string {
  const errorHint = lastError
    ? `\n上一轮调用 request_spec_approval 参数校验失败（${lastError}），请严格按以下要求调用。`
    : '';
  const paramTemplate = defaultDeliveryMode === 'lark-doc'
    ? '{\n  "deliveryMode": "lark-doc",\n  "documentUrl": "<你的飞书Docx云文档URL>"\n}'
    : '{\n  "deliveryMode": "local",\n  "title": "<方案标题>",\n  "summary": "<方案摘要 (<=500字)>",\n  "specPath": "<.scratch/下spec路径>",\n  "ticketsPath": "<.scratch/下tickets路径>"\n}';

  return [
    '上一轮已经完成产品方案整理，但没有完成 HarnessOS 的结构化提交。' + errorHint,
    '不要重新创建文档，也不要继续解释。请沿用上一轮已经生成的唯一产物，立即调用 request_spec_approval。',
    `标准调用入参模板（deliveryMode 必须为 "${defaultDeliveryMode}"）：\n\`\`\`json\n${paramTemplate}\n\`\`\``,
    '必须实际调用工具；不能只在普通回复中写出 deliveryMode、documentUrl、specPath 或 ticketsPath。',
    '工具调用成功后立即结束本轮。',
  ].join('\n\n');
}
