import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { removeTaskFromTaskQueryCaches } from "@/store/taskQueryCacheStore.js";

// 手机远控（bots）任务广播的增量缓存写入（syncTaskMetaToTaskCaches /
// insertTaskIntoTaskCaches）已随 useBotBroadcastEffects 移除；本文件只保留
// 归档删除链路仍在使用的整行移除。
export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}
