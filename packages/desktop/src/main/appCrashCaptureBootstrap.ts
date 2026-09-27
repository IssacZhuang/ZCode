import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// 远端 crash 上报（ARMS）已随个人分支瘦身移除，始终启动仅本地的 crashReporter
// （uploadToServer:false），dump 只进本地 crash archive 供 ExportLogs 取证。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger);
