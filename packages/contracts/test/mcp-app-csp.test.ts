import { describe, expect, it } from "vitest";
import {
  MCP_APP_CSP_QUERY_MAX_CHARS,
  buildAllowAttribute,
  buildAppCsp,
  buildPermissionsPolicy,
  buildProxyCsp,
  encodeMcpAppCspQuery,
  encodeMcpAppPermissionsQuery,
  grantFromProxyUrl,
  mcpAppRequestAllowed,
  originMatchesGrant,
  parseMcpAppNetworkGrant,
  permissionsFromProxyUrl,
} from "../src/index";

describe("mcp app csp grants", () => {
  it("keeps only https, wss, and loopback origins", () => {
    const grant = parseMcpAppNetworkGrant({
      connectDomains: [
        "https://api.example.com",
        "http://evil.example",
        "https://a:b@api.example.com",
        "http://127.0.0.1:8787",
        "*",
      ],
      resourceDomains: ["https://*.cdn.test", "javascript:alert(1)"],
      frameDomains: ["https://www.youtube.com"],
      baseUriDomains: [],
    });
    expect(grant.connect).toEqual([
      "https://api.example.com",
      "http://127.0.0.1:8787",
    ]);
    expect(grant.resource).toEqual(["https://*.cdn.test"]);
    expect(grant.frame).toEqual(["https://www.youtube.com"]);
    expect(
      parseMcpAppNetworkGrant({
        connectDomains: [
          "http://[::1]:8787",
          "ws://localhost:8080",
          "http://example.com",
          "https://evil.test;connect-src https://evil.test",
        ],
        resourceDomains: ["http://*.cdn.test"],
        frameDomains: [],
        baseUriDomains: [],
      }).connect,
    ).toEqual(["http://[::1]:8787", "ws://localhost:8080"]);
  });

  it("keeps frame-src self on the proxy while adding declared script hosts", () => {
    expect(buildProxyCsp()).toContain("frame-src 'self'");
    expect(buildProxyCsp()).toContain("connect-src 'none'");
    expect(
      buildProxyCsp(
        parseMcpAppNetworkGrant({
          connectDomains: [],
          resourceDomains: ["https://cesium.com"],
          frameDomains: [],
          baseUriDomains: [],
        }),
      ),
    ).toContain("script-src 'unsafe-inline' https://cesium.com");
  });

  it("builds connect-src from declared domains and none when empty", () => {
    expect(
      buildAppCsp(
        parseMcpAppNetworkGrant({
          connectDomains: ["https://api.example.com"],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        }),
      ),
    ).toContain("connect-src https://api.example.com");
    expect(
      buildAppCsp(
        parseMcpAppNetworkGrant({
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        }),
      ),
    ).toContain("connect-src 'none'");
  });

  it("matches wildcard resource hosts without suffix spoofing", () => {
    const allowed = ["https://*.cdn.test"];
    expect(originMatchesGrant("https://a.cdn.test/img.png", allowed)).toBe(true);
    expect(originMatchesGrant("https://cdn.test/img.png", allowed)).toBe(false);
    expect(originMatchesGrant("https://cdn.test.evil/img.png", allowed)).toBe(
      false,
    );
  });

  it("round-trips a grant through the proxy query string", () => {
    const encoded = encodeMcpAppCspQuery({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(encoded).toBeDefined();
    const grant = grantFromProxyUrl(
      `borg-embedded://mcp-app/proxy.html?csp=${encoded}`,
    );
    expect(grant.connect).toEqual(["https://api.example.com"]);
    expect(
      mcpAppRequestAllowed(
        "https://api.example.com/v1",
        "xhr",
        grant,
      ),
    ).toBe(true);
    expect(
      mcpAppRequestAllowed(
        "https://cdn.example.com/app.js",
        "script",
        grant,
      ),
    ).toBe(true);
    expect(
      mcpAppRequestAllowed("https://evil.test/", "xhr", grant),
    ).toBe(false);
    expect(
      mcpAppRequestAllowed(
        "https://api.example.com/v1",
        "fetch",
        grant,
      ),
    ).toBe(false);
    const loopback = parseMcpAppNetworkGrant({
      connectDomains: ["http://127.0.0.1:8787", "wss://api.example.com"],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(
      mcpAppRequestAllowed("http://127.0.0.1:8787/v1", "xhr", loopback),
    ).toBe(true);
    expect(
      mcpAppRequestAllowed(
        "wss://api.example.com/socket",
        "webSocket",
        loopback,
      ),
    ).toBe(true);
    expect(
      mcpAppRequestAllowed(
        "wss://api.example.com/socket",
        "websocket",
        loopback,
      ),
    ).toBe(false);
  });

  it("omits oversized proxy grants and ignores overlong query values", () => {
    const encoded = encodeMcpAppCspQuery({
      connectDomains: Array.from(
        { length: 256 },
        (_, index) => `https://api${index}.example.com`,
      ),
      resourceDomains: Array.from(
        { length: 256 },
        (_, index) => `https://cdn${index}.example.com`,
      ),
      frameDomains: Array.from(
        { length: 256 },
        (_, index) => `https://frame${index}.example.com`,
      ),
      baseUriDomains: Array.from(
        { length: 256 },
        (_, index) => `https://base${index}.example.com`,
      ),
    });
    expect(encoded).toBeUndefined();
    expect(
      grantFromProxyUrl(
        `borg-embedded://mcp-app/proxy.html?csp=${"a".repeat(MCP_APP_CSP_QUERY_MAX_CHARS + 1)}`,
      ),
    ).toEqual({
      connect: [],
      resource: [],
      frame: [],
      base: [],
    });
  });

  it("builds an iframe allow list only for requested permissions", () => {
    expect(
      buildAllowAttribute({
        camera: false,
        microphone: false,
        geolocation: false,
        clipboardWrite: false,
      }),
    ).toBeUndefined();
    expect(
      buildAllowAttribute({
        camera: true,
        microphone: false,
        geolocation: false,
        clipboardWrite: true,
      }),
    ).toBe("camera; clipboard-write");
    expect(
      encodeMcpAppPermissionsQuery({
        camera: true,
        microphone: false,
        geolocation: false,
        clipboardWrite: true,
      }),
    ).toBe("camera,clipboard-write");
    expect(
      permissionsFromProxyUrl(
        "borg-embedded://mcp-app/proxy.html?perm=camera,clipboard-write,usb",
      ),
    ).toEqual({
      camera: true,
      microphone: false,
      geolocation: false,
      clipboardWrite: true,
    });
    expect(
      buildPermissionsPolicy({
        camera: true,
        microphone: false,
        geolocation: false,
        clipboardWrite: false,
      }),
    ).toContain("camera=*");
    expect(
      buildPermissionsPolicy({
        camera: true,
        microphone: false,
        geolocation: false,
        clipboardWrite: false,
      }),
    ).toContain("microphone=()");
  });
});
