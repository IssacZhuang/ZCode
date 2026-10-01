/**
 * Sign in with ChatGPT（SIWC）官方 token-sharing 通道的请求塑形 fetch。
 *
 * 官方约束（Preview）：`store` 必须为 false；请求必须流式（stream:true）；
 * 不支持的预算、采样、归因和服务端状态字段必须在发送前剥离；
 * system 提示只能走 instructions 或 developer 消息。
 * 这里在 fetch 层统一收口，保证任何调用路径（含标题生成、压缩等内部非流式调用）
 * 发往 api.openai.com/v1/responses 的 body 都合规：非流式请求改写为流式并把
 * SSE 聚合回单 JSON 响应，SDK 无感。
 */
type ProviderFetch = typeof globalThis.fetch;

export function createSiwcCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const body = init?.body;
    if (typeof body !== "string") {
      // 非 JSON body（表单/二进制）不经过本通道，保持原样。
      return baseFetch(input, init);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return baseFetch(input, init);
    }
    if (!isRecord(parsed)) {
      return baseFetch(input, init);
    }

    const shaped = shapeSiwcResponsesRequestBody(parsed);
    const requestInit: RequestInit = { ...init, body: JSON.stringify(shaped.body) };
    const response = await baseFetch(input, requestInit);
    if (!shaped.streamingRewrite || !response.ok || !isEventStream(response)) {
      return response;
    }
    // stream:false 被改写为 true 后，这里把 SSE 事件聚合成 SDK 期待的单 JSON 响应。
    return aggregateResponsesEventStream(response);
  };
}

/** 请求体塑形结果；streamingRewrite 表示原请求非流式、需要聚合回 JSON。 */
function shapeSiwcResponsesRequestBody(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  streamingRewrite: boolean;
} {
  const next: Record<string, unknown> = { ...body };
  // 官方 token-sharing 通道禁止服务端留存请求与响应。
  next.store = false;
  // 旧列表只覆盖部分 API-key 参数；按官方 Preview 清单剥离，避免账号通道返回 400。
  // HTTP 不支持 previous_response_id，历史仍由既有 input 回放路径完整发送。
  for (const key of [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
  ]) {
    delete next[key];
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      // system 角色在 Responses API 中只接受 developer/function 等显式角色。
      if (isRecord(item) && item.role === "system") {
        return { ...item, role: "developer" };
      }
      return item;
    });
  }
  const streamingRewrite = next.stream !== true;
  if (streamingRewrite) {
    next.stream = true;
    // 非流式语义下 SDK 会读取完整 JSON；stream_options 属于流式扩展，不发送。
    delete next.stream_options;
  }
  return { body: next, streamingRewrite };
}

async function aggregateResponsesEventStream(response: Response): Promise<Response> {
  const text = await response.text();
  const finalResponse = findFinalResponsesObject(text);
  if (!finalResponse) {
    return new Response(text, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(finalResponse), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Responses SSE 以 `response.completed`（或 `response.failed` / `response.incomplete`）
 * 收尾，事件携带完整 response 对象；直接取终态对象作为聚合结果。
 */
function findFinalResponsesObject(eventStreamText: string): Record<string, unknown> | undefined {
  const terminalTypes = new Set(["response.completed", "response.failed", "response.incomplete"]);
  let fallback: Record<string, unknown> | undefined;
  for (const payload of parseEventDataPayloads(eventStreamText)) {
    const event = isRecord(payload) ? payload : undefined;
    if (!event) continue;
    if (typeof event.type === "string" && terminalTypes.has(event.type)) {
      const responseObject = isRecord(event.response) ? event.response : undefined;
      if (responseObject) return responseObject;
    }
    if (fallback === undefined && isRecord(event.response)) {
      fallback = event.response;
    }
  }
  return fallback;
}

function* parseEventDataPayloads(text: string): Generator<unknown> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // 半行/心跳行忽略，继续找下一个事件。
      }
    }
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
