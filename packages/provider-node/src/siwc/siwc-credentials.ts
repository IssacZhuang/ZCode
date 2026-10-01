import { randomBytes } from "node:crypto";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  createSiwcHostId,
  hasSiwcDirectTokenScope,
  SIWC_EXPIRY_MARGIN_MS,
  type SiwcIdTokenClaims,
  type SiwcTokenResponse,
} from "./siwc-oauth.js";

/**
 * SIWC 凭据唯一存储：加密共享凭据库（~/.zcode/v2/credentials.json）。
 *
 * 凭据不进 Provider Config Overlay、不进协议消息；generation 随每次发布更换，
 * 供跨进程单飞刷新观察换代与失效 CAS。v1 单账号：重复登录整条替换。
 */
const SIWC_CREDENTIALS_KEY = "siwc:chatgpt:credentials";
const SIWC_HOST_ID_KEY = "siwc:chatgpt:host-id";
const SIWC_CREDENTIAL_RECORD_VERSION = 1;

export interface SiwcCredentialAccount {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly planType?: string;
  readonly accountId?: string;
}

export interface SiwcCredentialRecord {
  readonly version: typeof SIWC_CREDENTIAL_RECORD_VERSION;
  /** 每次 publish 随机更换；跨进程观察“是否换代”与失效 CAS 的依据。 */
  readonly generation: string;
  readonly issuedClientId: string;
  readonly hostId: string;
  readonly obtainedAtMs: number;
  readonly expiresAtMs?: number;
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** granted scopes（空格分隔）；是否含 chatgpt.tokens.use.direct 决定套餐可用。 */
  readonly scope: string;
  /** 保留 id_token 便于排查与后续 id_token_hint 再授权（已过期即忽略）。 */
  readonly idToken?: string;
  /**
   * 最近一次成功拉取的套餐模型目录：host 重启后台刷新失败时按此投影，
   * 保证“模型保持”（spec 验收场景 7）；刷新成功时随新记录一起发布。
   */
  readonly modelIds?: readonly string[];
  readonly account: SiwcCredentialAccount;
}

function createSiwcGeneration(): string {
  return randomBytes(16).toString("hex");
}

function isCredentialRecord(value: unknown): value is SiwcCredentialRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === SIWC_CREDENTIAL_RECORD_VERSION &&
    typeof record.generation === "string" &&
    record.generation.length > 0 &&
    typeof record.issuedClientId === "string" &&
    record.issuedClientId.length > 0 &&
    typeof record.hostId === "string" &&
    record.hostId.length > 0 &&
    typeof record.obtainedAtMs === "number" &&
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    typeof record.scope === "string" &&
    (record.modelIds === undefined ||
      (Array.isArray(record.modelIds) && record.modelIds.every((id) => typeof id === "string"))) &&
    typeof record.account === "object" &&
    record.account !== null &&
    typeof (record.account as { sub?: unknown }).sub === "string"
  );
}

export interface SiwcCredentialSnapshot {
  readonly record: SiwcCredentialRecord;
  /** 原始 JSON，供失效 CAS 使用。 */
  readonly raw: string;
}

export async function loadSiwcCredentialSnapshot(
  credentialStore: SharedZCodeCredentialStore,
): Promise<SiwcCredentialSnapshot | undefined> {
  const raw = await credentialStore.load(SIWC_CREDENTIALS_KEY);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isCredentialRecord(parsed)) return undefined;
  return { record: parsed, raw };
}

