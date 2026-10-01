import { dirname, join } from "node:path";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  buildSiwcCredentialRecord,
  invalidateSiwcCredentialRecord,
  loadSiwcCredentialSnapshot,
  publishSiwcCredentialRecord,
  siwcClaimsFromAccount,
  type SiwcCredentialSnapshot,
} from "./siwc-credentials.js";
import { refreshSiwcTokens, SiwcOAuthError, type SiwcFetch } from "./siwc-oauth.js";

/** refresh 锁的获取预算：必须覆盖锁内一次 token 网络请求（默认 withFileLock 8s 不够）。 */
const SIWC_REFRESH_LOCK_MAX_WAIT_MS = 45_000;

/** 凭据缺失或已被授权服务器拒绝（invalid_grant）：需要用户重新登录，重试无意义。 */
export class SiwcAuthRequiredError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SiwcAuthRequiredError";
  }
}

/** 临时性刷新失败（网络/5xx/锁等待超时且无 winner）：可重试。 */
export class SiwcRefreshTemporaryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SiwcRefreshTemporaryError";
  }
}

/**
 * 跨进程单飞刷新 SIWC 凭据。
 *
 * 模式照 MCP oauth-refresh：独立 `.refresh` 锁文件（不能锁 credentials.json——publish 自己
 * 会对它加锁，同路径自重入死锁）；进锁后先比对 generation，已换代直接复用 winner 结果，
 * 避免 refresh token 轮换的 reuse-detection 把 winner 的 token 作废。
 */
export async function refreshSiwcCredentialUnderLock(input: {
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly fetch: SiwcFetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
}): Promise<SiwcCredentialSnapshot> {
  const observed = await loadSiwcCredentialSnapshot(input.credentialStore);
  if (!observed) {
    throw new SiwcAuthRequiredError("SIWC credentials are missing; sign in again.");
  }
  const lockPath = join(dirname(input.credentialStore.filePath), "siwc-chatgpt.refresh");
  try {
    return await withFileLock(
      lockPath,
      async () => refreshLocked({ ...input, observedGeneration: observed.record.generation }),
      { lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS },
    );
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // 等锁超时不等于刷新失败：winner 可能已发布结果。重读并确认换代即可复用。
    const current = await loadSiwcCredentialSnapshot(input.credentialStore);
    if (current && current.record.generation !== observed.record.generation) {
      return current;
    }
    throw new SiwcRefreshTemporaryError("SIWC refresh lock timed out", error);
  }
}

async function refreshLocked(input: {
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly fetch: SiwcFetch;
  readonly signal?: AbortSignal;
  readonly nowMs?: number;
  readonly observedGeneration: string;
}): Promise<SiwcCredentialSnapshot> {
  const current = await loadSiwcCredentialSnapshot(input.credentialStore);
  if (!current) {
    throw new SiwcAuthRequiredError("SIWC credentials are missing; sign in again.");
  }
  if (current.record.generation !== input.observedGeneration) {
    // 另一个进程已完成刷新：直接复用，绝不二次使用已轮换的 refresh token。
    return current;
  }
  const refreshToken = current.record.refreshToken;
  if (!refreshToken) {
    throw new SiwcAuthRequiredError("SIWC credentials have no refresh token; sign in again.");
  }
  let tokens;
  try {
    tokens = await refreshSiwcTokens({
      clientId: current.record.issuedClientId,
      fetch: input.fetch,
      refreshToken,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof SiwcOAuthError && error.oauthErrorCode === "invalid_grant") {
      // refresh token 已失效（吊销/换号/过期）：CAS 失效整条记录后要求重新登录。
      await invalidateSiwcCredentialRecord(input.credentialStore, current.raw);
      throw new SiwcAuthRequiredError("SIWC refresh token was rejected; sign in again.", error);
    }
    throw new SiwcRefreshTemporaryError("SIWC token refresh failed", error);
  }
  const next = buildSiwcCredentialRecord({
    account: siwcClaimsFromAccount(current.record.account),
    hostId: current.record.hostId,
    issuedClientId: current.record.issuedClientId,
    tokens,
    previous: current.record,
    nowMs: input.nowMs,
  });
  await publishSiwcCredentialRecord(input.credentialStore, next);
  const republished = await loadSiwcCredentialSnapshot(input.credentialStore);
  return republished ?? { record: next, raw: JSON.stringify(next) };
}
