import { useCallback, useRef } from "react";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";

interface TaskInteractionAutoResolutionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/**
 * 侧栏 task 可能来自本地或 pinned/timeline 列表；暂停命令必须按 workspace identity
 * 找到原 host，不能因为当前激活 tab 不同而发到当前窗口的 service。
 */
export function useTaskInteractionAutoResolutionSnooze(
  target: TaskInteractionAutoResolutionTarget,
) {
  const loggedInteractionIdsRef = useRef(new Set<string>());
  const targetServices = useBaseWorkspaceServices();
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = target.remoteSessionId?.trim() || undefined;
  const isRemoteTarget = Boolean(workspaceIdentity || remoteSessionId);

  return useCallback(
    async (interactionId: string): Promise<boolean> => {
      if (isRemoteTarget) {
        // 远程目标在本 fork 中没有可用 host：保留可重试失败，不回退当前窗口 service，
        // 避免相同 taskId 被投递到错误 workspace。
        logger.warn("[task-interaction] 暂停自动结束时目标 workspace 未连接", {
          interactionId,
          sessionId: target.sessionId,
          workspaceKey: workspaceIdentity ?? target.workspacePath,
        });
        return false;
      }
      const agentService = targetServices.zcodeAgentService;
      if (!agentService) {
        logger.warn("[task-interaction] 暂停自动结束时目标 workspace 未连接", {
          interactionId,
          sessionId: target.sessionId,
          workspaceKey: workspaceIdentity ?? target.workspacePath,
        });
        return false;
      }
      if (!loggedInteractionIdsRef.current.has(interactionId)) {
        loggedInteractionIdsRef.current.add(interactionId);
        logger.debug("[task-interaction] 用户从侧栏请求暂停自动结束", {
          interactionId,
          sessionId: target.sessionId,
          source: "taskBadge",
        });
      }

      return sendInteractionAutoResolutionSnooze({
        sessionId: target.sessionId,
        interactionId,
        source: "taskBadge",
        sendCommand: async (envelope) => {
          await ensureAgentV4ConnectionHandshake(agentService);
          return agentService.sendConversationCommandV4({
            workspacePath: target.workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            envelope,
          });
        },
      });
    },
    [
      isRemoteTarget,
      target.sessionId,
      target.workspacePath,
      targetServices.zcodeAgentService,
      workspaceIdentity,
    ],
  );
}
