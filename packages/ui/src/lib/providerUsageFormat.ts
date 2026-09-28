/**
 * 供应商用量/余额的展示格式化（纯函数，供设置卡与 context 面板共用）。
 *
 * 口径收口（与删除前的 Coding Plan 用量展示一致）：
 * - 服务端 percentage 是"已用占比"，所有展示位统一反转为"剩余"（100 − 已用），
 *   无已用值时回退 remaining/total。
 * - 百分比 0/1 位小数自适应：≥10% 取整，<10% 保留一位小数。
 * - 重置时间：five_hour 窗口显示当日 HH:mm（跨日回退月日）；weekly/monthly 显示月日。
 */
import type { ProviderUsageTier, ProviderUsageTierId } from "@zcode/shared";

/** 剩余百分比 0–100；无法计算时返回 null（展示位回退 "--"）。 */
export function getProviderUsageRemainingPercentage(tier: ProviderUsageTier): number | null {
  if (typeof tier.usedPercentage === "number" && Number.isFinite(tier.usedPercentage)) {
    return Math.max(0, Math.min(100, 100 - tier.usedPercentage));
  }
  if (
    typeof tier.remaining === "number" &&
    Number.isFinite(tier.remaining) &&
    typeof tier.total === "number" &&
    Number.isFinite(tier.total) &&
    tier.total > 0
  ) {
    return Math.max(0, Math.min(100, (tier.remaining / tier.total) * 100));
  }
  return null;
}

/** 百分比文本：≥10% 取整，<10% 一位小数（剩余量小时保留精度更直观）。 */
export function formatProviderUsagePercentage(locale: string, value: number): string {
  const maximumFractionDigits = value >= 10 ? 0 : 1;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits,
  }).format(value / 100);
}

/** 余额金额文本；无值返回 null。 */
export function formatProviderUsageBalanceValue(
  locale: string,
  tier: ProviderUsageTier,
): string | null {
  if (typeof tier.remaining !== "number" || !Number.isFinite(tier.remaining)) {
    return null;
  }
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
  }).format(tier.remaining);
  return tier.unit ? `${formatted} ${tier.unit}` : formatted;
}

/**
 * 重置时间文本。five_hour 窗口优先当日 HH:mm（更接近"几点恢复"的心智），
 * 跨日或无当日在前则回退月日；weekly/monthly 恒为月日。无效输入返回 null。
 */
export function formatProviderUsageResetTime(
  locale: string,
  resetsAt: string | undefined,
  tierId: ProviderUsageTierId,
): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const preferTime = tierId === "five_hour" ? sameDay : false;
  return new Intl.DateTimeFormat(
    locale,
    preferTime ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" },
  ).format(date);
}

/** 计量条内联色：five_hour→chart-1、weekly→chart-2、monthly→chart-3，balance 不渲染进度条。 */
export function getProviderUsageTierColor(tierId: ProviderUsageTierId): string | undefined {
  switch (tierId) {
    case "five_hour":
      return "var(--color-usage-chart-1)";
    case "weekly":
      return "var(--color-usage-chart-2)";
    case "monthly":
      return "var(--color-usage-chart-3)";
    default:
      return undefined;
  }
}

/** tier 标签的 i18n id：统一「时长+用量」表述（5小时用量/7天用量/30天用量），英文同构 5-hour/7-day/30-day usage。 */
export function getProviderUsageTierLabelId(tierId: ProviderUsageTierId): string {
  switch (tierId) {
    case "five_hour":
      return "settings.modelProvider.usage.fiveHour";
    case "weekly":
      return "settings.modelProvider.usage.sevenDay";
    case "monthly":
      return "settings.modelProvider.usage.monthly";
    default:
      return "settings.modelProvider.usage.balanceRemaining";
  }
}
