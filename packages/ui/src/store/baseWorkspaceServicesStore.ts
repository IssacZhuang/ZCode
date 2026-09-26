/**
 * BaseWorkspaceServices Store —— 窗口根级 services 注册表
 *
 * 桌面 renderer 启动时注册一次根 IServiceAccessor；跨 workspace 查询
 * （timeline/search 等）必须继续查本机 host，不能被当前激活 workspace 的
 * ServiceProvider 覆盖。之前该注册表寄生在远程 workspace session store 中，
 * 远程工作区移除后拆成独立小 store。
 */
import { create } from "zustand";
import type { IServiceAccessor } from "@zcode/services";

interface BaseWorkspaceServicesState {
  baseServices: IServiceAccessor | null;
  registerBaseServices: (services: IServiceAccessor) => void;
}

export const useBaseWorkspaceServicesStore = create<BaseWorkspaceServicesState>()((set) => ({
  baseServices: null,
  registerBaseServices: (services) =>
    set({
      baseServices: services,
    }),
}));

export function registerBaseWorkspaceServices(services: IServiceAccessor): void {
  useBaseWorkspaceServicesStore.getState().registerBaseServices(services);
}
