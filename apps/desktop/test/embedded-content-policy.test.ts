import { describe, expect, it } from "vitest";
import { encodeMcpAppCspQuery } from "@borg/contracts";
import {
  belongsToEmbeddedContent,
  embeddedAppCsp,
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

  it("allows declared CSP origins and still denies undeclared ones", () => {
    const encoded = encodeMcpAppCspQuery({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://*.cdn.test"],
      frameDomains: ["https://www.youtube.com"],
      baseUriDomains: [],
    });
    const proxy = frame(
      `borg-embedded://mcp-app/proxy.html?csp=${encoded}`,
    );
    const child = frame("about:srcdoc", proxy);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "xhr",
        url: "https://api.example.com/v1",
      }),
    ).toBe(true);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "webSocket",
        url: "https://api.example.com/v1",
      }),
    ).toBe(true);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "image",
        url: "https://a.cdn.test/img.png",
      }),
    ).toBe(true);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "subFrame",
        url: "https://www.youtube.com/embed/x",
      }),
    ).toBe(true);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "xhr",
        url: "https://evil.test/",
      }),
    ).toBe(false);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "image",
        url: "https://cdn.test.evil/img.png",
      }),
    ).toBe(false);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "fetch",
        url: "https://api.example.com/v1",
      }),
    ).toBe(false);
  });

  it("stamps the inner iframe CSP from the proxy grant before srcdoc", () => {
    const encoded = encodeMcpAppCspQuery({
      connectDomains: ["https://cesium.com", "https://*.cesium.com"],
      resourceDomains: ["https://cesium.com", "https://*.cesium.com"],
      frameDomains: [],
      baseUriDomains: [],
    });
    const csp = embeddedAppCsp(
      `borg-embedded://mcp-app/proxy.html?csp=${encoded}`,
    );
    expect(csp).toContain("script-src 'unsafe-inline' https://cesium.com");
    expect(csp).toContain("https://*.cesium.com");
    expect(embeddedAppCsp("borg-embedded://mcp-app/proxy.html")).toContain(
      "connect-src 'none'",
    );
  });

  it("still denies undeclared loopback images", () => {
    const proxy = frame("borg-embedded://mcp-app/proxy.html");
    const child = frame("about:srcdoc", proxy);
    expect(
      shouldAllowEmbeddedRequest({
        frame: child,
        resourceType: "image",
        url: "http://127.0.0.1:9/escape",
      }),
    ).toBe(false);
  });
});
