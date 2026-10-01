import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";

/**
 * Sign in with ChatGPT（SIWC）官方 token-sharing 通道的协议常量与纯逻辑。
 *
 * 端点与参数以 OpenAI 官方文档为准（developers.openai.com/siwc/token-sharing-open-source，
 * Preview 阶段，可能变化）；禁止改打 ChatGPT backend-api，禁止伪装 Codex CLI 指纹。
 */
export const SIWC_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const SIWC_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const SIWC_DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
// 官方 issuer 不带末尾斜杠；旧值多出的 "/" 会在严格匹配时拒绝合法 discovery 与 id_token。
export const SIWC_ISSUER = "https://auth.openai.com";
/** RFC 8707 resource indicator：token 的受众是标准平台 API，不是 Codex 后端。 */
export const SIWC_RESOURCE = "https://api.openai.com/v1";
/** 首次动态注册入口；回调会签发专属 `oaiapp_...` clientId，之后一律使用签发值。 */
export const SIWC_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** 诚实上报的应用名；不得伪装成 codex_cli_rs 或其他客户端。 */
export const SIWC_AGENT_NAME_HINT = "ZCode";
export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** 判定 ChatGPT 套餐可用的必要 scope：只拿到 id_token 不代表套餐可用。 */
export const SIWC_DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
/** 官方要求 loopback redirect 的 host/path 固定（127.0.0.1 + /auth/callback），端口可变。 */
export const SIWC_CALLBACK_HOST = "127.0.0.1";
export const SIWC_CALLBACK_PATH = "/auth/callback";
/** access token 临期判定的安全余量：临期即进锁刷新，避免把过期 token 发给请求。 */
export const SIWC_EXPIRY_MARGIN_MS = 3 * 60 * 1000;
/** OAuth/token HTTP 请求的默认超时。 */
export const SIWC_HTTP_TIMEOUT_MS = 15_000;

export type SiwcFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SiwcPkce {
  readonly codeChallenge: string;
  readonly codeVerifier: string;
}

export function createSiwcPkce(): SiwcPkce {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeChallenge, codeVerifier };
}

export function createSiwcState(): string {
  return randomBytes(32).toString("base64url");
}

export function createSiwcNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** 每宿主稳定标识（urn:uuid 形式），首次生成后持久化，不得每次登录更换。 */
export function createSiwcHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

export interface SiwcAuthorizeUrlInput {
  readonly callbackUrl: string;
  readonly hostId: string;
  readonly nonce: string;
  readonly pkce: SiwcPkce;
  readonly state: string;
  /** 再授权时已保存的签发 clientId；缺省表示首次动态注册。 */
  readonly issuedClientId?: string;
  /** 再授权时带 login_hint（email）可跳过账号选择。 */
  readonly loginHint?: string;
}

export function buildSiwcAuthorizeUrl(input: SiwcAuthorizeUrlInput): string {
  const url = new URL(SIWC_AUTHORIZE_URL);
  const registration = input.issuedClientId === undefined;
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration ? SIWC_DYNAMIC_CLIENT_ID : input.issuedClientId);
  url.searchParams.set("redirect_uri", input.callbackUrl);
  url.searchParams.set("scope", SIWC_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", SIWC_RESOURCE);
  // agent_name_hint 与 ext_agent_host_id 只在注册阶段上报；再授权沿用已签发身份。
  if (registration) {
    url.searchParams.set("agent_name_hint", SIWC_AGENT_NAME_HINT);
    url.searchParams.set("ext_agent_host_id", input.hostId);
  }
  if (input.loginHint) {
    url.searchParams.set("login_hint", input.loginHint);
  }
  return url.toString();
}

export type SiwcCallbackErrorCode =
  | "missing-code"
  | "missing-issued-client-id"
  | "client-id-mismatch";

export class SiwcCallbackError extends Error {
  constructor(
    readonly code: SiwcCallbackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SiwcCallbackError";
  }
}

export interface SiwcCallbackResult {
  readonly code: string;
  /** 首次注册时签发的 `oaiapp_...` clientId；再授权回调可能不带（沿用保存值）。 */
  readonly issuedClientId?: string;
}

