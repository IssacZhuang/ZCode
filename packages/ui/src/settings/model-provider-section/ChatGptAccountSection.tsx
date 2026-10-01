/**
 * ChatGPT 卡片上的「账号」区块（Sign in with ChatGPT）。
 *
 * 已登录展示账号身份（email/姓名/套餐）与 Sign out；未获套餐授权（entitled:false，
 * 即授权 scope 不含 chatgpt.tokens.use.direct）时展示套餐不支持说明。
 * 账号信息读服务端 getStatus()，登录/登出后 Registry 视图自动收敛卡片可见性。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, Loader2, LogOut } from "lucide-react";
import type { AccountProviderState } from "@zcode/provider";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useChatGptAccount, type ChatGptSignInPhase } from "@/hooks/useChatGptAccount.js";
import { Button } from "@/components/ui/button.js";

function resolveChatGptSignInFailureMessageId(reason: string): string {
  switch (reason) {
    case "denied":
      return "settings.modelProvider.chatgpt.signInFailed.denied";
    case "timeout":
      return "settings.modelProvider.chatgpt.signInFailed.timeout";
    case "cancelled":
      return "settings.modelProvider.chatgpt.signInFailed.cancelled";
    case "credential-write-failed":
      return "settings.modelProvider.chatgpt.signInFailed.credentialWriteFailed";
    case "protocol":
      return "settings.modelProvider.chatgpt.signInFailed.protocol";
    case "server-error":
      // HTTP 403 等服务端拒绝曾被误报为断网；保留服务端原因，但不展示原始响应内容。
      return "settings.modelProvider.chatgpt.signInFailed.serverError";
    default:
      return "settings.modelProvider.chatgpt.signInFailed.network";
  }
}

/** 「添加供应商 → ChatGPT」的登录等待/失败面板：授权在浏览器完成，这里只反映事务进度。 */
export function ChatGptSignInPanel({
  phase,
  onRetry,
  onCancel,
  onBack,
}: {
  phase: ChatGptSignInPhase;
  onRetry: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const { intl } = useZCodeIntl();
  const failed = phase.status === "failed";
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          onClick={failed ? onBack : onCancel}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signInTitle" })}
        </h2>
      </div>
      <div className="flex min-h-16 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        {failed ? null : (
          <Loader2
            className="size-4 shrink-0 animate-spin text-foreground-subtle"
            aria-hidden="true"
          />
        )}
        <p className="min-w-0 flex-1 text-ui-base text-foreground-subtle">
          {failed
            ? intl.formatMessage({
                id: resolveChatGptSignInFailureMessageId(phase.reason),
              })
            : intl.formatMessage({ id: "settings.modelProvider.chatgpt.signInWaiting" })}
        </p>
        {failed ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signInRetry" })}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signInCancel" })}
          </Button>
        )}
      </div>
    </section>
  );
}

function resolveChatGptAccountLine(
  account:
    | { readonly email?: string; readonly name?: string; readonly planType?: string }
    | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (!account) return intl.formatMessage({ id: "settings.modelProvider.chatgpt.accountSignedIn" });
  const identity = account.email ?? account.name;
  const planLabel = account.planType
    ? intl.formatMessage(
        { id: "settings.modelProvider.chatgpt.planLabel" },
        { plan: account.planType },
      )
    : undefined;
  if (identity && planLabel) return `${identity} · ${planLabel}`;
  return (
    identity ??
    planLabel ??
    intl.formatMessage({ id: "settings.modelProvider.chatgpt.accountSignedIn" })
  );
}

export function ChatGptAccountSection({ accountState }: { accountState?: AccountProviderState }) {
  const { intl } = useZCodeIntl();
  const { getStatus, signOut, signingOut, statusError } = useChatGptAccount();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getStatus>>>(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await getStatus());
  }, [getStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, accountState]);

  if (!status?.signedIn) {
    return null;
  }

  const notEntitled = !status.entitled || accountState?.entitled === false;

  return (
    <div className="space-y-2">
      <label className="block text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.chatgpt.accountSectionTitle" })}
      </label>
      <div className="flex min-h-8 items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-ui-base text-foreground">
            {resolveChatGptAccountLine(status.account, intl)}
          </p>
          {notEntitled ? (
            <p className="mt-0.5 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.notEntitledHint" })}
            </p>
          ) : null}
          {statusError ? <p className="mt-0.5 text-ui-sm text-destructive">{statusError}</p> : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="size-3.5" aria-hidden="true" />
          )}
          {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signOut" })}
        </Button>
      </div>
    </div>
  );
}
