import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allocatePersonaServerSlugs,
  canonicalizeTools,
  slugifySegment,
  stableSegment,
} from "../src/ids";
import {
  createAppInstanceId,
  isHtml5Document,
  validateAppResource,
} from "../src/apps";
import { MCP_APP_HTML_MIME } from "../src/protocol";

const HTML5 = `<!DOCTYPE html><html><head><title>ok</title></head><body><p>ok</p></body></html>`;

function digestSuffix(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

describe("MCP tool canonicalization", () => {
  it("maps underscores and uppercase onto hyphenated slugs", () => {
    expect(slugifySegment("Demo_Server", "server")).toBe("demo-server");
    expect(slugifySegment("Foo Bar", "server")).toBe("foo-bar");
    const serverSlug = `demo-server-${digestSuffix("Demo_Server")}`;
    const tools = canonicalizeTools("Demo_Server", [
      {
        name: "Echo_Tool",
        description: "echo",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "echo",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      {
        name: "hidden",
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "show-form",
        _meta: { ui: { resourceUri: "ui://mock/form", visibility: ["model", "app"] } },
      },
    ]);
    expect(tools.map((tool) => tool.id)).toEqual([
      `mcp.${serverSlug}.echo-tool-${digestSuffix("Echo_Tool")}`,
      `mcp.${serverSlug}.echo`,
      `mcp.${serverSlug}.hidden`,
      `mcp.${serverSlug}.show-form`,
    ]);
    expect(tools[0]).toMatchObject({
      mcpName: "Echo_Tool",
      approval: "auto",
      sideEffect: false,
      modelVisible: true,
    });
    expect(tools[1]).toMatchObject({
      mcpName: "echo",
      approval: "ask",
      sideEffect: true,
    });
    expect(tools[2]?.modelVisible).toBe(false);
    expect(tools[3]?.resourceUri).toBe("ui://mock/form");
  });

  it("keeps already canonical segments including mock and echo", () => {
    expect(stableSegment("mock", "server")).toBe("mock");
    expect(stableSegment("echo", "tool")).toBe("echo");
    expect(canonicalizeTools("mock", [{ name: "echo" }]).map((tool) => tool.id)).toEqual([
      "mcp.mock.echo",
    ]);
  });

  it("is stable when neighbors are reordered or removed", () => {
    const first = allocatePersonaServerSlugs(["Foo Bar", "foo-bar", "Demo_Server"]);
    const reordered = allocatePersonaServerSlugs([
      "Demo_Server",
      "foo-bar",
      "Foo Bar",
    ]);
    const removed = allocatePersonaServerSlugs(["foo-bar", "Foo Bar"]);
    expect(reordered.get("Foo Bar")).toBe(first.get("Foo Bar"));
    expect(reordered.get("foo-bar")).toBe(first.get("foo-bar"));
    expect(reordered.get("Demo_Server")).toBe(first.get("Demo_Server"));
    expect(removed.get("Foo Bar")).toBe(first.get("Foo Bar"));
    expect(removed.get("foo-bar")).toBe(first.get("foo-bar"));

    const listed = canonicalizeTools("mock", [
      { name: "Echo_Tool" },
      { name: "echo" },
      { name: "hidden" },
    ]);
    const shuffled = canonicalizeTools("mock", [
      { name: "hidden" },
      { name: "Echo_Tool" },
    ]);
    expect(shuffled.find((tool) => tool.mcpName === "Echo_Tool")?.id).toBe(
      listed.find((tool) => tool.mcpName === "Echo_Tool")?.id,
    );
  });

  it("keeps a canonical segment distinct from a noncanonical value that normalizes to it", () => {
    const slugs = allocatePersonaServerSlugs(["foo-bar", "Foo Bar"]);
    expect(slugs.get("foo-bar")).toBe("foo-bar");
    expect(slugs.get("Foo Bar")).toBe(`foo-bar-${digestSuffix("Foo Bar")}`);
    const first = canonicalizeTools("foo-bar", [{ name: "echo" }], slugs.get("foo-bar"));
    const second = canonicalizeTools("Foo Bar", [{ name: "echo" }], slugs.get("Foo Bar"));
    expect(first.map((tool) => tool.id)).toEqual(["mcp.foo-bar.echo"]);
    expect(second.map((tool) => tool.id)).toEqual([
      `mcp.foo-bar-${digestSuffix("Foo Bar")}.echo`,
    ]);
  });

  it("keeps two noncanonical names distinct when they normalize to the same slug", () => {
    expect(slugifySegment("Foo Bar", "tool")).toBe("foo-bar");
    expect(slugifySegment("foo_bar", "tool")).toBe("foo-bar");
    expect(stableSegment("Foo Bar", "tool")).toBe(
      `foo-bar-${digestSuffix("Foo Bar")}`,
    );
    expect(stableSegment("foo_bar", "tool")).toBe(
      `foo-bar-${digestSuffix("foo_bar")}`,
    );
    expect(stableSegment("Foo Bar", "tool")).not.toBe(
      stableSegment("foo_bar", "tool"),
    );
    const tools = canonicalizeTools("mock", [
      { name: "Foo Bar" },
      { name: "foo_bar" },
    ]);
    expect(tools.map((tool) => tool.id)).toEqual([
      `mcp.mock.foo-bar-${digestSuffix("Foo Bar")}`,
      `mcp.mock.foo-bar-${digestSuffix("foo_bar")}`,
    ]);
  });

  it("keeps the original protocol tool name for execution", () => {
    const tools = canonicalizeTools("Demo_Server", [
      { name: "Echo_Tool" },
      { name: "echo" },
    ]);
    expect(tools[0]?.mcpName).toBe("Echo_Tool");
    expect(tools[1]?.mcpName).toBe("echo");
    expect(tools[0]?.serverId).toBe("Demo_Server");
  });

  it("rejects duplicate protocol tool names", () => {
    expect(() =>
      canonicalizeTools("mock", [{ name: "echo" }, { name: "echo" }]),
    ).toThrow(/duplicated/);
  });
});

describe("MCP app resource validation", () => {
  it("requires the document root immediately after the doctype", () => {
    expect(isHtml5Document('<!DOCTYPE html><!-- <html> -->')).toBe(false);
    expect(
      isHtml5Document(
        '<!DOCTYPE html><html lang="en"><head></head><body></body></html>',
      ),
    ).toBe(true);
  });

  it("requires a ui:// HTML5 document, exclusive payload, and official permission objects", () => {
    expect(() =>
      validateAppResource("https://example.test/form", []),
    ).toThrow(/invalid/);
    expect(() =>
      validateAppResource("ui://mock/form", [
        { uri: "ui://other", mimeType: MCP_APP_HTML_MIME, text: HTML5 },
      ]),
    ).toThrow(/exactly one/);
    expect(() =>
      validateAppResource("ui://mock/form", [
        { uri: "ui://mock/form", mimeType: MCP_APP_HTML_MIME, text: "<p>ok</p>" },
      ]),
    ).toThrow(/HTML5/);
    expect(() =>
      validateAppResource("ui://mock/form", [
        {
          uri: "ui://mock/form",
          mimeType: MCP_APP_HTML_MIME,
          text: HTML5,
          blob: Buffer.from(HTML5).toString("base64"),
        },
      ]),
    ).toThrow(/exactly one of text or blob/);

    const validated = validateAppResource("ui://mock/form", [
      {
        uri: "ui://mock/form",
        mimeType: "text/html; profile=mcp-app",
        text: HTML5,
        _meta: {
          ui: {
            csp: { connectDomains: ["https://example.test"] },
            permissions: { camera: {}, microphone: true, geolocation: { extra: 1 } },
          },
        },
      },
    ]);
    expect(validated.html).toBe(HTML5);
    expect(validated.csp.connectDomains).toEqual(["https://example.test"]);
    expect(validated.permissions).toEqual({
      camera: true,
      microphone: false,
      geolocation: false,
      clipboardWrite: false,
    });

    const blob = Buffer.from(HTML5, "utf8").toString("base64");
    expect(
      validateAppResource("ui://mock/form", [
        { uri: "ui://mock/form", mimeType: MCP_APP_HTML_MIME, blob },
      ]).html,
    ).toBe(HTML5);
    expect(() =>
      validateAppResource("ui://mock/form", [
        { uri: "ui://mock/form", mimeType: MCP_APP_HTML_MIME, blob: blob.slice(0, -1) },
      ]),
    ).toThrow(/canonical base64/);
    expect(() =>
      validateAppResource("ui://mock/form", [
        {
          uri: "ui://mock/form",
          mimeType: MCP_APP_HTML_MIME,
          blob: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
        },
      ]),
    ).toThrow();
    expect(() =>
      validateAppResource("ui://mock/form", [
        {
          uri: "ui://mock/form",
          mimeType: MCP_APP_HTML_MIME,
          text: "x".repeat(2 * 1024 * 1024 + 1),
        },
      ]),
    ).toThrow(/size cap/);
  });

  it("derives a deterministic UUID-shaped app instance id", () => {
    const first = createAppInstanceId({
      sessionId: "11111111-1111-4111-8111-111111111111",
      serverId: "mock",
      resourceUri: "ui://mock/form",
      toolCallId: "form-1",
    });
    const same = createAppInstanceId({
      sessionId: "11111111-1111-4111-8111-111111111111",
      serverId: "mock",
      resourceUri: "ui://mock/form",
      toolCallId: "form-1",
    });
    const other = createAppInstanceId({
      sessionId: "11111111-1111-4111-8111-111111111111",
      serverId: "mock",
      resourceUri: "ui://mock/form",
      toolCallId: "form-2",
    });
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).toBe(same);
    expect(other).not.toBe(first);
  });
});
