import { SIWC_RESOURCE, SiwcNetworkError, SiwcOAuthError, type SiwcFetch } from "./siwc-oauth.js";

/**
 * 登录后从标准平台 API 拉取 ChatGPT 套餐可用模型目录。
 *
 * 官方 SIWC 文档：GET {resource}/models 返回的目录里 `visibility == "list"` 的条目即
 * 套餐可推理模型；不做本地白名单硬编码，也不打 ChatGPT backend-api。
 */
export async function fetchSiwcModelIds(input: {
  readonly accessToken: string;
  readonly fetch: SiwcFetch;
  readonly signal?: AbortSignal;
}): Promise<readonly string[]> {
  let response: Response;
  try {
    response = await input.fetch(`${SIWC_RESOURCE}/models`, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/json",
      },
      signal: input.signal,
      credentials: "omit",
    });
  } catch (error) {
    throw new SiwcNetworkError("SIWC model catalog request failed", error);
  }
  if (!response.ok) {
    throw new SiwcOAuthError(
      "http_error",
      `SIWC model catalog returned ${response.status}`,
      response.status,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SiwcOAuthError("invalid_response", "SIWC model catalog returned an invalid body");
  }
  // SIWC 返回 models/slug；旧解析误用 API-key 目录的 data/id，导致 OAuth 成功后仍登录失败。
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new SiwcOAuthError("invalid_response", "SIWC model catalog is missing the models array");
  }
  const ids = new Set<string>();
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as { slug?: unknown; visibility?: unknown };
    if (typeof record.slug !== "string" || record.slug.length === 0) continue;
    if (record.visibility !== "list") continue;
    ids.add(record.slug);
  }
  // 官方目录顺序供模型选择使用；按首次出现去重，不能排序改写服务端顺序。
  return [...ids];
}
