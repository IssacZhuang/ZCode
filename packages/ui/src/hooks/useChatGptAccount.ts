/**
 * ChatGPT（Sign in with ChatGPT）账号登录 Hook。
 *
 * 账号事实只以服务端为准：卡片信息读 getStatus()，登录进度轮询 pollSignIn；
 * 本 Hook 不缓存登录结果——登录完成后 Registry onDidChange 会自动刷新
 * Provider Settings View，卡片出现/消失由视图收敛，UI 不自行拼装状态。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatGptAccountStatus } from "@zcode/services";
import { logger } from "@/logger.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";

/** 登录轮询间隔；事务本身在 host 侧 5min 超时，这里只做进度拉取。 */
const CHATGPT_SIGN_IN_POLL_INTERVAL_MS = 1500;
const CHATGPT_SIGN_IN_POLL_MAX_MS = 5 * 60 * 1000 + 10_000;

interface ChatGptSignInSession {
  readonly transactionId: string;
  readonly openedAt: number;
}

export type ChatGptSignInPhase =
  | { readonly status: "idle" }
  | { readonly status: "signing-in" }
  | { readonly status: "completed"; readonly entitled: boolean }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly message?: string;
    };

export function useChatGptAccount() {
  const { chatGptAccountService } = useServices();
  const platform = usePlatform();
  const [signInPhase, setSignInPhase] = useState<ChatGptSignInPhase>({ status: "idle" });
  const [signingOut, setSigningOut] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<ChatGptSignInSession | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== undefined) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollSignIn = useCallback(
    (transactionId: string, openedAt: number) => {
      const schedule = () => {
        pollTimerRef.current = setTimeout(
          () => pollSignIn(transactionId, openedAt),
          CHATGPT_SIGN_IN_POLL_INTERVAL_MS,
        );
      };
      void chatGptAccountService
        .pollSignIn(transactionId)
        .then((result) => {
          if (sessionRef.current?.transactionId !== transactionId) return;
          if (result.status === "pending") {
            if (Date.now() - openedAt > CHATGPT_SIGN_IN_POLL_MAX_MS) {
              stopPolling();
              setSignInPhase({ status: "failed", reason: "timeout" });
              return;
            }
            schedule();
            return;
          }
          stopPolling();
          sessionRef.current = undefined;
          if (result.status === "completed") {
            setSignInPhase({ status: "completed", entitled: result.entitled });
            return;
          }
          setSignInPhase({
            status: "failed",
            reason: result.reason,
            ...(result.message !== undefined ? { message: result.message } : {}),
          });
        })
        .catch((error: unknown) => {
          if (sessionRef.current?.transactionId !== transactionId) return;
          stopPolling();
          sessionRef.current = undefined;
          setSignInPhase({
            status: "failed",
            reason: "network",
            ...(error instanceof Error ? { message: error.message } : {}),
          });
        });
    },
    [chatGptAccountService, stopPolling],
  );

  const startSignIn = useCallback(async () => {
    stopPolling();
    const previous = sessionRef.current;
    if (previous) {
      await chatGptAccountService.cancelSignIn(previous.transactionId).catch(() => undefined);
      sessionRef.current = undefined;
    }
    setSignInPhase({ status: "signing-in" });
    try {
      const { authorizeUrl, transactionId } = await chatGptAccountService.startSignIn();
      sessionRef.current = { transactionId, openedAt: Date.now() };
      // 浏览器打开失败不回滚事务：用户可手动复制 URL 重试，轮询继续。
      platform.openExternal(authorizeUrl);
      pollSignIn(transactionId, Date.now());
    } catch (error) {
      sessionRef.current = undefined;
      setSignInPhase({
        status: "failed",
        reason: "network",
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    }
  }, [chatGptAccountService, platform, pollSignIn, stopPolling]);

  const cancelSignIn = useCallback(async () => {
    const session = sessionRef.current;
    stopPolling();
    if (!session) {
      setSignInPhase({ status: "idle" });
      return;
    }
    sessionRef.current = undefined;
    await chatGptAccountService.cancelSignIn(session.transactionId).catch(() => undefined);
    setSignInPhase({ status: "idle" });
  }, [chatGptAccountService, stopPolling]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setStatusError(null);
    try {
      await chatGptAccountService.signOut();
      setSignInPhase({ status: "idle" });
    } catch (error) {
      logger.warn("[useChatGptAccount] 登出失败", { error });
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setSigningOut(false);
    }
  }, [chatGptAccountService]);

  const getStatus = useCallback(async (): Promise<ChatGptAccountStatus | null> => {
    setStatusError(null);
    try {
      return await chatGptAccountService.getStatus();
    } catch (error) {
      logger.warn("[useChatGptAccount] 查询登录状态失败", { error });
      setStatusError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [chatGptAccountService]);

  return {
    signInPhase,
    signingOut,
    statusError,
    startSignIn,
    cancelSignIn,
    signOut,
    getStatus,
  };
}
