/**
 * zcode-plan / Coding Plan 业务错误码与前端文案归位约定。
 *
 * 个人分支已移除账号/订阅与 Start Plan 升级横幅动作，这里只保留错误码到
 * i18n 文案 key 的映射，以及历史任务错误（闲时票据、空结果）的归位判定。
 *
 * | 场景           | code | HTTP | 前端处理 |
 * |----------------|------|------|----------|
 * | JWT 缺失/失效  | 1006 | 200  | 归位到登录失效文案（仅历史任务展示） |
 * | 配额不足       | 1005 | 200  | 归位到配额不足文案 |
 * | 模型不可用     | 3006 | 400  | 归位到模型不可用文案 |
 * | 参数错误       | 3001 | 400  | 归位到参数错误文案 |
 * | 安全校验拒绝   | 3007 | 403  | 归位到安全校验拒绝文案 |
 * | 模型并发上限   | 3008/3009/3010 | 429 | 归位到并发上限文案 |
 * | 请求过频       | 3002/429 | 429 | 归位到限流文案 |
 * | 闲时票据不可用 | 3102 | 400  | 历史任务错误归位文案（闲时链路已下线） |
 * | 上游 HTTP 异常 | 2007 | 500  | 归位到上游异常文案（可重试） |
 */

const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

function isProviderBusinessErrorCode(code: string | undefined): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

/** 与 core `model-errors.ts` 中 anomaly guard 文案保持一致。 */
const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * 闲时票据不可用（上游 3102：票据失效或过期）。
 * 个人分支已移除闲时任务链路（isOffPeakTicketExpiredError 随 shared 删除），
 * 这里只保留业务码本身的判定，供历史任务错误展示继续归位到 3102 文案。
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  _message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
