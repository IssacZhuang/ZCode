/**
 * runner-status.ts 顶到 oxlint max-lines 上限（400 行），把「请求归因 header」一族
 * （header 常量、内部前缀剥离、session-type 推断）拆到本文件；公开面仍从 runner-status.ts 导出。
 *
 * 与 runner-status.ts 的依赖方向：本文件只 `import type` 它的 `ModelStatusContext`，运行时不成环。
 */

import type {
  ModelRequestSessionType as ModelRequestSessionTypeValue,
  ResolvedModelApiCallObservation,
} from "@zcode/contracts";
import { ModelApiActorKind, ModelApiOperation, ModelRequestSessionType } from "@zcode/contracts";
import { isOpenCodeGoBaseUrl } from "./opencode-session.js";
import type { ModelStatusContext } from "./runner-status.js";

const MODEL_TRACE_HEADER = "x-zcode-trace-id";
const MODEL_REQUEST_HEADER = "x-request-id";
const MODEL_SESSION_HEADER = "x-session-id";
const MODEL_QUERY_HEADER = "x-query-id";
// Coding Plan 服务端使用该请求级 Header 区分 main/subagent/other 来源。
// 它不是 Provider 静态能力或鉴权材料，必须由调用上下文生成并覆盖同名静态 Header。
const MODEL_SESSION_TYPE_HEADER = "x-zcode-session-type";
const SESSION_ID_INTERNAL_PREFIX = "sess_";
const SESSION_ID_SUBAGENT_PREFIX = "subagent_agent_";
const QUERY_ID_INTERNAL_PREFIX = "query_";
// ChatGPT（SIWC）通道的前缀缓存路由派生自 Responses `session-id` header；只发 body
// prompt_cache_key 不足以建立稳定路由。与 Codex CLI 的 responses_session_id 对齐。
export const SIWC_SESSION_ID_HEADER = "session-id";
const SIWC_THREAD_ID_HEADER = "thread-id";
const SIWC_SUBAGENT_AFFINITY_PREFIX = "subagent:";
// OpenAI prompt_cache_key 的公开上限是 64 个字符（pi agent 同样按此截断）。
const SIWC_CACHE_KEY_MAX_LENGTH = 64;

export function createModelRequestAttributionHeaders(
  statusContext: ModelStatusContext,
): Record<string, string> {
  const sessionHeaderValue = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const queryHeaderValue = modelQueryHeaderValue(statusContext.queryId);
  const openCodeSessionHeaderValue = isOpenCodeGoBaseUrl(statusContext.baseURL)
    ? sessionHeaderValue
    : undefined;
  // 只把跨 provider 网络边界需要的观测归因字段写入 header，span 等细粒度信息仍留在事件和日志里。
  return {
    [MODEL_REQUEST_HEADER]: statusContext.requestId,
    [MODEL_SESSION_TYPE_HEADER]: isModelRequestSessionType(statusContext.modelRequestSessionType)
      ? statusContext.modelRequestSessionType
      : ModelRequestSessionType.Other,
    [MODEL_TRACE_HEADER]: statusContext.traceId,
    ...(queryHeaderValue ? { [MODEL_QUERY_HEADER]: queryHeaderValue } : {}),
    ...(sessionHeaderValue ? { [MODEL_SESSION_HEADER]: sessionHeaderValue } : {}),
    ...(openCodeSessionHeaderValue ? { "x-opencode-session": openCodeSessionHeaderValue } : {}),
  };
}

export function resolveModelRequestSessionType(
  explicitType: unknown,
  modelCall: Pick<ResolvedModelApiCallObservation, "actorKind" | "operation">,
): ModelRequestSessionTypeValue {
  if (isModelRequestSessionType(explicitType)) return explicitType;
  if (modelCall.operation !== ModelApiOperation.AgentStep) {
    return ModelRequestSessionType.Other;
  }
  if (modelCall.actorKind === ModelApiActorKind.MainAgent) {
    return ModelRequestSessionType.Main;
  }
  if (modelCall.actorKind === ModelApiActorKind.Subagent) {
    return ModelRequestSessionType.Subagent;
  }
  return ModelRequestSessionType.Other;
}

/**
 * chatgpt-account（SIWC）请求的缓存亲和 header。Main/Other 会话用本会话规范化 id；
 * Subagent 会话继承父会话派生 key（`subagent:<父会话 id>`），让同一父会话派生的全部
 * subagent 请求共享同一路由，公共系统前缀可以互相命中缓存；同时以 `thread-id` 上报
 * 父会话归属。值只含会话 id 派生信息，不含凭据或账号身份。
 */
export function createSiwcCacheAffinityHeaders(
  statusContext: Pick<
    ModelStatusContext,
    "sessionId" | "parentSessionId" | "modelRequestSessionType"
  >,
): Record<string, string> {
  const sessionValue = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const parentValue = normalizeModelSessionIdForAttribution(statusContext.parentSessionId);
  const isSubagent = statusContext.modelRequestSessionType === ModelRequestSessionType.Subagent;
  const affinityValue =
    isSubagent && parentValue
      ? clampSiwcCacheKey(`${SIWC_SUBAGENT_AFFINITY_PREFIX}${parentValue}`)
      : sessionValue
        ? clampSiwcCacheKey(sessionValue)
        : undefined;
  return {
    ...(affinityValue ? { [SIWC_SESSION_ID_HEADER]: affinityValue } : {}),
    ...(isSubagent && parentValue ? { [SIWC_THREAD_ID_HEADER]: parentValue } : {}),
  };
}

export function clampSiwcCacheKey(value: string): string {
  const chars = Array.from(value);
  return chars.length <= SIWC_CACHE_KEY_MAX_LENGTH
    ? value
    : chars.slice(0, SIWC_CACHE_KEY_MAX_LENGTH).join("");
}

function isModelRequestSessionType(value: unknown): value is ModelRequestSessionTypeValue {
  return (
    value === ModelRequestSessionType.Main ||
    value === ModelRequestSessionType.Subagent ||
    value === ModelRequestSessionType.Other
  );
}

export function normalizeModelSessionIdForAttribution(
  sessionId: ModelStatusContext["sessionId"],
): string | undefined {
  if (!sessionId) return undefined;
  // 内部 SessionId/QueryId 前缀只服务于 CLI 存储和事件归因；provider header
  // 是跨网络观测字段，不能把 query_/subagent_agent_ 这类实现前缀暴露给上游。
  return stripHeaderInternalPrefixes(sessionId, [
    SESSION_ID_INTERNAL_PREFIX,
    SESSION_ID_SUBAGENT_PREFIX,
  ]);
}

function modelQueryHeaderValue(queryId: ModelStatusContext["queryId"]): string | undefined {
  if (!queryId) return undefined;
  return stripHeaderInternalPrefixes(queryId, [QUERY_ID_INTERNAL_PREFIX]);
}

function stripHeaderInternalPrefixes(value: string, prefixes: string[]): string {
  let headerValue = value;
  for (const prefix of prefixes) {
    if (headerValue.startsWith(prefix) && headerValue.length > prefix.length) {
      headerValue = headerValue.slice(prefix.length);
    }
  }
  return headerValue || value;
}
