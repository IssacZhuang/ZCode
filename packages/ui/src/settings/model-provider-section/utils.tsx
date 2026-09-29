import type { ReactNode } from "react";
import { ProviderLogo } from "./ProviderLogo.js";
import { type ModelProviderNavItem } from "./constants.js";

export function createCustomProviderNodeKey(id: string): string {
  return `custom:${id}`;
}

export function renderModelProviderNavIcon(item: ModelProviderNavItem): ReactNode {
  return <ProviderLogo logo={item.provider.config.logo} className="size-4" />;
}
