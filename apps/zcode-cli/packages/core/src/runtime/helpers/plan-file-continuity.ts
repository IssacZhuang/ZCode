import { homedir } from "node:os";
import { join } from "node:path";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const PLAN_FILE_REFERENCE_MAX_BYTES = PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024;

/**
 * 计划文件是会话级机器状态，存用户主目录 `~/.zcode/cli/plans/`，不写入项目工作区，
 * 避免污染项目 git（见 `.specs/plan-mode/plan-file-storage.md`）。
 * `homeDir` 只为测试注入：生产恒取 `os.homedir()`，**不**跟随 `ZCODE_STORAGE_DIR` /
 * `storage.dir` 配置——与 `~/.zcode/cli/db` 会话库、saved-workflows 全局目录的既有决策
 * 一致（会话与计划本就跨渠道共享）。
 */
function resolveApprovedPlanFilePath(input: {
  homeDir?: string;
  sessionId: SessionId | string;
}): string {
  return join(
    input.homeDir ?? homedir(),
    ".zcode",
    "cli",
    "plans",
    `plan-${sanitizePlanFileSessionId(input.sessionId)}.md`,
  );
}

export async function writeApprovedPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  homeDir?: string;
  plan: string;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
}): Promise<{ path: string }> {
  if (!input.plan.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const path = resolveApprovedPlanFilePath(input);
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: input.plan,
      createParents: true,
      encoding: "utf8",
      path,
      trace: input.traceContext,
    },
    { signal: input.abortSignal },
  );
  return { path };
}

export async function readApprovedPlanFileReferenceEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  homeDir?: string;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
}): Promise<RuntimeMessageEntry | undefined> {
  const path = resolveApprovedPlanFilePath(input);
  let content: string;
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: PLAN_FILE_REFERENCE_MAX_BYTES,
        path,
        trace: input.traceContext,
      },
      { signal: input.abortSignal },
    );
    content = read.content;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }

  if (!content.trim()) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: content, planFilePath: path }),
  );
}

function formatPlanFileReference(input: { planContent: string; planFilePath: string }): string {
  return [
    `A plan file exists from plan mode at: ${input.planFilePath}`,
    "",
    "Plan contents:",
    "",
    input.planContent,
    "",
    "If this plan is relevant to the current work and not already complete, continue working on it.",
  ].join("\n");
}

function sanitizePlanFileSessionId(sessionId: SessionId | string): string {
  const sanitized = String(sessionId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Session id cannot produce a plan file name",
      {
        recoverable: false,
      },
    );
  }
  return sanitized;
}
