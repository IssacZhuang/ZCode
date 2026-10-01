import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
export type ModelProviderNavItem = {
  key: string;
  type: "custom" | "chatgpt";
  label: string;
  provider: ProviderSettingsFormProvider;
  statusActive: boolean;
};

export type ModelProviderNavGroupId = "custom" | "chatgpt";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
