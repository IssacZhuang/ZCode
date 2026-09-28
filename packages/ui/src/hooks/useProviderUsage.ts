import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsageSnapshot } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";

interface ProviderUsageState {
  snapshot: ProviderUsageSnapshot | null;
  loading: boolean;
  /** RPC 通道本身的失败；业务性结果（unsupported/auth-failed 等）在 snapshot.error 内。 */
  error: string | null;
}

/**
 * 查询供应商用量/余额快照（requestVersion 守卫防止旧请求回写，仿 useAppUsageStats）。
 * auto=false 时不自动查询，由调用方在合适的时机（如面板展开）手动 refresh。
 */
export function useProviderUsage(
  providerId: string | null | undefined,
  options: { auto?: boolean } = {},
) {
  const { providerUsageService } = useServices();
  const [state, setState] = useState<ProviderUsageState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!providerId) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setState((current) => ({ snapshot: current.snapshot, loading: true, error: null }));
    try {
      const snapshot = await providerUsageService.getProviderUsage(providerId);
      if (requestVersionRef.current !== requestVersion) return;
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) return;
      logger.warn("[useProviderUsage] 查询供应商用量失败", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      setState((current) => ({
        snapshot: current.snapshot,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [providerId, providerUsageService]);

  useEffect(() => {
    if (options.auto === false) return;
    void refresh();
  }, [refresh, options.auto]);

  return { ...state, refresh };
}
