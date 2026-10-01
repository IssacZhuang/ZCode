import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";

interface UseModelProviderNavigationOptions {
  modelProviders: ProviderSettingsFormProvider[];
  displayOrder?: ProviderOrderView;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export function useModelProviderNavigation({
  modelProviders,
  displayOrder,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    // 这里复用模型菜单的展示排序，确保设置页和聊天框供应商顺序一致。
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  // ChatGPT 账号族：未登录时 builtin provider visibility:hidden 不进 View，分组自然为空。
  const chatgptProviders = useMemo(
    () => modelProviders.filter((provider) => provider.config.group === "chatgpt-family"),
    [modelProviders],
  );

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(
    () => [
      ...(chatgptProviders.length > 0
        ? [
            {
              id: "chatgpt" as const,
              title: intl.formatMessage({ id: "settings.modelProvider.chatgpt.groupTitle" }),
              items: chatgptProviders.map((provider) => ({
                key: createCustomProviderNodeKey(provider.providerId),
                type: "chatgpt" as const,
                label: getProviderFormLabel(provider),
                provider,
                statusActive: provider.executable === true,
              })),
            },
          ]
        : []),
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ],
    [
      chatgptProviders,
      customProviders,
      // 左侧导航分组标题在这个 memo 内格式化。
      // 语言切换时 provider 引用可能不变，必须依赖 intl 才能刷新旧 locale 的文案。
      intl,
    ],
  );

  const navigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items),
    [navigationGroups],
  );

  const navigationItemByKey = useMemo(
    () => new Map(navigationItems.map((item) => [item.key, item])),
    [navigationItems],
  );

  const selectedNavItem = selectedNodeKey
    ? (navigationItemByKey.get(selectedNodeKey) ?? null)
    : null;

  const fallbackNodeKey = navigationItems[0]?.key ?? null;
  useEffect(() => {
    if (selectedNodeKey && navigationItemByKey.has(selectedNodeKey)) {
      return;
    }

    // 初始化只在没有有效选中项时发生；如果当前用户选择仍有效，不会用 fallback 抢焦点。
    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [fallbackNodeKey, selectedNodeKey, setSelectedNodeKey, navigationItemByKey]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
  };
}