/**
 * 解析回调 URL 中的 code 与签发 clientId。
 *
 * state 校验与 access_denied 已由 localhost 回调 server 完成；这里只负责官方 SIWC 特有规则：
 * 注册回调必须携带签发 clientId，再授权回调返回不同 clientId 必须拒绝（防止凭据串号）。
 */
export function parseSiwcCallbackUrl(
  url: string,
  input: { readonly savedIssuedClientId?: string },
): SiwcCallbackResult {
  const parsed = new URL(url);
  const code = parsed.searchParams.get("code") ?? parsed.searchParams.get("authCode") ?? "";
  if (!code) {
    throw new SiwcCallbackError("missing-code", "SIWC callback is missing an authorization code.");
  }
  const clientId = parsed.searchParams.get("client_id") ?? "";
  if (!input.savedIssuedClientId) {
    if (!clientId) {
      throw new SiwcCallbackError(
        "missing-issued-client-id",
        "SIWC registration callback is missing the issued client id.",
      );
    }
    return { code, issuedClientId: clientId };
  }
  if (clientId && clientId !== input.savedIssuedClientId) {
    throw new SiwcCallbackError(
      "client-id-mismatch",
      "SIWC callback returned a different client id than the one issued for this host.",
    );
  }
  return { code, ...(clientId ? { issuedClientId: clientId } : {}) };
}

export interface SiwcTokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresInSeconds?: number;
  readonly idToken?: string;
  readonly scope: string;
}

export class SiwcOAuthError extends Error {
  constructor(
    readonly oauthErrorCode: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SiwcOAuthError";
  }
}

export class SiwcNetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SiwcNetworkError";
  }
}

async function postSiwcTokenRequest(
  body: Record<string, string>,
  fetchImpl: SiwcFetch,
  signal?: AbortSignal,
): Promise<SiwcTokenResponse> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIWC_HTTP_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    response = await fetchImpl(SIWC_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      // 官方要求 form 编码且无 client secret。
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
      credentials: "omit",
    });
  } catch (error) {
    throw new SiwcNetworkError("SIWC token request failed", error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onCallerAbort);
  }
  const text = await response.text();
  let payload: unknown = undefined;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const oauthError = readRecordField(payload, "error");
    throw new SiwcOAuthError(
      typeof oauthError === "string" && oauthError ? oauthError : "http_error",
      `SIWC token endpoint returned ${response.status}`,
      response.status,
    );
  }
  if (!isRecord(payload)) {
    throw new SiwcOAuthError("invalid_response", "SIWC token endpoint returned an invalid body");
  }
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new SiwcOAuthError("invalid_response", "SIWC token response is missing access_token");
  }
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;
  const idToken = payload.id_token;
  const scope = payload.scope;
  return {
    accessToken,
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? { expiresInSeconds: expiresIn }
      : {}),
    ...(typeof idToken === "string" && idToken ? { idToken } : {}),
    scope: typeof scope === "string" ? scope : "",
  };
}

export function exchangeSiwcCode(input: {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch: SiwcFetch;
  readonly redirectUri: string;
  readonly signal?: AbortSignal;
}): Promise<SiwcTokenResponse> {
  return postSiwcTokenRequest(
    {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: SIWC_RESOURCE,
    },
    input.fetch,
    input.signal,
  );
}

export function refreshSiwcTokens(input: {
  readonly clientId: string;
  readonly fetch: SiwcFetch;
  readonly refreshToken: string;
  readonly signal?: AbortSignal;
}): Promise<SiwcTokenResponse> {
  return postSiwcTokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: SIWC_RESOURCE,
    },
    input.fetch,
    input.signal,
  );
}

export interface SiwcDiscoveryDocument {
  readonly issuer: string;
  readonly jwksUri: string;
}

