import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsageTier } from "@zcode/shared";
import {
  formatProviderUsageBalanceValue,
  formatProviderUsagePercentage,
  formatProviderUsageResetTime,
  getProviderUsageRemainingPercentage,
  getProviderUsageTierColor,
} from "../src/lib/providerUsageFormat.js";

test("getProviderUsageRemainingPercentage 已用口径反转为剩余并夹取 0-100", () => {
  const fromUsed: ProviderUsageTier = { id: "five_hour", usedPercentage: 40 };
  assert.equal(getProviderUsageRemainingPercentage(fromUsed), 60);
  assert.equal(getProviderUsageRemainingPercentage({ id: "five_hour", usedPercentage: 130 }), 0);
  assert.equal(getProviderUsageRemainingPercentage({ id: "five_hour", usedPercentage: -5 }), 100);

  // 无已用值时回退 remaining/total
  const fallback: ProviderUsageTier = { id: "weekly", remaining: 25, total: 200 };
  assert.equal(getProviderUsageRemainingPercentage(fallback), 12.5);
  assert.equal(getProviderUsageRemainingPercentage({ id: "weekly" }), null);
  assert.equal(getProviderUsageRemainingPercentage({ id: "weekly", remaining: 5, total: 0 }), null);
});

test("formatProviderUsagePercentage 百分位自适应：≥10% 取整、<10% 一位小数", () => {
  assert.equal(formatProviderUsagePercentage("en-US", 60), "60%");
  assert.equal(formatProviderUsagePercentage("en-US", 7.25), "7.3%");
  assert.equal(formatProviderUsagePercentage("en-US", 100), "100%");
});

test("formatProviderUsageBalanceValue 金额与币种拼接", () => {
  assert.equal(
    formatProviderUsageBalanceValue("en-US", { id: "balance", remaining: 51.5, unit: "CNY" }),
    "51.5 CNY",
  );
  assert.equal(formatProviderUsageBalanceValue("en-US", { id: "balance" }), null);
});

test("formatProviderUsageResetTime 按窗口选择时间/日期格式", () => {
  const now = new Date();
  const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 30);
  const nextWeek = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  // five_hour 当日窗口显示 HH:mm
  assert.match(
    formatProviderUsageResetTime("en-US", sameDay.toISOString(), "five_hour") ?? "",
    /^\d{1,2}:\d{2}/,
  );
  // five_hour 跨日回退月日；weekly 恒为月日
  assert.match(
    formatProviderUsageResetTime("en-US", nextWeek.toISOString(), "five_hour") ?? "",
    /^\d{1,2}\/\d{1,2}$/,
  );
  assert.match(
    formatProviderUsageResetTime("en-US", nextWeek.toISOString(), "weekly") ?? "",
    /^\d{1,2}\/\d{1,2}$/,
  );
  assert.equal(formatProviderUsageResetTime("en-US", undefined, "weekly"), null);
  assert.equal(formatProviderUsageResetTime("en-US", "not-a-date", "weekly"), null);
});

test("getProviderUsageTierColor 时间窗映射 chart 色板", () => {
  assert.equal(getProviderUsageTierColor("five_hour"), "var(--color-usage-chart-1)");
  assert.equal(getProviderUsageTierColor("weekly"), "var(--color-usage-chart-2)");
  assert.equal(getProviderUsageTierColor("monthly"), "var(--color-usage-chart-3)");
  assert.equal(getProviderUsageTierColor("balance"), undefined);
});
