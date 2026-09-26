import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserRecordingArtifact } from "@zcode/shared";

function resolveWorkspaceRecordingPath(workspacePath: string, outputPath: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, outputPath);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || resolve(root, relation) !== target) {
    throw new Error("recording outputPath must stay inside the workspace");
  }
  if (!target.toLowerCase().endsWith(".webm")) {
    throw new Error("recording outputPath must end with .webm");
  }
  return target;
}

/**
 * main 只返回短期 WebM；Host 按当前 workspace authority 落盘，本地使用同目录 rename。
 */
export async function materializeBrowserRecordingArtifact(input: {
  artifact: BrowserRecordingArtifact;
  localPath: string;
  outputPath: string;
  workspacePath: string;
}): Promise<BrowserRecordingArtifact> {
  const targetPath = resolveWorkspaceRecordingPath(input.workspacePath, input.outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingPath = `${targetPath}.zcode-recording-${randomUUID()}.tmp`;
  try {
    await copyFile(input.localPath, stagingPath);
    // Windows 不能用 rename 原子覆盖已有文件；先移除明确的目标 WebM，再提交 staging 文件。
    await rm(targetPath, { force: true });
    await rename(stagingPath, targetPath);
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
  return { ...input.artifact, path: targetPath };
}
