import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { shell } from "electron";
import type { OpenInEditorOptions } from "@zcode/shared";
import { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } from "./editors.js";
import { logger } from "./logger.js";

type PathKind = "file" | "directory" | "unknown";

interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const execFileAsync = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

async function openPathViaShell(path: string): Promise<OpenInEditorResult> {
  const error = await shell.openPath(path);
  return error ? { success: false, error } : { success: true };
}

function detectPathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
  } catch {
    // 路径不存在时保留 unknown，交给后续 fallback 处理。
  }
  return "unknown";
}

async function openWindowsEditor(
  editorId: string,
  appPath: string,
  args: string[],
  cliError?: unknown,
): Promise<OpenInEditorResult> {
  try {
    await execFileAsync(appPath, args);
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 Windows 编辑器失败", {
      editorId,
      args,
      appPath,
      error: stringifyError(error),
      cliError: cliError === undefined ? undefined : stringifyError(cliError),
    });
    return { success: false, error: stringifyError(error) };
  }
}

/**
 * 用指定编辑器打开路径。
 */
export async function openInEditor(
  editorId: string,
  path: string,
  options?: OpenInEditorOptions,
): Promise<OpenInEditorResult> {
  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) {
    return { success: false, error: `unknown editor: ${editorId}` };
  }

  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;
  const pathKind = detectPathKind(path);

  if (editorId === "finder") {
    if (pathKind === "file") {
      shell.showItemInFolder(path);
      return { success: true };
    }
    return openPathViaShell(path);
  }

  if (editorId === "explorer") {
    if (pathKind !== "file") {
      return openPathViaShell(path);
    }

    // Explorer 已委托打开请求后仍可能非零退出，按退出码回退会重复打开窗口。
    // 本地文件直接使用系统定位 API，只发出一次打开所在目录并选中文件的请求。
    shell.showItemInFolder(path);
    return { success: true };
  }

  if (def.command) {
    try {
      await execFileAsync(def.command, [path]);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, [path], error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, path]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开编辑器失败", {
          editorId,
          path,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, [path]);
    } else {
      await execFileAsync("open", ["-a", appPath, path]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开编辑器失败", {
      editorId,
      path,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}
