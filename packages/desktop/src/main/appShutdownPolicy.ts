interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
};

const WINDOWS_NORMAL_SHUTDOWN_POLICY: AppShutdownPolicy = {
  // 普通退出仍给 Host 内部 3.5 秒进程树兜底留出执行时间。
  forceKillDelayMs: 4_000,
  waitTimeoutMs: 4_500,
};

// 更新安装专用的 "update-install" 长预算退出档已随自动更新链路移除；
// 现在只剩普通退出一种档位，按平台区分 Windows 与其他。
export function resolveAppShutdownPolicy(platform: NodeJS.Platform): AppShutdownPolicy {
  if (platform === "win32") {
    return WINDOWS_NORMAL_SHUTDOWN_POLICY;
  }
  return STRICT_SHUTDOWN_POLICY;
}
