import { createMemoryDiagnosticsRegistry, type MemoryDiagnosticsRegistry } from "@zcode/shared";

/**
 * main 进程内存诊断计数器注册表。
 * `index.ts` 在实例化 TaskRealtimeBus / BroadcastHub / BrowserGuestManager 后注册 provider，
 * 供本地内存诊断按需 collect 写主日志（ARMS 资源遥测链路已随个人分支瘦身移除）。
 */
export const mainMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();
