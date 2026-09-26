// 按 endpoint + workspaceKey 复用的 conversation 连接注册表（引用计数 + keep-warm）
// ——分屏多 pane 跨 workspace 的连接层。
// 同一 endpoint 同一 workspace 的多个 pane 共享一条 transport + 一个 SessionDataLayer
// （同 session 多 pane 由 layer 内 per-topic refCount 单订阅收口，不触发 CLI
// (connectionId, topic) 重订阅替换）。与 sessionsIndexRegistry 同构，多两点：
// - 30s keep-warm：refCount 归零不立即 dispose（防 pane 关/开、布局调整抖动）；
// - 本地 __base__ 条目在 service 换代时重建。
import type { IZCodeAgentService } from "@zcode/services";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/** 注册表需要的 agentService 窄面（= conversation transport 的依赖面，便于测试注入）。 */
export type WorkspaceConnectionAgentService = Pick<
  IZCodeAgentService,
  | "helloConversationV4"
  | "initializeConversationV4"
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "unsubscribeConversationV4"
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onAgentRuntimeRestarted"
>;

interface WorkspaceConnectionScope {
  /** = pane 绑定的 primary workspace（连接路由键）。 */
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度：远端 shard 的 remoteSessionId；缺省 = 本机 __base__。 */
  remoteSessionId?: string;
}

/** pane 持有的连接租约；release 幂等。 */
/**
 * useSavedWorkflowLauncher 的推断返回类型包含 lease，声明生成要求保留可命名的导出。
 * @lintignore
 */
export interface WorkspaceConnectionLease {
  readonly layer: SessionDataLayer;
  readonly transport: ConversationTransport;
  release(): void;
}

interface RegistryEntry {
  key: string;
  agentService: WorkspaceConnectionAgentService;
  transport: ConversationTransport;
  layer: SessionDataLayer;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
  /** 本地 service 换代后被移出注册表的旧条目：末位 lease release 时立即 dispose。 */
  stale: boolean;
}

const registry = new Map<string, RegistryEntry>();

/** 本机 endpoint 的保留键（与 sessionsIndexRegistry / task list shardKey 口径一致）。 */
const LOCAL_WORKSPACE_CONNECTION_ENDPOINT = "__base__";

/** 引用归零后延迟释放窗口（ms）；与 SessionDataLayer keep-warm 同标度。 */
const WORKSPACE_CONNECTION_KEEP_WARM_MS = 30_000;

/** 注册表条目键 = endpoint + workspaceKey（同 workspaceKey 不同 endpoint 不共用）。 */
function buildWorkspaceConnectionKey(scope: WorkspaceConnectionScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return `${scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT} ${workspaceKey}`;
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.keepWarmTimer !== null) {
    clearTimeout(entry.keepWarmTimer);
    entry.keepWarmTimer = null;
  }
  entry.layer.dispose();
}

function releaseEntry(entry: RegistryEntry): void {
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    logger.lifecycle.info("v4 workspace connection lease released", {
      event: "v4.workspace_connection.release",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      status: "completed",
    });
    return;
  }
  if (entry.stale) {
    // 已被换代移出注册表：没有新消费者会再命中它，立即清场。
    disposeEntry(entry);
    logger.lifecycle.info("v4 stale workspace connection disposed", {
      event: "v4.workspace_connection.stale_disposed",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
    return;
  }
  // 关 pane ≠ 停 session：延迟退订，防布局抖动期间反复建连/退订。
  entry.keepWarmTimer = setTimeout(() => {
    if (registry.get(entry.key) === entry) {
      registry.delete(entry.key);
    }
    entry.layer.dispose();
    logger.lifecycle.info("v4 workspace connection keep-warm expired", {
      event: "v4.workspace_connection.keep_warm_expired",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
  }, WORKSPACE_CONNECTION_KEEP_WARM_MS);
  logger.lifecycle.info("v4 workspace connection lease released", {
    event: "v4.workspace_connection.release",
    keepWarmMs: WORKSPACE_CONNECTION_KEEP_WARM_MS,
    key: entry.key,
    module: "ui.v4.workspace_connection_registry",
    refCount: 0,
    status: "keep_warm",
  });
}

/**
 * 取/建某 endpoint+workspace 的共享 conversation 连接，refCount++。
 * agentService 由调用方（V4PaneConversationProvider 经 useWorkspaceServicesResolution）解析。
 */
export function acquireWorkspaceConnection(
  scope: WorkspaceConnectionScope,
  agentService: WorkspaceConnectionAgentService,
  createLocalMediaPreviewUrl?: (path: string) => string,
): WorkspaceConnectionLease {
  const key = buildWorkspaceConnectionKey(scope);
  const existing = registry.get(key);
  let entry: RegistryEntry;
  if (existing && existing.agentService === agentService) {
    existing.refCount += 1;
    if (existing.keepWarmTimer !== null) {
      clearTimeout(existing.keepWarmTimer);
      existing.keepWarmTimer = null;
    }
    entry = existing;
    logger.lifecycle.info("v4 workspace connection reused", {
      event: "v4.workspace_connection.reused",
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      status: "completed",
    });
  } else {
    if (existing) {
      // 本地 __base__ service 换代：旧条目失效移出；
      // 无人持有则立即清场，有人持有则由其末位 release 清场。
      registry.delete(key);
      existing.stale = true;
      if (existing.refCount <= 0) {
        disposeEntry(existing);
      }
    }
    const transport = createAgentConversationTransport(agentService, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(createLocalMediaPreviewUrl ? { createLocalMediaPreviewUrl } : {}),
    });
    entry = {
      key,
      agentService,
      transport,
      layer: new SessionDataLayer({ transport }),
      refCount: 1,
      keepWarmTimer: null,
      stale: false,
    };
    registry.set(key, entry);
    logger.lifecycle.info("v4 workspace connection created", {
      event: "v4.workspace_connection.created",
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 1,
      status: "completed",
    });
  }

  let released = false;
  return {
    layer: entry.layer,
    transport: entry.transport,
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}
