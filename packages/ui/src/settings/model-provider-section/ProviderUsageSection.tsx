/**
 * 供应商卡片上的「用量与余额」区块。
 *
 * 仅当 base_url 命中内置用量适配器（shared 的 detectProviderUsageAdapterId）时渲染；
 * 套餐类供应商展示各时间窗剩余百分比/重置时间/进度条，余额类展示剩余金额。
 * 视觉语言沿用账号体系移除前的额度计量卡（剩余百分比大字 + chart 色进度条）。
 */
import { detectProviderUsageAdapterId } from "@zcode/shared";
import { Loader2, RefreshCw } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderUsage } from "@/hooks/useProviderUsage.js";
import { Button } from "@/components/ui/button.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  formatProviderUsageBalanceValue,
  formatProviderUsagePercentage,
  formatProviderUsageResetTime,
  getProviderUsageRemainingPercentage,
  getProviderUsageTierColor,
  getProviderUsageTierLabelId,
} from "@/lib/providerUsageFormat.js";
import type { ProviderUsageTier } from "@zcode/shared";

function ProviderUsageMeterRow({
  tier,
  locale,
  label,
}: {
  tier: ProviderUsageTier;
  locale: string;
  label: string;
}) {
  const remaining = getProviderUsageRemainingPercentage(tier);
  const resetLabel = formatProviderUsageResetTime(locale, tier.resetsAt, tier.id);
  const color = getProviderUsageTierColor(tier.id);
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{label}</span>
        {resetLabel ? (
          <span className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle">
            {resetLabel}
          </span>
        ) : null}
      </div>
      <div className="text-ui-lg font-semibold tabular-nums text-foreground">
        {remaining === null ? "--" : formatProviderUsagePercentage(locale, remaining)}
      </div>
      {remaining !== null && color ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          {/* min-w-1.5 防止低剩余量时进度条消失；宽度=剩余（与主数值同口径） */}
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${remaining > 0 ? "min-w-1.5" : ""}`}
            style={{ width: `${remaining}%`, backgroundColor: color }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ProviderUsageSection({ provider }: { provider: ProviderSettingsFormProvider }) {
  const { intl, locale } = useZCodeIntl();
  // 与服务端共用同一识别函数：表单当前 baseUrl 未命中即整块不渲染
  const baseUrl = provider.config.api?.baseUrl ?? "";
  const adapterSupported = detectProviderUsageAdapterId(baseUrl) !== null;
  const { snapshot, loading, error, refresh } = useProviderUsage(
    adapterSupported ? provider.providerId : null,
  );
  if (!adapterSupported) return null;

  const errorCode = snapshot?.error?.code;
  const failed = Boolean(error) || errorCode !== undefined;
  const balanceTier = snapshot?.tiers.find((tier) => tier.id === "balance");
  const balanceValue = balanceTier ? formatProviderUsageBalanceValue(locale, balanceTier) : null;
  const numberFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.usage.sectionTitle" })}
        </label>
        <div className="flex items-center gap-1">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-foreground-subtle" aria-hidden="true" />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.modelProvider.usage.refresh" })}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {failed ? (
        <div className="flex min-h-8 items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="min-w-0 text-ui-base text-foreground-subtle">
            {errorCode === "missing-api-key"
              ? intl.formatMessage({ id: "settings.modelProvider.usage.missingApiKey" })
              : errorCode === "auth-failed"
                ? intl.formatMessage({ id: "settings.modelProvider.usage.authFailed" })
                : intl.formatMessage({ id: "settings.modelProvider.usage.queryFailed" })}
          </span>
          {errorCode !== "missing-api-key" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {intl.formatMessage({ id: "settings.modelProvider.usage.retry" })}
            </Button>
          ) : null}
        </div>
      ) : snapshot?.kind === "balance" ? (
        <div className="space-y-1">
          <div className="text-ui-lg font-semibold tabular-nums text-foreground">
            {balanceValue ?? "--"}
          </div>
          {balanceTier &&
          typeof balanceTier.used === "number" &&
          typeof balanceTier.total === "number" ? (
            <div className="text-ui-sm tabular-nums text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.modelProvider.usage.balanceUsedTotal" },
                {
                  used: numberFormatter.format(balanceTier.used),
                  total: numberFormatter.format(balanceTier.total),
                  unit: balanceTier.unit ?? "",
                },
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {(snapshot?.tiers ?? []).map((tier) => (
            <ProviderUsageMeterRow
              key={tier.id}
              tier={tier}
              locale={locale}
              label={intl.formatMessage({ id: getProviderUsageTierLabelId(tier.id) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
