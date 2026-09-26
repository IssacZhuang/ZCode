import { useMemo } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

interface WorkspaceOpenInEditorScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function resolveWorkspaceOpenInEditorTarget(
  tabs: readonly WindowTabState[],
  scope: WorkspaceOpenInEditorScope,
) {
  if (!scope.workspacePath) {
    return { isRemoteWorkspace: false };
  }

  const requestedIdentity = scope.workspaceIdentity?.trim() || undefined;
  const requestedRemoteSessionId = scope.workspaceRemoteSessionId?.trim() || undefined;
  const workspaceKey = requestedIdentity || scope.workspacePath;
  const matches = tabs.filter((tab): tab is WorkspaceTabState => {
    if (!isWorkspaceTab(tab) || tab.workspacePath !== scope.workspacePath) {
      return false;
    }

    const tabWorkspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    const tabRemoteSessionId = tab.remoteSessionId?.trim() || undefined;
    return (
      (!requestedIdentity || tabWorkspaceKey === workspaceKey) &&
      (!requestedRemoteSessionId || tabRemoteSessionId === requestedRemoteSessionId)
    );
  });
  const hasRemoteMatch = matches.some((tab) =>
    Boolean(tab.workspaceIdentity || tab.remoteSessionId),
  );
  return {
    isRemoteWorkspace: hasRemoteMatch,
  };
}

export function useWorkspaceOpenInEditorTarget(scope: WorkspaceOpenInEditorScope) {
  const tabs = useOptionalTabStore((state) => state.tabs);

  return useMemo(
    () => resolveWorkspaceOpenInEditorTarget(tabs, scope),
    [scope.workspaceIdentity, scope.workspacePath, scope.workspaceRemoteSessionId, tabs],
  );
}
