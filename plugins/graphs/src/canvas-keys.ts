export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.isContentEditable;
}

export function canvasEdgeToDelete(input: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly typing: boolean;
  readonly selectedEdgeId: string | undefined;
}): string | undefined {
  if (input.typing || input.metaKey || input.ctrlKey || input.altKey) {
    return undefined;
  }
  if (input.key !== "Backspace" && input.key !== "Delete") {
    return undefined;
  }
  return input.selectedEdgeId;
}