/** 由一次成功授权（首次或刷新）发布完整凭据记录；整条原子写入，不做字段级合并。 */
export function buildSiwcCredentialRecord(input: {
  readonly account: SiwcIdTokenClaims;
  readonly hostId: string;
  readonly issuedClientId: string;
  readonly tokens: SiwcTokenResponse;
  /** 刷新场景沿用旧记录身份字段（刷新响应可能不带新 id_token）。 */
  readonly previous?: SiwcCredentialRecord;
  /** 套餐模型目录；不传时沿用 previous（登录/刷新不改变模型成员资格）。 */
  readonly modelIds?: readonly string[];
  readonly nowMs?: number;
}): SiwcCredentialRecord {
  const nowMs = input.nowMs ?? Date.now();
  const previous = input.previous;
  // refresh 响应可能不轮换 refresh_token；沿用旧值，其余字段以本次响应为准。
  const refreshToken = input.tokens.refreshToken ?? previous?.refreshToken;
  const modelIds = input.modelIds ?? previous?.modelIds;
  return Object.freeze({
    version: SIWC_CREDENTIAL_RECORD_VERSION,
    generation: createSiwcGeneration(),
    issuedClientId: input.issuedClientId,
    hostId: input.hostId,
    obtainedAtMs: nowMs,
    ...(input.tokens.expiresInSeconds !== undefined
      ? { expiresAtMs: nowMs + input.tokens.expiresInSeconds * 1000 }
      : {}),
    accessToken: input.tokens.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    scope: input.tokens.scope || previous?.scope || "",
    ...(input.tokens.idToken ? { idToken: input.tokens.idToken } : {}),
    ...(modelIds && modelIds.length > 0 ? { modelIds: [...modelIds] } : {}),
    account: {
      sub: input.account.sub,
      ...(input.account.email !== undefined ? { email: input.account.email } : {}),
      ...(input.account.name !== undefined ? { name: input.account.name } : {}),
      ...(input.account.chatgptPlanType !== undefined
        ? { planType: input.account.chatgptPlanType }
        : {}),
      ...(input.account.chatgptAccountId !== undefined
        ? { accountId: input.account.chatgptAccountId }
        : {}),
    },
  });
}

export async function publishSiwcCredentialRecord(
  credentialStore: SharedZCodeCredentialStore,
  record: SiwcCredentialRecord,
): Promise<void> {
  await credentialStore.saveMany({
    [SIWC_CREDENTIALS_KEY]: JSON.stringify(record),
  });
}

/** 只有当前记录仍等于 expectedRaw 时才删除（失效 CAS），避免误删 winner。 */
export function invalidateSiwcCredentialRecord(
  credentialStore: SharedZCodeCredentialStore,
  expectedRaw: string,
): Promise<boolean> {
  return credentialStore.deleteIfValue(SIWC_CREDENTIALS_KEY, expectedRaw);
}

/** 登出：删除整条凭据记录；host 标识（host-id）按安装保留，供下次登录复用。 */
export function deleteSiwcCredentials(credentialStore: SharedZCodeCredentialStore): Promise<void> {
  return credentialStore.delete(SIWC_CREDENTIALS_KEY);
}

/** host 标识按安装持久化；首次生成后不再更换（官方要求的稳定宿主标识）。 */
export async function resolveOrCreateSiwcHostId(
  credentialStore: SharedZCodeCredentialStore,
): Promise<string> {
  const existing = await credentialStore.load(SIWC_HOST_ID_KEY);
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }
  const hostId = createSiwcHostId();
  await credentialStore.save(SIWC_HOST_ID_KEY, hostId);
  return hostId;
}

/** granted scopes 是否授予 ChatGPT 套餐直连（决定账号投影的 entitled）。 */
export function isSiwcRecordEntitled(record: SiwcCredentialRecord): boolean {
  return hasSiwcDirectTokenScope(record.scope);
}

/** 已存记录的账号字段 → 验签 claims 形状（刷新/重发布时沿用身份，不重复验签）。 */
export function siwcClaimsFromAccount(account: SiwcCredentialAccount): SiwcIdTokenClaims {
  return {
    sub: account.sub,
    ...(account.email !== undefined ? { email: account.email } : {}),
    ...(account.name !== undefined ? { name: account.name } : {}),
    ...(account.accountId !== undefined ? { chatgptAccountId: account.accountId } : {}),
    ...(account.planType !== undefined ? { chatgptPlanType: account.planType } : {}),
  };
}

/** 已存记录 → token 响应形状（配合 buildSiwcCredentialRecord 的 previous 语义重建记录）。 */
export function siwcTokenResponseFromRecord(record: SiwcCredentialRecord): SiwcTokenResponse {
  return {
    accessToken: record.accessToken,
    ...(record.refreshToken !== undefined ? { refreshToken: record.refreshToken } : {}),
    ...(record.expiresAtMs !== undefined
      ? { expiresInSeconds: Math.max(0, Math.floor((record.expiresAtMs - Date.now()) / 1000)) }
      : {}),
    scope: record.scope,
    ...(record.idToken !== undefined ? { idToken: record.idToken } : {}),
  };
}

export function isSiwcTokenNearExpiry(
  record: Pick<SiwcCredentialRecord, "expiresAtMs">,
  nowMs: number = Date.now(),
  marginMs: number = SIWC_EXPIRY_MARGIN_MS,
): boolean {
  // 无 expiresAtMs 时无法证明仍有效，宁可进锁刷新一次。
  if (record.expiresAtMs === undefined) return true;
  return nowMs >= record.expiresAtMs - marginMs;
}
