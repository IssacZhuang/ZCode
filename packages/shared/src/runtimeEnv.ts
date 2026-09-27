export const ZCODE_RUNTIME_ENV_KEY = "ZCODE_RUNTIME_ENV";
export const ZCODE_HTTP_PROXY_ENV_KEY = "ZCODE_HTTP_PROXY";
export const ZCODE_NO_PROXY_ENV_KEY = "ZCODE_NO_PROXY";
/** Desktop Host 只向 desktop-attached remote server 传递一次的网络配置。 */
export const ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY =
  "ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY";
export const ZCODE_REMOTE_HTTP_PROXY_ENV_KEY = "ZCODE_REMOTE_HTTP_PROXY";
export const ZCODE_REMOTE_NO_PROXY_ENV_KEY = "ZCODE_REMOTE_NO_PROXY";
export const ZCODE_AGENT_CA_CERT_ENV_KEY = "ZCODE_AGENT_CA_CERT";
export const ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY = "ZCODE_TOOL_ENV_PASSTHROUGH_JSON";
/** Desktop Main 将服务端裁决的单功能灰度结果传给 Local/Remote Host。 */
export const ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV = "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED";

export type ZCodeRuntimeEnv = "development" | "production" | "test";

type EnvRecord = Record<string, string | undefined>;

const SANITIZED_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  // CUA 功能已在个人分支移除，但用户机上可能残留旧版 Helper 写入的 broker 连接材料
  // （socket / bearer token / authority）。继续从所有子进程 env 剔除这些遗留键，防止
  // 历史凭据随 agent 全局 env 泄漏给 MCP server / Bash / tool 子进程；剔除是零成本防御。
  "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
  "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  // Agent OTLP Endpoint/Auth/Identity 属于已移除的 CLI telemetry bootstrap；保留字面量
  // 继续从所有子进程 env 剔除，属于针对旧配置残留的零成本防御。
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "ZCODE_MODEL_TELEMETRY_ENABLED",
  "ZCODE_TELEMETRY_DEVICE_MID",
  // 历史身份变量不再受支持，但仍须从所有子进程环境剔除，避免旧配置把原始账号
  // 或可伪造 hash 泄漏给 Host、Bash 与 MCP。
  "ZCODE_TELEMETRY_USER_ID",
  "ZCODE_TELEMETRY_USER_ID_HASH",
  "ZCODE_TELEMETRY_USER_SUBJECT_ID",
  "ZCODE_TELEMETRY_IDENTITY_STATE",
  "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  "ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION",
] as const;

const NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  // CUA broker 遗留凭据不得经 tool-env-passthrough 恢复到 Bash/tool 子进程（否则等于绕过上面的剔除）。
  "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
] as const;

const SANITIZED_PACKAGE_MANAGER_ENV_PATTERN =
  /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i;

export function normalizeZCodeRuntimeEnv(value: string | undefined): ZCodeRuntimeEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  return undefined;
}

export function resolveZCodeRuntimeEnv(
  env: Record<string, string | undefined>,
  fallback: ZCodeRuntimeEnv = "production",
): ZCodeRuntimeEnv {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]) ?? fallback;
}

export function sanitizeZCodeRuntimeEnv<T extends Record<string, string | undefined>>(
  env: T,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldSanitizeZCodeRuntimeEnvKey(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const captured = readZCodeToolEnvPassthroughEnv(env);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !shouldCaptureZCodeToolEnvPassthroughKey(key)) {
      continue;
    }
    captured[key] = value;
  }

  return stringifyZCodeToolEnvPassthroughEnv(captured);
}

export function readZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const raw = env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY];
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const captured: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        shouldCaptureZCodeToolEnvPassthroughKey(key)
      ) {
        captured[key] = value;
      }
    }
    return captured;
  } catch {
    return {};
  }
}

export function sanitizeZCodeRuntimeEnvInPlace(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (shouldSanitizeZCodeRuntimeEnvKey(key)) {
      delete env[key];
    }
  }
}

export function shouldSanitizeZCodeRuntimeEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    SANITIZED_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey) ||
    SANITIZED_PACKAGE_MANAGER_ENV_PATTERN.test(key)
  );
}

export function shouldCaptureZCodeToolEnvPassthroughKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  if (NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey)) {
    return false;
  }
  return shouldSanitizeZCodeRuntimeEnvKey(key);
}

function stringifyZCodeToolEnvPassthroughEnv(
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return {};
  }
  return {
    [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify(Object.fromEntries(entries)),
  };
}
