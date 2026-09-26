import type { EditorInfo } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

type WorkspaceEditorSelectionKind = "preferred" | "fallback" | "empty" | "explicit";

interface WorkspaceEditorSelectionState {
  availableEditors: EditorInfo[];
  selectedEditor: EditorInfo | null;
  selectionKind: Exclude<WorkspaceEditorSelectionKind, "explicit">;
}

export function resolveWorkspaceEditorSelection({
  installedEditors,
  selectedEditorId,
}: {
  installedEditors: EditorInfo[];
  selectedEditorId: string | null;
}): WorkspaceEditorSelectionState {
  const availableEditors = sortInstalledEditorsForOpenWith(installedEditors);
  const preferredEditor =
    selectedEditorId === null
      ? null
      : (availableEditors.find((editor) => editor.id === selectedEditorId) ?? null);
  const fallbackEditor = availableEditors[0] ?? null;

  if (preferredEditor) {
    return {
      availableEditors,
      selectedEditor: preferredEditor,
      selectionKind: "preferred",
    };
  }

  return {
    availableEditors,
    selectedEditor: fallbackEditor,
    selectionKind: fallbackEditor ? "fallback" : "empty",
  };
}

export function shouldPersistWorkspaceEditorSelection(
  selectionKind: WorkspaceEditorSelectionKind,
): boolean {
  return selectionKind === "explicit";
}
