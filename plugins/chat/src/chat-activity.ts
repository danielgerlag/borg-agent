import type { ChatEntry } from "@borg/contracts";

export type ChatWaitKind = "tool_approval" | "classification" | "human_input";

export type ChatLiveActivity =
  | { readonly kind: "thinking" }
  | { readonly kind: "tool"; readonly toolId: string }
  | {
      readonly kind: "waiting";
      readonly wait: ChatWaitKind;
      readonly toolId?: string | undefined;
    };

export function isToolEntry(entry: ChatEntry): boolean {
  return entry.role === "tool";
}

export function isFailureEntry(entry: ChatEntry): boolean {
  if (entry.role !== "event") {
    return false;
  }
  const status = entry.metadata?.status;
  return (
    status === "failed" ||
    status === "failed_to_start" ||
    status === "persistence_failed"
  );
}

export function toolLabel(toolId: string): string {
  return toolId;
}

export function activityCopy(activity: ChatLiveActivity): string {
  if (activity.kind === "thinking") {
    return "Working…";
  }
  if (activity.kind === "tool") {
    return `Using ${toolLabel(activity.toolId)}…`;
  }
  if (activity.wait === "human_input") {
    return "Waiting for your answer";
  }
  if (activity.wait === "classification") {
    return "Waiting for you to review this step";
  }
  if (activity.toolId) {
    return `Waiting for you to approve ${toolLabel(activity.toolId)}`;
  }
  return "Waiting for you";
}

export function describeTurnFailure(content: string): {
  readonly title: string;
  readonly detail: string;
} {
  const lower = content.toLowerCase();
  if (lower.includes("denied")) {
    return {
      title: "The tool was not approved",
      detail: content,
    };
  }
  if (lower.includes("cancelled")) {
    return {
      title: "This turn was cancelled",
      detail: content,
    };
  }
  if (lower.includes("could not be saved")) {
    return {
      title: "The reply could not be saved",
      detail: content,
    };
  }
  if (lower.includes("interrupted")) {
    return {
      title: "The previous turn was interrupted",
      detail: content,
    };
  }
  return {
    title: "This turn failed",
    detail: content,
  };
}
