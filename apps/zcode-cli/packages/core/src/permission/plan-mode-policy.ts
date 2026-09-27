import { EXIT_PLAN_MODE_TOOL_NAME, type CollaborationMode } from "@zcode/contracts";

interface PlanModeTransitionContext {
  toolName: string;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
}

interface PlanModeTransitionPermission {
  behavior: "allow" | "deny";
  reason: string;
  ruleId: string;
}

export function resolvePlanModeTransitionPermission(
  context: PlanModeTransitionContext,
): PlanModeTransitionPermission | undefined {
  if (
    context.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
    !(context.planEnabled ?? context.mode === "plan")
  ) {
    return {
      behavior: "deny",
      reason: "ExitPlanMode can only be used while plan mode is active",
      ruleId: "mode.plan.exitOnly",
    };
  }

  return undefined;
}
