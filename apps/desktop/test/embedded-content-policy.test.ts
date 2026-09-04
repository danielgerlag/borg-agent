import { describe, expect, it } from "vitest";
import {
  belongsToEmbeddedContent,
  isEmbeddedProxyUrl,
  shouldAllowEmbeddedRequest,
} from "../src/main/embedded-content-policy";

interface TestFrame {
  readonly url: string;
  parent: TestFrame | null;
  isDestroyed(): boolean;
}

function frame(url: string, parent: TestFrame | null = null): TestFrame {
  return {
    url,
    parent,
    isDestroyed: () => false,
  };
}

describe("embedded content request policy", () => {
  it("finds the proxy ancestor without looping through malformed trees", () => {
    const proxy = frame("borg-embedded://mcp-app/proxy.html?instanceId=test");
    const child = frame("about:srcdoc", proxy);
    expect(belongsToEmbeddedContent(child)).toBe(true);
    expect(isEmbeddedProxyUrl(proxy.url)).toBe(true);
    expect(
      isEmbeddedProxyUrl("borg-embedded://mcp-app/proxy.html.attacker"),
    ).toBe(false);
    expect(
      isEmbeddedProxyUrl("borg-embedded://attacker/proxy.html"),
    ).toBe(false);

    const cyclic = frame("about:blank");
    cyclic.parent = cyclic;
    expect(belongsToEmbeddedContent(cyclic)).toBe(false);
  });

  it("allows only local image and font data inside embedded content", () => {
    const proxy = frame("borg-embedded://mcp-app/proxy.html");
    const child = frame("about:srcdoc", proxy);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "image",
        url: "data:image/png;base64,AA==",
      }),
    ).toBe(true);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "font",
        url: "blob:null/font",
      }),
    ).toBe(true);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "image",
        url: "https://example.test/image.png",
      }),
    ).toBe(false);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "script",
        url: "data:text/javascript,alert(1)",
      }),
    ).toBe(false);
    expect(
      shouldAllowEmbeddedRequest({
        frame: frame("file:///renderer/index.html"),
        resourceType: "script",
        url: "file:///renderer/index.js",
      }),
    ).toBe(true);
  });
});
