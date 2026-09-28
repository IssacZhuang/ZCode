/**
 * 供应商用量/余额查询服务（host 侧唯一所有者）。
 *
 * 从 ProviderSettingsView 读取 provider 的 effective baseUrl/apiKey，按域名识别
 * 内置适配器后调用各家官方用量/余额接口。快照只在内存中按次返回，不落盘。
 * unsupported / missing-api-key 在发请求前同步返回，不产生网络请求。
 */
import {
  ServiceChannels,
  detectProviderUsageAdapterId,
  type ProviderUsageSnapshot,
} from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { resolveProviderUsageAdapter } from "./providerUsageAdapters.js";

export interface IProviderUsageService {
  /** 查询指定 provider 的用量/余额快照；未识别适配器或缺少 key 时返回带错误码的快照。 */
  getProviderUsage(providerId: string): Promise<ProviderUsageSnapshot>;
}

export const IProviderUsageService = createServiceDescriptor<IProviderUsageService>(
  ServiceChannels.ProviderUsage,
);

interface ProviderUsageServiceDependencies {
  getView(): Promise<ProviderSettingsView>;
  fetchImpl: typeof fetch;
  now?(): number;
}

/** 用量接口 15s 超时；错误 message 截断上限，防止异常响应体刷屏日志/UI。 */
const PROVIDER_USAGE_TIMEOUT_MS = 15_000;
const PROVIDER_USAGE_ERROR_MESSAGE_MAX_LENGTH = 300;

function truncateMessage(message: string): string {
  const normalized = message.trim();
  return normalized.length <= PROVIDER_USAGE_ERROR_MESSAGE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, PROVIDER_USAGE_ERROR_MESSAGE_MAX_LENGTH)}…`;
}

function createSnapshot(
  providerId: string,
  now: () => number,
  init: Omit<ProviderUsageSnapshot, "providerId" | "queriedAt">,
): ProviderUsageSnapshot {
  return { providerId, queriedAt: now(), ...init };
}

export function createProviderUsageService(
  dependencies: ProviderUsageServiceDependencies,
): IProviderUsageService {
  const log = createServiceLogger("provider-usage");
  const now = dependencies.now ?? (() => Date.now());

  return {
    async getProviderUsage(providerId) {
      const view = await dependencies.getView();
      const provider = view.providers.find((item) => item.providerId === providerId);
      if (!provider) {
        return createSnapshot(providerId, now, {
          credentialValid: false,
          tiers: [],
          error: { code: "unknown", message: `Provider 不存在: ${providerId}` },
        });
      }
      const baseUrl = provider.effectiveConfig.api?.baseUrl ?? "";
      const adapterId = detectProviderUsageAdapterId(baseUrl);
      if (!adapterId) {
        // 中转站/私有部署等未识别域名：明确返回 unsupported，调用方不渲染用量区块
        return createSnapshot(providerId, now, {
          credentialValid: false,
          tiers: [],
          error: { code: "unsupported", message: "未知用量查询供应商" },
        });
      }
      const adapter = resolveProviderUsageAdapter(adapterId, baseUrl);
      const access = provider.effectiveConfig.access;
      const apiKey =
        access && (access.type === "api-key" || access.type === "zhipu-coding-plan-api-key")
          ? (access.apiKey ?? "")
          : "";
      if (!apiKey.trim()) {
        return createSnapshot(providerId, now, {
          adapterId,
          kind: adapter.kind,
          credentialValid: false,
          tiers: [],
          error: { code: "missing-api-key", message: "API Key 未配置" },
        });
      }
      const plan = adapter.buildRequest(baseUrl, apiKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROVIDER_USAGE_TIMEOUT_MS);
      log.debug(`查询供应商用量: ${providerId} (${adapterId})`);
      try {
        const response = await dependencies.fetchImpl(plan.url, {
          method: "GET",
          headers: plan.headers,
          signal: controller.signal,
          credentials: "omit",
        });
        if (response.status === 401 || response.status === 403) {
          return createSnapshot(providerId, now, {
            adapterId,
            kind: adapter.kind,
            credentialValid: false,
            tiers: [],
            error: { code: "auth-failed", message: `鉴权失败 (HTTP ${response.status})` },
          });
        }
        if (!response.ok) {
          return createSnapshot(providerId, now, {
            adapterId,
            kind: adapter.kind,
            credentialValid: true,
            tiers: [],
            error: {
              code: "bad-response",
              message: `API error (HTTP ${response.status})`,
            },
          });
        }
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return createSnapshot(providerId, now, {
            adapterId,
            kind: adapter.kind,
            credentialValid: true,
            tiers: [],
            error: { code: "bad-response", message: "响应体不是合法 JSON" },
          });
        }
        const outcome = adapter.parseResponse(body);
        if (!outcome.ok) {
          return createSnapshot(providerId, now, {
            adapterId,
            kind: adapter.kind,
            credentialValid: true,
            tiers: [],
            error: { code: "bad-response", message: truncateMessage(outcome.message) },
          });
        }
        return createSnapshot(providerId, now, {
          adapterId,
          kind: adapter.kind,
          credentialValid: true,
          tiers: outcome.tiers,
        });
      } catch (error) {
        // 网络不可达/超时/DNS 等；按 reqwest 同款语义归为瞬时失败，调用方可重试
        log.debug(`供应商用量查询传输失败: ${providerId} (${adapterId}): ${String(error)}`);
        return createSnapshot(providerId, now, {
          adapterId,
          kind: adapter.kind,
          credentialValid: true,
          tiers: [],
          error: { code: "network", message: truncateMessage(`网络错误: ${String(error)}`) },
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
