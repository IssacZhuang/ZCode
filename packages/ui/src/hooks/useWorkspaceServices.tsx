import type { IServiceAccessor } from "@zcode/services";
import { useMemo } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useBaseWorkspaceServicesStore } from "@/store/baseWorkspaceServicesStore.js";

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useBaseWorkspaceServicesStore((state) => state.baseServices);

  // App 会在当前激活 workspace 外层再套一层 ServiceProvider。
  // 跨 workspace 查询（timeline/search 等）必须继续查本机 host；
  // 这里优先使用 renderer 启动时注册的根 services，避免嵌套 Provider 覆盖本地任务列表。
  return registeredBaseServices ?? contextServices;
}

interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  _workspacePath: string | null | undefined,
  _preferredRemoteSessionId?: string | null,
  _workspaceIdentity?: string | null,
): WorkspaceServicesResolution {
  const contextServices = useServices();
  const baseServices = useBaseWorkspaceServicesStore((state) => state.baseServices);

  return useMemo(
    () => ({
      services: baseServices ?? contextServices,
      remoteSessionId: null,
      isRemoteTarget: false,
      connectionKind: "local-ready",
      rpcReady: true,
    }),
    [baseServices, contextServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IServiceAccessor {
  return useWorkspaceServicesResolution(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    .services;
}
