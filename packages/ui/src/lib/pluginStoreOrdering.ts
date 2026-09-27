// 个人本地版排序：远端 pluginStoreOrder 配置已随 clientConfigService 移除，
// 这里保留原 shared 排序的“无远端配置”默认分支，供商店条目与已安装列表复用。
export const FALLBACK_PLUGIN_STORE_CATEGORY = "other";
export const PLUGIN_STORE_CATEGORY_ORDER: readonly string[] = [
  "productivity",
  "developer-tools",
  "utilities",
  "finance",
  "legal",
  "template",
];

/** 分类归并只影响展示，市场与引用 Picker 必须使用同一个排序键。 */
export function resolvePluginStoreCategory(category: string | undefined): string | undefined {
  const normalized = category?.trim();
  return normalized === "guides" ? "utilities" : normalized || undefined;
}

interface PluginStoreSortEntry {
  id: string;
  category?: string;
  displayName: string;
}

/** 纯展示排序：剩余分类按产品默认顺序，类内按本地化名称稳定兜底。 */
export function sortPluginStoreEntries<T>(
  items: readonly T[],
  project: (item: T) => PluginStoreSortEntry,
  locale: string,
): T[] {
  return items
    .map((item, index) => {
      const entry = project(item);
      return {
        item,
        index,
        ...entry,
        category: resolvePluginStoreCategory(entry.category) ?? FALLBACK_PLUGIN_STORE_CATEGORY,
      };
    })
    .sort(
      (left, right) =>
        compareCategories(left.category, right.category) ||
        left.displayName.localeCompare(right.displayName, locale) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

function compareCategories(left: string, right: string): number {
  if (left === right) return 0;
  if (left === FALLBACK_PLUGIN_STORE_CATEGORY) return 1;
  if (right === FALLBACK_PLUGIN_STORE_CATEGORY) return -1;
  const a = PLUGIN_STORE_CATEGORY_ORDER.indexOf(left);
  const b = PLUGIN_STORE_CATEGORY_ORDER.indexOf(right);
  if (a !== -1 && b !== -1) return a - b;
  if (a !== -1) return -1;
  if (b !== -1) return 1;
  return left < right ? -1 : 1;
}
