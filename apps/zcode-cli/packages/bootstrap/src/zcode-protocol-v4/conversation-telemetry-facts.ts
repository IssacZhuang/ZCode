import type {
  ModelNetworkStatusPayload,
  SessionEvent,
  ToolCallScheduledPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnStartedPayload,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";

// ============================================================
// 本地会话事实归一（LocalTtft 专用）
// ============================================================
// 该文件曾为远端 ConversationTelemetryFact（`v4/telemetry/event`）准备全量事实并经
// @zcode/shared 的 zod schema 严格校验；本地个人版删除远端上报后，仅保留
// LocalTtftRecorder（local-ttft.ts）实际消费的最小事实集：
// turn.started / model.request.status / tool.lifecycle(scheduled) / turn.terminal。
// 类型改为 CLI 本地判别联合，不再依赖共享包的 telemetry schema。

const MAX_TRACKED_LIFECYCLE_KEYS = 2_000;

class BoundedValueMap<T> {
  private readonly values = new Map<string, T>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > MAX_TRACKED_LIFECYCLE_KEYS) {
      const oldest = this.values.keys().next().value;
      if (typeof oldest === "string") this.values.delete(oldest);
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function terminalStatus(resultType: string): "success" | "interrupted" | "failed" {
  if (resultType === "success") return "success";
  if (resultType === "cancelled") return "interrupted";
  return "failed";
}

type ModelRequestStatusFactStatus =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";

const MODEL_REQUEST_STATUSES: ReadonlySet<string> = new Set<ModelRequestStatusFactStatus>([
  "model_request_started",
  "model_request_completed",
  "model_request_failed",
  "model_retry_scheduled",
  "model_stream_stalled",
]);

function isModelRequestStatus(value: string): value is ModelRequestStatusFactStatus {
  return MODEL_REQUEST_STATUSES.has(value);
}

interface ConversationTelemetryFactBase {
  sessionId: string;
  sourceCommandId?: string;
  turnId?: string;
}

interface TurnStartedTelemetryFact extends ConversationTelemetryFactBase {
  kind: "turn.started";
}

interface ModelRequestStatusTelemetryFact extends ConversationTelemetryFactBase {
  kind: "model.request.status";
  modelId: string;
  providerId: string;
  queryId?: string;
  querySource?: string;
  requestId: string;
  status: ModelRequestStatusFactStatus;
}

interface ToolLifecycleTelemetryFact extends ConversationTelemetryFactBase {
  kind: "tool.lifecycle";
  parentToolCallId?: string;
  phase: "scheduled";
  toolCallId: string;
  toolName?: string;
}

interface TurnTerminalTelemetryFact extends ConversationTelemetryFactBase {
  kind: "turn.terminal";
  status: "success" | "interrupted" | "failed";
}

export type ConversationTelemetryFact =
  | TurnStartedTelemetryFact
  | ModelRequestStatusTelemetryFact
  | ToolLifecycleTelemetryFact
  | TurnTerminalTelemetryFact;

export function streamingParentToolCallId(payload: Record<string, unknown>): string | undefined {
  const meta = recordValue(payload._meta);
  const zcode = recordValue(meta.zcode);
  return (
    optionalString(payload.parentToolCallId) ??
    optionalString(payload.parentToolUseId) ??
    optionalString(meta.parentToolCallId) ??
    optionalString(meta.parentToolUseId) ??
    optionalString(zcode.parentToolCallId) ??
    optionalString(zcode.parentToolUseId)
  );
}

/** subagent mirror 事件把父子关联放在 payload 顶层；本地事实只关心 parentToolCallId。 */
function mirroredParentToolCallId(payload: Record<string, unknown>): string | undefined {
  return (
    optionalString(payload.parentToolCallId) ?? optionalString(payload.parentToolUseId) ?? undefined
  );
}

/**
 * 把本进程 live SessionEvent 中的轮次起止归一成 LocalTtftRecorder 可消费的本地事实。
 * 不读取 transcript/snapshot，不携带正文；仅维护 turn → admission inputId 的有界映射，
 * 供后续同轮事实把模型请求/工具调度挂回发起它的输入。
 */
export class ConversationTelemetryFactNormalizer {
  private readonly sourceCommandByTurn = new BoundedValueMap<string>();

  normalize(sessionId: string, event: SessionEvent): ConversationTelemetryFact | null {
    const turnId = event.turnId ? String(event.turnId) : undefined;
    const turnKey = turnId ? `${sessionId}\0${turnId}` : undefined;
    const sourceCommandId = turnKey ? this.sourceCommandByTurn.get(turnKey) : undefined;
    const base = {
      sessionId,
      ...(sourceCommandId ? { sourceCommandId } : {}),
      ...(turnId ? { turnId } : {}),
    };

    switch (event.type) {
      case SessionEventType.TurnStarted: {
        const payload = event.payload as TurnStartedPayload;
        // 用户轮与 background wake 均由 admission 提供 inputId，不混用持久化 messageId。
        const inputId = optionalString(payload.inputId);
        if (turnKey && inputId) this.sourceCommandByTurn.set(turnKey, inputId);
        return {
          ...base,
          kind: "turn.started",
          ...(inputId ? { sourceCommandId: inputId } : {}),
        };
      }
      case SessionEventType.ModelNetworkStatus: {
        const payload = event.payload as ModelNetworkStatusPayload;
        // 只归一 provider 请求生命周期状态；准入等待与流内首事件（model_first_*）
        // 不属于本地事实，返回 null 让 LocalTtftRecorder 自行忽略。
        if (!isModelRequestStatus(payload.type)) return null;
        const querySource = optionalString(payload.querySource);
        const queryId = optionalString(payload.queryId);
        return {
          ...base,
          kind: "model.request.status",
          modelId: String(payload.modelId),
          providerId: String(payload.providerId),
          ...(queryId ? { queryId } : {}),
          ...(querySource ? { querySource } : {}),
          requestId: String(payload.requestId),
          status: payload.type,
        };
      }
      case SessionEventType.ToolCallScheduled: {
        const payload = event.payload as ToolCallScheduledPayload;
        const rawPayload = recordValue(event.payload);
        const toolCallId = String(payload.toolCallId);
        const toolName = optionalString(payload.toolName);
        const parentToolCallId = mirroredParentToolCallId(rawPayload);
        return {
          ...base,
          kind: "tool.lifecycle",
          ...(parentToolCallId ? { parentToolCallId } : {}),
          phase: "scheduled" as const,
          toolCallId,
          ...(toolName ? { toolName } : {}),
        };
      }
      case SessionEventType.TurnComplete: {
        const payload = event.payload as TurnCompletePayload;
        const inputId = optionalString(payload.inputId);
        this.clearTurn(turnKey);
        return {
          ...base,
          kind: "turn.terminal",
          ...(inputId ? { sourceCommandId: inputId } : {}),
          status: terminalStatus(payload.resultType),
        };
      }
      case SessionEventType.TurnError: {
        const payload = event.payload as TurnErrorPayload;
        const inputId = optionalString(payload.inputId);
        this.clearTurn(turnKey);
        return {
          ...base,
          kind: "turn.terminal",
          ...(inputId ? { sourceCommandId: inputId } : {}),
          status: "failed",
        };
      }
      default:
        return null;
    }
  }

  private clearTurn(turnKey: string | undefined): void {
    if (!turnKey) return;
    this.sourceCommandByTurn.delete(turnKey);
  }
}
