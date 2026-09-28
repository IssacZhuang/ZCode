/** 供应商用量/余额查询的共享类型与域名识别（服务与 UI 共用的唯一实现）。 */
import { resolveSafeEndpointHostname } from "./endpointHostname.js";

/** 用量类别：套餐限额（多时间窗）或账户余额。 */
export type ProviderUsageKind = "coding-plan" | "balance";

/** 归一化额度窗口标识；balance 适配器固定产出单条 balance tier。 */
export type ProviderUsageTierId = "five_hour" | "weekly" | "monthly" | "balance";

export interface ProviderUsageTier {
  readonly id: ProviderUsageTierId;
  /** 已用百分比 0–100（服务端口径统一为"已用"，展示层统一反转为"剩余"）。 */
  readonly usedPercentage?: number;
  readonly remaining?: number;
  readonly total?: number;
  readonly used?: number;
  /** 余额币种（USD/CNY…）。 */
  readonly unit?: string;
  /** ISO 8601 重置时间。 */
  readonly resetsAt?: string;
}

export type ProviderUsageErrorCode =
  | "unsupported"
  | "missing-api-key"
  | "auth-failed"
  | "network"
  | "bad-response"
  | "unknown";

export interface ProviderUsageError {
  readonly code: ProviderUsageErrorCode;
  readonly message: string;
}

export interface ProviderUsageSnapshot {
  readonly providerId: string;
  /** 命中的适配器与用量类别；provider 不存在或域名未识别时缺省。 */
  readonly adapterId?: ProviderUsageAdapterId;
  readonly kind?: ProviderUsageKind;
  /** API key 是否通过供应商校验（HTTP 401/403 置 false）。 */
  readonly credentialValid: boolean;
  readonly tiers: readonly ProviderUsageTier[];
  readonly error?: ProviderUsageError;
  /** 服务端时钟（ms epoch）。 */
  readonly queriedAt: number;
}

// ── 供应商识别 ──────────────────────────────────────────────

export const PROVIDER_USAGE_ADAPTER_IDS = [
  "zhipu",
  "kimi",
  "minimax",
  "deepseek",
  "siliconflow",
  "openrouter",
  "stepfun",
  "novita",
] as const;

export type ProviderUsageAdapterId = (typeof PROVIDER_USAGE_ADAPTER_IDS)[number];

/** 各适配器认领的精确 hostname；中转站/相似域名（如 api.minimax.cn.example.com）不得命中。 */
const ADAPTER_HOSTNAMES: Record<ProviderUsageAdapterId, readonly string[]> = {
  zhipu: ["open.bigmodel.cn", "bigmodel.cn", "api.z.ai"],
  kimi: ["api.kimi.com"],
  minimax: ["api.minimaxi.com", "api.minimax.cn", "api.minimax.io"],
  deepseek: ["api.deepseek.com"],
  siliconflow: ["api.siliconflow.cn", "api.siliconflow.com"],
  openrouter: ["openrouter.ai"],
  stepfun: ["api.stepfun.ai", "api.stepfun.com"],
  novita: ["api.novita.ai"],
};

/**
 * 按 provider 配置的 base_url 识别内置用量适配器。
 * 精确匹配 hostname（经 resolveSafeEndpointHostname 规范），未命中返回 null，
 * 调用方据此跳过查询且不渲染用量区块。
 */
export function detectProviderUsageAdapterId(
  baseUrl: string | null | undefined,
): ProviderUsageAdapterId | null {
  const hostname = resolveSafeEndpointHostname(baseUrl);
  if (!hostname) return null;
  for (const adapterId of PROVIDER_USAGE_ADAPTER_IDS) {
    if (ADAPTER_HOSTNAMES[adapterId].includes(hostname)) return adapterId;
  }
  return null;
}
