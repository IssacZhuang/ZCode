/**
 * Sign in with ChatGPT（SIWC 官方 token-sharing 通道）账号服务。
 *
 * 职责与所有权（.specs/chatgpt-signin/spec.md）：
 * - 登录编排：127.0.0.1 回调 server + PKCE + code 交换 + id_token JWKS 验签 + 套餐 scope 判定。
 * - 账号投影唯一所有者：把登录事实投影为第三层 Account Provider Config Overlay
 *   （visibility / entitled / 模型成员 / states），写入 host 运行时的 MutableAccountProviderConfigSource，
 *   并经 zcodeAgentService 推送 provider/updateAccountConfig 给所有已连接 agent（agent ready 后补推）。
 * - 凭据只落 SharedZCodeCredentialStore（加密）；Token、账号身份不进 Config Overlay 与协议消息。
 */
/* oxlint-disable eslint(max-lines) -- 登录编排与账号投影共享同一事务上下文（回调 server、凭据库、投影 source），拆开需要暴露跨文件可变状态，先维持单文件。 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ServiceChannels, zcodeProviderUpdateAccountConfigParamsSchema } from "@zcode/shared";
import {
  ChatgptAccountAccessConfig,
  MutableAccountProviderConfigSource,
  ProviderConfig,
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
  type ProviderConfigSnapshot,
} from "@zcode/provider";
import {
  MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE,
  SIWC_CALLBACK_PATH,
  SiwcCallbackError,
  SiwcIdTokenVerificationError,
  SiwcNetworkError,
  SiwcOAuthError,
  buildSiwcAuthorizeUrl,
  buildSiwcCredentialRecord,
  createLocalhostOAuthCallbackServer,
  createSiwcNonce,
  createSiwcPkce,
  createSiwcState,
  deleteSiwcCredentials,
  exchangeSiwcCode,
  fetchSiwcDiscovery,
  fetchSiwcModelIds,
  hasSiwcDirectTokenScope,
  isSiwcRecordEntitled,
  isSiwcTokenNearExpiry,
  loadSiwcCredentialSnapshot,
  parseSiwcCallbackUrl,
  publishSiwcCredentialRecord,
  refreshSiwcCredentialUnderLock,
  resolveOrCreateSiwcHostId,
  siwcClaimsFromAccount,
  siwcTokenResponseFromRecord,
  verifySiwcIdToken,
  type SharedZCodeCredentialStore,
  type SiwcFetch,
} from "@zcode/provider-node";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

export interface ChatGptAccountSummary {
  readonly email?: string;
  readonly name?: string;
  readonly planType?: string;
}

export interface ChatGptAccountStatus {
  readonly signedIn: boolean;
  readonly entitled: boolean;
  readonly account?: ChatGptAccountSummary;
}

export interface ChatGptSignInStartResult {
  readonly authorizeUrl: string;
  readonly transactionId: string;
}

export type ChatGptSignInFailureReason =
  | "denied"
  | "timeout"
  | "cancelled"
  | "network"
  | "server-error"
  | "protocol"
  | "credential-write-failed";

export type ChatGptSignInPollResult =
  | { readonly status: "pending" }
  | {
      readonly status: "completed";
      readonly entitled: boolean;
      readonly account: ChatGptAccountSummary;
    }
  | {
      readonly status: "failed";
      readonly reason: ChatGptSignInFailureReason;
      readonly message?: string;
    };

export interface IChatGptAccountService {
  /** 发起登录：返回授权 URL（UI 经 IPlatformService.openExternal 打开浏览器）与事务 id。 */
  startSignIn(): Promise<ChatGptSignInStartResult>;
  /** UI 轮询登录进度；事务完成后结果保留到下一次 startSignIn。 */
  pollSignIn(transactionId: string): Promise<ChatGptSignInPollResult>;
  /** 取消进行中的登录（关闭回调 server）。 */
  cancelSignIn(transactionId: string): Promise<void>;
  /** 登出：删除凭据并回退 fail-closed 投影。 */
  signOut(): Promise<void>;
  /** 当前登录状态（服务端事实，UI 不自行缓存）。 */
  getStatus(): Promise<ChatGptAccountStatus>;
  /** host 启动时调用一次：按已存凭据重建账号投影，后台刷新模型目录（容错）。 */
  initialize(): Promise<void>;
}

export const IChatGptAccountService = createServiceDescriptor<IChatGptAccountService>(
  ServiceChannels.ChatGPTAccount,
);

