export const EMBEDDED_CONTENT_SCHEME = "borg-embedded";

interface FrameNode {
  readonly url: string;
  readonly parent: FrameNode | null;
  isDestroyed(): boolean;
}

export interface EmbeddedRequest {
  readonly frame?: FrameNode | null;
  readonly resourceType: string;
  readonly url: string;
}

export function isEmbeddedProxyUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === `${EMBEDDED_CONTENT_SCHEME}:` &&
      url.hostname === "mcp-app" &&
      url.pathname === "/proxy.html"
    );
  } catch {
    return false;
  }
}

export function belongsToEmbeddedContent(
  frame: FrameNode | null | undefined,
): boolean {
  const visited = new Set<FrameNode>();
  let current = frame;
  while (current && !current.isDestroyed() && !visited.has(current)) {
    if (isEmbeddedProxyUrl(current.url)) {
      return true;
    }
    visited.add(current);
    current = current.parent;
  }
  return false;
}

export function shouldAllowEmbeddedRequest(
  request: EmbeddedRequest,
): boolean {
  if (!belongsToEmbeddedContent(request.frame)) {
    return true;
  }
  return (
    (request.resourceType === "image" || request.resourceType === "font") &&
    (request.url.startsWith("data:") || request.url.startsWith("blob:"))
  );
}
