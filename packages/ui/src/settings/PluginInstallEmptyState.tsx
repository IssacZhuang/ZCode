import type { ReactNode } from "react";

const CONTAINER_CLASS_NAME =
  "rounded-xl border border-dashed border-border bg-transparent px-4 py-10 text-center";

export function PluginLoadingState({ label }: { label: string }) {
  return (
    <div className={`${CONTAINER_CLASS_NAME} text-ui-base text-foreground-subtle`}>{label}</div>
  );
}

export function PluginSearchEmptyState({ label }: { label: string }) {
  return (
    <div className={`${CONTAINER_CLASS_NAME} text-ui-base text-foreground-subtle`}>{label}</div>
  );
}

export function PluginInstallEmptyState({
  actions,
  description,
  title,
}: {
  /** 市场浏览入口移除后，管理页空态可不提供动作（如已装插件列表），保持纯说明展示。 */
  actions?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 ${CONTAINER_CLASS_NAME}`}>
      <div className="space-y-1">
        <div className="text-ui-base font-medium text-foreground">{title}</div>
        <div className="text-ui-sm text-foreground-subtle">{description}</div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