export async function fetchSiwcDiscovery(
  fetchImpl: SiwcFetch,
  signal?: AbortSignal,
): Promise<SiwcDiscoveryDocument> {
  let response: Response;
  try {
    response = await fetchImpl(SIWC_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
      signal,
      credentials: "omit",
    });
  } catch (error) {
    throw new SiwcNetworkError("SIWC discovery request failed", error);
  }
  if (!response.ok) {
    throw new SiwcOAuthError(
      "http_error",
      `SIWC discovery returned ${response.status}`,
      response.status,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!isRecord(payload)) {
    throw new SiwcOAuthError("invalid_response", "SIWC discovery returned an invalid body");
  }
  const issuer = payload.issuer;
  const jwksUri = payload.jwks_uri;
  if (typeof issuer !== "string" || issuer !== SIWC_ISSUER) {
    throw new SiwcOAuthError("invalid_response", "SIWC discovery returned an unexpected issuer");
  }
  if (typeof jwksUri !== "string" || !jwksUri.startsWith("https://")) {
    throw new SiwcOAuthError("invalid_response", "SIWC discovery returned an invalid jwks_uri");
  }
  return { issuer, jwksUri };
}

export class SiwcIdTokenVerificationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SiwcIdTokenVerificationError";
  }
}

export interface SiwcIdTokenClaims {
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  /** `https://api.openai.com/auth` claim 内的 ChatGPT 账号信息。 */
  readonly chatgptAccountId?: string;
  readonly chatgptPlanType?: string;
}

/**
 * 按官方要求验证 id_token：JWKS 验签 + iss / aud(=issued clientId) / exp / nonce。
 *
 * `sub` 是账号唯一身份，email/plan 仅作展示；验证失败必须让登录失败，不得降级为只解码 payload。
 */
export async function verifySiwcIdToken(input: {
  readonly discovery: SiwcDiscoveryDocument;
  readonly fetch: SiwcFetch;
  readonly idToken: string;
  readonly issuedClientId: string;
  readonly nonce: string;
  readonly signal?: AbortSignal;
}): Promise<SiwcIdTokenClaims> {
  let jwksResponse: Response;
  try {
    jwksResponse = await input.fetch(input.discovery.jwksUri, {
      headers: { Accept: "application/json" },
      signal: input.signal,
      credentials: "omit",
    });
  } catch (error) {
    throw new SiwcIdTokenVerificationError("SIWC JWKS request failed", error);
  }
  if (!jwksResponse.ok) {
    throw new SiwcIdTokenVerificationError(`SIWC JWKS returned ${jwksResponse.status}`);
  }
  const jwks: unknown = await jwksResponse.json().catch(() => undefined);
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) {
    throw new SiwcIdTokenVerificationError("SIWC JWKS returned an invalid body");
  }
  let keySet: ReturnType<typeof createLocalJWKSet>;
  let payload: Record<string, unknown>;
  try {
    keySet = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
    const verified = await jwtVerify(input.idToken, keySet, {
      issuer: SIWC_ISSUER,
      audience: input.issuedClientId,
      requiredClaims: ["exp", "iss", "aud", "sub", "nonce"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw new SiwcIdTokenVerificationError("SIWC id_token verification failed", error);
  }
  if (payload.nonce !== input.nonce) {
    throw new SiwcIdTokenVerificationError("SIWC id_token nonce mismatch");
  }
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new SiwcIdTokenVerificationError("SIWC id_token is missing sub");
  }
  const auth = payload["https://api.openai.com/auth"];
  const authRecord = isRecord(auth) ? auth : undefined;
  const email = payload.email;
  const name = payload.name;
  const accountId = authRecord?.chatgpt_account_id;
  const planType = authRecord?.chatgpt_plan_type;
  return {
    sub,
    ...(typeof email === "string" ? { email } : {}),
    ...(payload.email_verified === true ? { emailVerified: true } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof accountId === "string" ? { chatgptAccountId: accountId } : {}),
    ...(typeof planType === "string" ? { chatgptPlanType: planType } : {}),
  };
}

/** granted scope 是否包含 ChatGPT 套餐直连授权。 */
export function hasSiwcDirectTokenScope(scope: string): boolean {
  return scope.split(/\s+/).includes(SIWC_DIRECT_TOKEN_SCOPE);
}

function readRecordField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
