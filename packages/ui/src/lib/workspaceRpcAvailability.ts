interface WorkspaceRpcAvailabilityTarget {
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
}

function isRemoteWorkspaceRpcTarget(target: WorkspaceRpcAvailabilityTarget): boolean {
  return Boolean(target.workspaceIdentity?.trim() || target.remoteSessionId?.trim());
}

export function shouldEnableWorkspaceRpc(target: WorkspaceRpcAvailabilityTarget): boolean {
  return !isRemoteWorkspaceRpcTarget(target) || Boolean(target.remoteSessionId?.trim());
}
