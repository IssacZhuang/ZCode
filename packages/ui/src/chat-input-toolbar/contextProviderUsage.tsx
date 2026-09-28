/**
 * context 面板内的「供应商额度/账户余额」区块。
 *
 * 按当前会话的模型 providerId 查询用量快照（host 侧按 base_url 域名识别内置适配器）；
 * 未识别适配器或未配置 key 时静默不渲染。视觉语言沿用删除前的配额计量条
 * （label 行 + font-mono 数值行 + chart 色进度条，1/2/≥3 条网格封顶三列）。
 */
import { useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { useProviderUsage } from "@/hooks/useProviderUsage.js";
import {
  formatProviderUsageBalanceValue,
  formatProviderUsagePercentage,
  formatProviderUsageResetTime,
  getProviderUsageRemainingPercentage,
  getProviderUsageTierColor,
  getProviderUsageTierLabelId,
} from "@/lib/providerUsageFormat.js";

/** 重建删除前的配额网格规则：320px 浮层内 1/2/≥3 条分别 1/2/3 列封顶。 */
function getContextQuotaMeterGridClass(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-2";
  return "grid-cols-3";
}

export function ContextProviderUsageSection({
  modelProviderId,
  locale,
  intl,
}: {
  modelProviderId: string | null | undefined;
  locale: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}) {
  const { snapshot, loading, error, refresh } = useProviderUsage(modelProviderId, {
    auto: false,
  });

  // 面板展开时查询一次；providerId 变化（切换会话/供应商）后重新查询
  useEffect(() => {
    if (modelProviderId) void refresh();
  }, [modelProviderId, refresh]);

  // 未识别适配器/未配置 key：静默不渲染，不打扰上下文容量主体
  const errorCode = snapshot?.error?.code;
  if (!modelProviderId || errorCode === "unsupported" || errorCode === "missing-api-key") {
    return null;
  }

  const isBalance = snapshot?.kind === "balance";
  const balanceTier = snapshot?.tiers.find((tier) => tier.id === "balance");
  const quotaMeters = (snapshot?.tiers ?? []).filter((tier) => tier.id !== "balance");
  const titleId = isBalance
    ? "chat.contextUsage.providerBalanceTitle"
    : "chat.contextUsage.providerQuotaTitle";

  return (
    <div
      className="flex flex-col gap-2 border-t border-border pt-3"
      aria-label={intl.formatMessage({ id: titleId })}
    >
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: titleId })}
        </span>
        {loading ? (
          <Loader2 className="size-3.5 animate-spin text-foreground-subtle" aria-hidden="true" />
        ) : error || errorCode ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle hover:text-foreground"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3" aria-hidden="true" />
            {intl.formatMessage({ id: "chat.contextUsage.providerQuotaRetry" })}
          </button>
        ) : null}
      </div>
      {error || errorCode ? (
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.contextUsage.providerQuotaFailed" })}
        </div>
      ) : isBalance ? (
        <div className="font-mono text-ui-sm tabular-nums text-foreground">
          {balanceTier ? (formatProviderUsageBalanceValue(locale, balanceTier) ?? "--") : "--"}
        </div>
      ) : (
        <div className={cn("grid gap-2", getContextQuotaMeterGridClass(quotaMeters.length))}>
          {quotaMeters.map((tier) => {
            const remaining = getProviderUsageRemainingPercentage(tier);
            const resetLabel = formatProviderUsageResetTime(locale, tier.resetsAt, tier.id);
            const color = getProviderUsageTierColor(tier.id);
            return (
              <div key={tier.id} className="min-w-0 space-y-1.5">
                <div className="min-w-0 space-y-0.5 text-ui-sm">
                  <div className="flex min-h-5 min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate text-foreground-subtle">
                      {intl.formatMessage({ id: getProviderUsageTierLabelId(tier.id) })}
                    </span>
                  </div>
                  <div className="min-w-0 overflow-hidden whitespace-nowrap text-ui-sm tabular-nums">
                    <span className="font-mono text-foreground">
                      {remaining === null ? "--" : formatProviderUsagePercentage(locale, remaining)}
                    </span>
                    {resetLabel ? (
                      <span className="ml-1.5 text-foreground-subtle">{resetLabel}</span>
                    ) : null}
                  </div>
                </div>
                {remaining !== null && color ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${remaining > 0 ? "min-w-1.5" : ""}`}
                      style={{ width: `${remaining}%`, backgroundColor: color }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
