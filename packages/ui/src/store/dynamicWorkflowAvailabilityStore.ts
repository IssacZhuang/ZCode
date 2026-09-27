import { create } from "zustand";
import {
  resolveDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";

// ============================================================
// 动态工作流灰度快照在 renderer 的唯一副本
// ============================================================
//
// 个人分支瘦身移除了订阅服务（codingPlanSubscriptionService）这条取数链路后，
// 这里只做**本地可用性**裁决：沿用 shared 的折叠规则（覆盖 > 缺省），
// 未配置本地覆盖时 fail-closed 为 disabled，不再发远端请求。
// 消费方（自动化页、run 面板）继续只读这份快照，不各自取数。

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** loading 期间恒为 false：未知即不提供，入口宁可晚半拍出现也不闪一下再收起。 */
  readonly enabled: boolean;
  /** `source` 只用于观测，区分「本地覆盖」与「缺省关闭」。 */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** 首次取数；本地裁决是同步的，这里只负责把状态落到 ready。 */
  ensureLoaded(): Promise<void>;
  /** 重新读取本地覆盖；保留接口以防后续需要手动刷新。 */
  refresh(): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

function resolveLocalDynamicWorkflowConfig(): DynamicWorkflowClientConfig {
  // renderer 与 Node 侧共用 shared 的折叠实现；没有 process 的环境只走缺省 disabled。
  return resolveDynamicWorkflowClientConfig({
    remote: undefined,
    env: typeof process !== "undefined" ? process.env : undefined,
  });
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(): Promise<void> {
      const config = resolveLocalDynamicWorkflowConfig();
      set({ status: "ready", enabled: config.enabled === true, config });
      return Promise.resolve();
    },

    refresh(): Promise<void> {
      const config = resolveLocalDynamicWorkflowConfig();
      set({ status: "ready", enabled: config.enabled === true, config });
      return Promise.resolve();
    },
  }),
);
