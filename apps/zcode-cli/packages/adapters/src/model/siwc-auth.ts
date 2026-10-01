/**
 * Sign in with ChatGPT（SIWC）请求期鉴权源。
 *
 * ChatGPT 账号模型的 access token 在 CLI 本地解析：读共享加密凭据库，临期时走
 * 跨进程单飞刷新（轮换 refresh token 原子替换），再把 accessToken 作为 Bearer
 * 注入每 attempt 的 requestAuth。与 zhipu-account 不同，SIWC 不经 Host 反向 RPC——
 * 凭据与 Host 同库同锁，CLI 进程内即可完成刷新，避免把 token 送回协议通道。
 */
import {
  createSharedZCodeCredentialStore,
  isSiwcRecordEntitled,
  isSiwcTokenNearExpiry,
  loadSiwcCredentialSnapshot,
  refreshSiwcCredentialUnderLock,
  SiwcAuthRequiredError,
  type SharedZCodeCredentialStore,
  type SiwcFetch,
} from "@zcode/provider-node";
import type { ModelRequestAuth, ModelRequestAuthSource } from "@zcode/contracts";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";

export interface SiwcModelRequestAuthSourceOptions {
  /** 测试注入；缺省使用 ~/.zcode/v2 共享凭据库。 */
  readonly createCredentialStore?: () => SharedZCodeCredentialStore;
  /** Host 注入的显式代理、No Proxy 与 CA 配置；不读取 shell 标准代理变量。 */
  readonly env?: Record<string, string | undefined>;
  /** 测试注入；缺省复用 Agent 的显式网络配置。 */
  readonly fetch?: SiwcFetch;
  readonly onAuthRequired?: (reason: string) => void;
}

export function createSiwcModelRequestAuthSource(
  options: SiwcModelRequestAuthSourceOptions = {},
): ModelRequestAuthSource {
  // token 刷新曾直接使用 global fetch，绕过 Host 注入的代理，导致登录成功后临期刷新仍失败。
  // 复用模型请求的显式网络入口，保留 No Proxy/CA，并继续忽略 shell 标准代理变量。
  const refreshFetch =
    options.fetch ?? createNetworkProxyFetch({ env: options.env ?? process.env });
  let store: SharedZCodeCredentialStore | undefined;
  const resolveStore = (): SharedZCodeCredentialStore => {
    store ??= options.createCredentialStore?.() ?? createSharedZCodeCredentialStore();
    return store;
  };

  return {
    async resolve() {
      const snapshot = await loadSiwcCredentialSnapshot(resolveStore());
      if (!snapshot) {
        // 无凭据 fail-closed：runner 会以 ModelRequestAuthMissing 终止请求。
        options.onAuthRequired?.("no-credentials");
        return undefined;
      }
      let record = snapshot.record;
      if (!isSiwcRecordEntitled(record)) {
        options.onAuthRequired?.("not-entitled");
        return undefined;
      }
      if (isSiwcTokenNearExpiry(record)) {
        try {
          record = (
            await refreshSiwcCredentialUnderLock({
              credentialStore: resolveStore(),
              fetch: refreshFetch,
            })
          ).record;
        } catch (error) {
          if (error instanceof SiwcAuthRequiredError) {
            // refresh token 已失效：登录态过期，交由 fail-closed 提示重新登录。
            options.onAuthRequired?.("refresh-expired");
            return undefined;
          }
          // 瞬态失败（网络/锁竞争）直接上抛，让既有重试预算决定后续 attempt。
          throw error;
        }
      }
      return { apiKey: record.accessToken } satisfies ModelRequestAuth;
    },
  };
}
