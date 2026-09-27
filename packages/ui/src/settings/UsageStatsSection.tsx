import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";

export type UsageStatsSectionTab = "app";

export function UsageStatsSection({ activeTab }: { activeTab: UsageStatsSectionTab }) {
  // 订阅套餐面板已移除；用量统计只保留本地 app 用量（getAppUsageSnapshot）。
  void activeTab;
  return <AppUsagePanel />;
}
