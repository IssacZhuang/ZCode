// 按 endpoint + workspaceKey 复用的 SessionsIndexStore 注册表（引用计数）——多 pane / 多列表
// 消费者并行订阅的地基：同一 endpoint 同一 workspace 的多个消费者共享一条 sessions-index 订阅
// （侧栏切数据源时，useGlobalTaskList 这类处理 workspace scope 数组、无法逐 scope 调 hook 的
// 消费者走这里）。与 SessionDataLayer 的 per-session acquire/release 同构。
// 复用键加 endpoint 维度——不同 endpoint 的 sessions-index 走各自 endpoint 的 agentService，
// 同 workspaceKey 不同 endpoint 不能共用 store。
import type { IZCodeAgentService } from "@zcode/services";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

/** 注册表需要的 agentService 窄面（= transport 的依赖面，便于测试注入）。 */
export type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
>;

interface RegistryEntry {
  key: string;
  agentService: SessionsIndexAgentService;
  store: SessionsIndexStore;
  refCount: number;
}

const registry = new Map<string, RegistryEntry>();
const entriesByStore = new WeakMap<SessionsIndexStore, RegistryEntry>();

/** 本机 endpoint 的保留键（与 task list shardKey 口径一致）。 */
export const LOCAL_SESSIONS_INDEX_ENDPOINT = "__base__";

export interface SessionsIndexScope {
  /** workspace 复用键（= services resolveWorkspaceKey 口径：workspaceIdentity ?? workspacePath）。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度：远端 shard 的 remoteSessionId；缺省 = 本机 __base__。 */
  endpointKey?: string;
}

function createSessionsIndexTransport(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
) {
  const workspaceIdentity = scope.workspaceIdentity?.trim();
  return createAgentSessionsIndexTransport(agentService, {
    workspacePath: scope.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

/** 注册表条目键 = endpoint + workspaceKey（同 workspaceKey 不同 endpoint 不共用）。 */
export function buildSessionsIndexEntryKey(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
): string {
  return `${scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT}\0${scope.workspaceKey}`;
}

/** 取/建某 endpoint+workspace 的共享 sessions-index store，refCount++（首次 acquire 发起订阅）。 */
export function acquireSessionsIndex(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): SessionsIndexStore {
  const entryKey = buildSessionsIndexEntryKey(scope);
  const existing = registry.get(entryKey);
  if (existing?.agentService === agentService) {
    existing.refCount += 1;
    return existing.store;
  }
  if (existing) {
    // 本地 __base__ 保持原生命周期：service 实例换代时创建新 store；旧 consumer
    // 后续 cleanup 仍按 store 身份精确 release，不能误减新条目的 refCount。
    registry.delete(entryKey);
    if (existing.refCount <= 0) {
      existing.store.close();
      entriesByStore.delete(existing.store);
    }
  }
  const store = new SessionsIndexStore();
  const transport = createSessionsIndexTransport(scope, agentService);
  void store.connect(transport, { forceSnapshot: true });
  const entry: RegistryEntry = {
    key: entryKey,
    agentService,
    store,
    refCount: 1,
  };
  registry.set(entryKey, entry);
  entriesByStore.set(store, entry);
  return store;
}

/** refCount--，归零则 close + 移除（退订 + 解监听）。 */
export function releaseSessionsIndex(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  store: SessionsIndexStore,
): void {
  const entryKey = buildSessionsIndexEntryKey(scope);
  const entry = entriesByStore.get(store);
  if (!entry || entry.key !== entryKey) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.store.close();
    entriesByStore.delete(entry.store);
    if (registry.get(entryKey) === entry) registry.delete(entryKey);
  }
}
