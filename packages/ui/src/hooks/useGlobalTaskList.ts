// 跨 workspace 任务列表（timeline/pinned/archived/active/command center 搜索）。
// 手机远控的 window Host Controller 已随 bots 界面移除：数据源回到本地
// tasks-index（持久行 + membership，经 zcodeTaskService / membership sets）+
// sessions-index（实时 activity/detail）join，口径与 useWorkspaceTaskLists 一致。
// 远程 workspace 在本 fork 中 fail closed（resolveWorkspaceServices 返回 null），
// 携带远程身份的 tab 不参与查询，避免把远端 workspaceKey 误路由到本机 tasks-index。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodeTaskListItem,
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { fetchTaskListMembershipSetsForEndpointsCached } from "@/lib/taskListMembershipSets.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import {
  buildTaskListResult,
  mergeTaskIndexRowsWithSessions,
} from "@/v4/buildTaskListResultFromSessions.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { isRemoteWorkspaceTarget } from "@/lib/workspaceServiceResolver.js";

type MembershipSets = Awaited<ReturnType<typeof fetchTaskListMembershipSetsForEndpointsCached>>;

type GlobalTaskListItem = ZCodeTaskListItem;

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]): ZCodeTaskListWorkspaceScope[] {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const tab of workspaceTabs) {
    // 远程 workspace 无可用远端 session（fail closed），跳过，防止误读本机 tasks-index。
    if (isRemoteWorkspaceTarget(tab)) {
      continue;
    }
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const taskService = baseServices.zcodeTaskService;
  const membershipVersion = useTaskListMembershipVersion();
  const workspaceSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
      )
      .sort(
        ([leftKey, leftPath], [rightKey, rightPath]) =>
          leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
      ),
  );
  const workspaceSourceGenerationSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) =>
          [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            tab.workspacePath,
            tab.remoteSessionId?.trim() || null,
          ] as const,
      )
      .sort(
        ([leftKey, leftPath, leftSession], [rightKey, rightPath, rightSession]) =>
          leftKey.localeCompare(rightKey) ||
          leftPath.localeCompare(rightPath) ||
          (leftSession ?? "").localeCompare(rightSession ?? ""),
      ),
  );
  const workspaceScopes = useMemo(
    () => buildWorkspaceScopes(params.workspaceTabs),
    // workspaceSignature 是标准化后的 scope 值签名，避免父组件重建 tabs 数组时重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceSignature],
  );
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs
        .map((tab) => {
          const workspace = selectWorkspaceZCodeState(
            state,
            tab.workspacePath,
            tab.workspaceIdentity,
          );
          return [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            workspace.taskListVersion,
          ] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  // sessions-index 只承担实时 activity/detail；scope 集合与 tasks-index 查询保持一致。
  const sessionsIndexItems = useWorkspaceSessionsIndexItems(
    useMemo(
      () =>
        workspaceScopes.map((scope) => ({
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        })),
      [workspaceScopes],
    ),
  ).items;
  const search = params.searchQuery.trim();
  const [membership, setMembership] = useState<MembershipSets | null>(null);
  const [searchRows, setSearchRows] = useState<GlobalTaskListItem[] | null>(null);
  const [loading, setLoading] = useState(workspaceScopes.length > 0);
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const requestSerialRef = useRef(0);
  const manualRefreshSerialRef = useRef(0);
  const refreshResolveRef = useRef<(() => void) | null>(null);
  const itemsRef = useRef<GlobalTaskListItem[]>([]);

  useEffect(() => {
    if (workspaceScopes.length === 0) {
      // scopes 清空时同步清掉稳定化缓存，避免 memo 的 null 兜底继续投影上一组 workspace 的行。
      itemsRef.current = [];
      setMembership(null);
      setSearchRows(null);
      setLoading(false);
      return;
    }
    let disposed = false;
    const requestSerial = ++requestSerialRef.current;
    setLoading(true);
    // 搜索走 tasks-index 全文查询（title + searchable_text，带 snippets）；
    // 非搜索走 membership sets（持久行 + pin/archive/unread 权威），与旧 Controller
    // 投影同口径：kind 判定统一在 buildTaskListResult 的 membership 过滤里完成。
    const fetchTask: Promise<MembershipSets | { rows: GlobalTaskListItem[] }> = search
      ? taskService
          .listTaskList({
            kind: params.kind,
            workspaceScopes,
            sortBy: params.sortBy,
            search,
            limit: undefined,
          } satisfies ZCodeTaskListQuery)
          .then((result) => ({ rows: result.items as GlobalTaskListItem[] }))
      : fetchTaskListMembershipSetsForEndpointsCached({
          cacheKey: `global::${membershipVersion}::${workspaceSignature}::${taskListVersionSignature}::${workspaceSourceGenerationSignature}::m${manualRefreshSerialRef.current}`,
          endpoints: [{ service: taskService, scopes: workspaceScopes }],
        });
    void fetchTask
      .then((data) => {
        if (disposed || requestSerialRef.current !== requestSerial) {
          return;
        }
        if ("rows" in data) {
          setSearchRows(data.rows);
        } else {
          setMembership(data);
          setSearchRows(null);
        }
      })
      .catch((error) => {
        if (requestSerialRef.current === requestSerial) {
          // 查询失败时保留最后可信列表，避免单次异常清空所有 workspace 的投影。
          logger.error(`[useGlobalTaskList] 加载 ${params.kind} 列表失败`, error);
        }
      })
      .finally(() => {
        if (disposed || requestSerialRef.current !== requestSerial) {
          return;
        }
        setLoading(false);
        const resolveRefresh = refreshResolveRef.current;
        refreshResolveRef.current = null;
        resolveRefresh?.();
      });
    return () => {
      disposed = true;
    };
  }, [
    manualRefreshTick,
    membershipVersion,
    params.kind,
    params.sortBy,
    search,
    taskListVersionSignature,
    taskService,
    workspaceScopes,
    workspaceSignature,
    workspaceSourceGenerationSignature,
  ]);

  const refresh = useCallback(async () => {
    manualRefreshSerialRef.current += 1;
    await new Promise<void>((resolve) => {
      // 上一轮 refresh 尚未收口时直接完成旧等待，只让最新一轮负责 resolve。
      refreshResolveRef.current?.();
      refreshResolveRef.current = resolve;
      setManualRefreshTick((tick) => tick + 1);
    });
  }, []);

  const limit = params.expanded ? undefined : params.collapsedLimit;
  const { items, total, hasMore } = useMemo(() => {
    let result: { items: GlobalTaskListItem[]; total: number };
    if (search) {
      if (!searchRows) {
        return { items: itemsRef.current, total: itemsRef.current.length, hasMore: false };
      }
      // 搜索结果行已由 SQL 按 kind 过滤；这里只补 sessions-index activity join 并统一排序。
      const merged = mergeTaskIndexRowsWithSessions({
        taskIndexItems: searchRows,
        sessions: sessionsIndexItems,
      });
      merged.sort((left, right) => compareZCodeTaskListItems(left, right, params.sortBy));
      result = {
        items: merged,
        total: merged.length,
      };
    } else {
      if (!membership) {
        return { items: itemsRef.current, total: itemsRef.current.length, hasMore: false };
      }
      result = buildTaskListResult({
        taskIndexItems: membership.taskIndexItems,
        sessions: sessionsIndexItems,
        kind: params.kind,
        pinnedIds: membership.pinnedIds,
        archivedIds: membership.archivedIds,
        deletedIds: membership.deletedIds,
        sortBy: params.sortBy,
        limit: undefined,
        unreadAtByTaskId: membership.unreadAtByTaskId,
        terminalStatusByTaskId: membership.terminalStatusByTaskId,
        titleOverrideByTaskId: membership.titleOverrideByTaskId,
        cronAutomationIdByTaskId: membership.cronAutomationIdByTaskId,
      });
    }
    const visible = limit === undefined ? result.items : result.items.slice(0, limit);
    // sessions-index 每个 activity 帧都会重建行对象；下游（grouped 视图/虚拟器）按引用判等，
    // 这里做逐条引用稳定化，与旧 Controller 订阅链路的稳定化口径一致。
    const nextItems = stabilizeTaskListItems(itemsRef.current, visible);
    itemsRef.current = nextItems;
    return { items: nextItems, total: result.total, hasMore: result.total > visible.length };
    // sessionsIndexItems 为引用稳定化产物； membership / searchRows 为本轮请求结果。
  }, [search, searchRows, membership, sessionsIndexItems, params.kind, params.sortBy, limit]);

  return {
    items,
    total,
    hasMore,
    loading,
    refresh,
  };
}