/** host → agent 的账号 Overlay 协议信封（providers 为 providerId → config JSON）。 */
type ProviderAccountConfigEnvelope = z.infer<typeof zcodeProviderUpdateAccountConfigParamsSchema>;

interface ChatGptAccountServiceDependencies {
  readonly accountSource: MutableAccountProviderConfigSource;
  readonly readConfigSnapshot: () => Promise<ProviderConfigSnapshot>;
  readonly createCredentialStore: () => SharedZCodeCredentialStore;
  readonly fetch: SiwcFetch;
  /** 延迟装配：zcodeAgentService 在本服务之后创建，用 getter 解耦初始化顺序。 */
  readonly getSyncProviderAccountConfig?: () =>
    | ((envelope: ProviderAccountConfigEnvelope) => Promise<void>)
    | undefined;
  readonly now?: () => number;
}

/** 登录整体窗口：回调 server 存活与 UI 轮询的上限。 */
const CHATGPT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const CHATGPT_PROVIDER_ID = "chatgpt";

interface SignInTransaction {
  readonly transactionId: string;
  result: ChatGptSignInPollResult | undefined;
  close(): Promise<void>;
}

export function createChatGptAccountService(
  dependencies: ChatGptAccountServiceDependencies,
): IChatGptAccountService {
  const log = createServiceLogger("chatgpt-account");
  let credentialStore: SharedZCodeCredentialStore | undefined;
  let activeTransaction: SignInTransaction | undefined;

  function getStore(): SharedZCodeCredentialStore {
    credentialStore ??= dependencies.createCredentialStore();
    return credentialStore;
  }

  /** 投影登录事实并推送 agent；推送失败只 warn，agent ready 后会补推。 */
  async function applySnapshot(snapshot: AccountProviderConfigSnapshot, reason: string) {
    dependencies.accountSource.replace(snapshot, reason);
    const sync = dependencies.getSyncProviderAccountConfig?.();
    if (!sync) return;
    try {
      await sync(buildAccountConfigEnvelope(snapshot));
    } catch (error) {
      log.warn(undefined, "ChatGPT 账号配置推送到 agent 失败，agent ready 后会补推", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function projectSignedIn(input: {
    readonly entitled: boolean;
    readonly sub: string;
    readonly builtinModelIds: readonly string[];
  }) {
    const config = await dependencies.readConfigSnapshot();
    const states: AccountProviderStates = {
      [CHATGPT_PROVIDER_ID]: {
        availability: input.entitled ? "available" : "unavailable",
        entitled: input.entitled,
        ...(input.entitled ? {} : { unavailableReason: "not-entitled" as const }),
        current: true,
        connectionKey: input.sub,
      },
    };
    const providers = new ProviderConfigMap([
      [
        CHATGPT_PROVIDER_ID,
        new ProviderConfig({
          access: new ChatgptAccountAccessConfig({ entitled: input.entitled }),
          visibility: "visible",
          ...(input.entitled && input.builtinModelIds.length > 0
            ? { builtinModelIds: [...input.builtinModelIds] }
            : {}),
        }),
      ],
    ]);
    await applySnapshot(
      createAccountProviderConfigSnapshot(config.zcodeBuiltinRevision, providers, states),
      "chatgpt-signin",
    );
  }

  async function projectSignedOut() {
    const config = await dependencies.readConfigSnapshot();
    await applySnapshot(createFailClosedAccountProviderConfigSnapshot(config), "chatgpt-signout");
  }

  function classifySignInFailure(error: unknown): ChatGptSignInPollResult {
    if (error instanceof SiwcCallbackError || error instanceof SiwcIdTokenVerificationError) {
      return { status: "failed", reason: "protocol", message: error.message };
    }
    if (error instanceof SiwcNetworkError) {
      return { status: "failed", reason: "network", message: error.message };
    }
    if (error instanceof SiwcOAuthError) {
      // 目录或 OAuth 响应格式错误属于协议校验失败，不能沿用裸 Error 的“网络异常”提示。
      return {
        status: "failed",
        reason: error.oauthErrorCode === "invalid_response" ? "protocol" : "server-error",
        message: error.message,
      };
    }
    const siwcReason = (error as { siwcReason?: ChatGptSignInFailureReason } | null)?.siwcReason;
    if (siwcReason) {
      return { status: "failed", reason: siwcReason };
    }
    // localhost 回调 server 用结构化 code 表达“用户在授权页点了拒绝”。
    const code = (error as { code?: unknown } | null)?.code;
    if (code === MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE) {
      return { status: "failed", reason: "denied" };
    }
    return {
      status: "failed",
      reason: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  async function startSignIn(): Promise<ChatGptSignInStartResult> {
    if (activeTransaction) {
      await cancelSignIn(activeTransaction.transactionId);
    }
    const store = getStore();
    const hostId = await resolveOrCreateSiwcHostId(store);
    const saved = await loadSiwcCredentialSnapshot(store);
    const pkce = createSiwcPkce();
    const state = createSiwcState();
    const nonce = createSiwcNonce();
    const callbackServer = await createLocalhostOAuthCallbackServer({
      callbackPath: SIWC_CALLBACK_PATH,
      state,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const transaction: SignInTransaction = {
      transactionId: randomUUID(),
      result: undefined,
      close: async () => {
        await callbackServer.close().catch(() => undefined);
      },
    };
    activeTransaction = transaction;
    const authorizeUrl = buildSiwcAuthorizeUrl({
      callbackUrl: callbackServer.callbackUrl,
      hostId,
      nonce,
      pkce,
      state,
      ...(saved?.record.issuedClientId ? { issuedClientId: saved.record.issuedClientId } : {}),
      ...(saved?.record.account.email ? { loginHint: saved.record.account.email } : {}),
    });
    log.info(undefined, "ChatGPT 登录事务已启动", {
      registration: saved?.record.issuedClientId === undefined,
    });

    const settle = (result: ChatGptSignInPollResult) => {
      if (transaction.result === undefined) transaction.result = result;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    };
    // 超时窗口：到点即中止事务（结果定格 timeout），后台链上的后续步骤随之失败。
    timeoutHandle = setTimeout(() => {
      if (transaction.result !== undefined) return;
      settle({ status: "failed", reason: "timeout" });
      void transaction.close();
    }, CHATGPT_SIGN_IN_TIMEOUT_MS);

    void (async () => {
      try {
        const callback = await callbackServer.waitForCallback();
        if (transaction.result !== undefined) return;
        const parsed = parseSiwcCallbackUrl(callback.url, {
          savedIssuedClientId: saved?.record.issuedClientId,
        });
        const issuedClientId = parsed.issuedClientId ?? saved?.record.issuedClientId;
        if (!issuedClientId) {
          throw new SiwcCallbackError("missing-issued-client-id", "issued client id missing");
        }
        const discovery = await fetchSiwcDiscovery(dependencies.fetch);
        const tokens = await exchangeSiwcCode({
          clientId: issuedClientId,
          code: parsed.code,
          codeVerifier: pkce.codeVerifier,
          fetch: dependencies.fetch,
          redirectUri: callbackServer.callbackUrl,
        });
        if (!tokens.idToken) {
          throw new SiwcIdTokenVerificationError("token response is missing id_token");
        }
        const claims = await verifySiwcIdToken({
          discovery,
          fetch: dependencies.fetch,
          idToken: tokens.idToken,
          issuedClientId,
          nonce,
        });
        const entitled = hasSiwcDirectTokenScope(tokens.scope);
        // 模型目录在发布凭据前拉取：失败则登录失败，避免“已落凭据但无模型”的中间态。
        let modelIds: readonly string[] = [];
        if (entitled) {
          modelIds = await fetchSiwcModelIds({
            accessToken: tokens.accessToken,
            fetch: dependencies.fetch,
          });
        }
        const record = buildSiwcCredentialRecord({
          account: claims,
          hostId,
          issuedClientId,
          tokens,
          modelIds,
        });
        try {
          await publishSiwcCredentialRecord(store, record);
        } catch (error) {
          throw Object.assign(new Error("credential write failed"), {
            cause: error,
            siwcReason: "credential-write-failed" as const,
          });
        }
        await projectSignedIn({ entitled, sub: claims.sub, builtinModelIds: modelIds });
        log.info(undefined, "ChatGPT 登录完成", {
          entitled,
          issuedClientId: maskClientId(issuedClientId),
        });
        settle({
          status: "completed",
          entitled,
          account: {
            ...(claims.email !== undefined ? { email: claims.email } : {}),
            ...(claims.name !== undefined ? { name: claims.name } : {}),
            ...(claims.chatgptPlanType !== undefined ? { planType: claims.chatgptPlanType } : {}),
          },
        });
      } catch (error) {
        const failure = classifySignInFailure(error);
        log.warn(undefined, "ChatGPT 登录失败", {
          reason: failure.status === "failed" ? failure.reason : "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        settle(failure);
      } finally {
        await callbackServer.close().catch(() => undefined);
      }
    })();

    return { authorizeUrl, transactionId: transaction.transactionId };
  }

  async function cancelSignIn(transactionId: string): Promise<void> {
    const transaction = activeTransaction;
    if (!transaction || transaction.transactionId !== transactionId) return;
    if (transaction.result === undefined) {
      transaction.result = { status: "failed", reason: "cancelled" };
    }
    await transaction.close();
  }

  async function initialize(): Promise<void> {
    const store = getStore();
    const snapshot = await loadSiwcCredentialSnapshot(store);
    if (!snapshot) {
      await projectSignedOut();
      return;
    }
    const { record } = snapshot;
    const entitled = isSiwcRecordEntitled(record);
    // 先按已存目录投影（重启后模型保持），再后台刷新；刷新失败不影响当前投影。
    await projectSignedIn({
      entitled,
      sub: record.account.sub,
      builtinModelIds: entitled ? (record.modelIds ?? []) : [],
    });
    if (!entitled) return;
    try {
      const token = isSiwcTokenNearExpiry(record)
        ? (
            await refreshSiwcCredentialUnderLock({
              credentialStore: store,
              fetch: dependencies.fetch,
            })
          ).record
        : record;
      const modelIds = await fetchSiwcModelIds({
        accessToken: token.accessToken,
        fetch: dependencies.fetch,
      });
      // 目录有变化时把新目录随凭据一起发布，供下次重启沿用。
      if (JSON.stringify(modelIds) !== JSON.stringify(record.modelIds ?? [])) {
        await publishSiwcCredentialRecord(
          store,
          buildSiwcCredentialRecord({
            account: siwcClaimsFromAccount(token.account),
            hostId: token.hostId,
            issuedClientId: token.issuedClientId,
            tokens: siwcTokenResponseFromRecord(token),
            previous: token,
            modelIds,
          }),
        );
      }
      await projectSignedIn({
        entitled,
        sub: record.account.sub,
        builtinModelIds: modelIds,
      });
    } catch (error) {
      log.warn(undefined, "ChatGPT 启动模型目录刷新失败，沿用已存目录", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function signOut(): Promise<void> {
    if (activeTransaction) {
      await cancelSignIn(activeTransaction.transactionId);
    }
    await deleteSiwcCredentials(getStore());
    await projectSignedOut();
    log.info(undefined, "ChatGPT 已登出");
  }

  return {
    startSignIn,
    pollSignIn: async (transactionId) => {
      const transaction = activeTransaction;
      if (!transaction || transaction.transactionId !== transactionId) {
        return { status: "failed", reason: "protocol", message: "unknown transaction" };
      }
      return transaction.result ?? { status: "pending" };
    },
    cancelSignIn,
    signOut,
    getStatus: async () => {
      const snapshot = await loadSiwcCredentialSnapshot(getStore());
      if (!snapshot) {
        return { signedIn: false, entitled: false };
      }
      const { record } = snapshot;
      return {
        signedIn: true,
        entitled: isSiwcRecordEntitled(record),
        account: {
          ...(record.account.email !== undefined ? { email: record.account.email } : {}),
          ...(record.account.name !== undefined ? { name: record.account.name } : {}),
          ...(record.account.planType !== undefined ? { planType: record.account.planType } : {}),
        },
      };
    },
    initialize,
  };
}

function maskClientId(clientId: string): string {
  return clientId.length <= 12 ? "…" : `${clientId.slice(0, 8)}…${clientId.slice(-4)}`;
}

/** Account 快照 → provider/updateAccountConfig 协议信封（CLI 端 zod 校验可解析）。 */
function buildAccountConfigEnvelope(
  snapshot: AccountProviderConfigSnapshot,
): ProviderAccountConfigEnvelope {
  return {
    revision: snapshot.revision,
    basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
    providers: Object.fromEntries(
      snapshot.providers.entries().map(([providerId, config]) => [providerId, config.toJSON()]),
    ),
    // 协议要求 states 必填；fail-closed 快照没有账号状态时传空对象（语义：无账号权益）。
    states: snapshot.states ?? {},
  };
}
