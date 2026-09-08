import {
  buildAppCsp,
  grantFromProxyUrl,
  mcpAppRequestAllowed,
} from "@borg/contracts";

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
  return findEmbeddedProxyUrl(frame) !== undefined;
}

export function findEmbeddedProxyUrl(
  frame: FrameNode | null | undefined,
): string | undefined {
  const visited = new Set<FrameNode>();
  let current = frame;
  while (current && !current.isDestroyed() && !visited.has(current)) {
    if (isEmbeddedProxyUrl(current.url)) {
      return current.url;
    }
    visited.add(current);
    current = current.parent;
  }
  return undefined;
}

export function embeddedAppCsp(proxyUrl: string): string {
  return buildAppCsp(grantFromProxyUrl(proxyUrl));
}

export function shouldAllowEmbeddedRequest(
  request: EmbeddedRequest,
): boolean {
  const proxyUrl = findEmbeddedProxyUrl(request.frame);
  if (proxyUrl === undefined) {
    return true;
  }
  if (
    (request.resourceType === "image" || request.resourceType === "font") &&
    (request.url.startsWith("data:") || request.url.startsWith("blob:"))
  ) {
    return true;
  }
  return mcpAppRequestAllowed(
    request.url,
    request.resourceType,
    grantFromProxyUrl(proxyUrl),
  );
}
