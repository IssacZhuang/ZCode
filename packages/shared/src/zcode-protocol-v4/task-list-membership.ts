export type TaskListMembershipKind = "pinned" | "archived" | "timeline" | "active";

/** Host 查询和各 Renderer 投影共用的 task list membership 判定。 */
export function matchesTaskListMembershipKind(
  membership: Pick<{ pinned: boolean | null; archived: boolean | null }, "pinned" | "archived">,
  kind: TaskListMembershipKind,
): boolean {
  switch (kind) {
    case "pinned":
      return Boolean(membership.pinned) && !membership.archived;
    case "archived":
      return Boolean(membership.archived);
    case "timeline":
      return !membership.pinned && !membership.archived;
    case "active":
      return !membership.archived;
  }
}
