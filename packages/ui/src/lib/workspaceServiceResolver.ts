import type { IServiceAccessor } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceServiceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface ResolvedWorkspaceServices {
  services: IServiceAccessor;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
}

export function isRemoteWorkspaceTarget(target: WorkspaceServiceTarget): boolean {
  return Boolean(target.workspaceIdentity?.trim() || target.remoteSessionId?.trim());
}

export function resolveWorkspaceServices(
  target: WorkspaceServiceTarget,
  baseServices: IServiceAccessor,
): ResolvedWorkspaceServices | null {
  const isRemoteWorkspace = isRemoteWorkspaceTarget(target);

  // 携带远程身份（workspaceIdentity/remoteSessionId）的目标在本 fork 中没有远端
  // session 可用：保持失败关闭，不回退 baseServices，避免把远端 workspace 的查询
  // 误路由到本机 host。
  if (isRemoteWorkspace) {
    return null;
  }

  return {
    services: baseServices,
    isRemoteWorkspace,
  };
}

export function buildWorkspaceServiceLookup(
  workspaceTabs: WorkspaceServiceTarget[],
  baseServices: IServiceAccessor,
): Map<string, ResolvedWorkspaceServices> {
  const lookup = new Map<string, ResolvedWorkspaceServices>();

  for (const tab of workspaceTabs) {
    const resolved = resolveWorkspaceServices(tab, baseServices);
    if (!resolved) {
      continue;
    }

    lookup.set(buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity), resolved);
  }

  return lookup;
}
