import { describe, expect, it } from "vitest";
import {
  argumentsToText,
  catalogLabel,
  changeDraftTransport,
  emptyStdioDraft,
  parseDraftsForSave,
  replaceDraft,
  textToArguments,
} from "../src/settings-draft";

describe("MCP settings drafts", () => {
  it("keeps loose keystroke state and validates only on save", () => {
    let drafts = [emptyStdioDraft("mock")];
    drafts = replaceDraft(drafts, 0, {
      ...drafts[0]!,
      id: "",
      command: "",
      url: "not-a-url",
      arguments: textToArguments("/tmp/My App/server.js\n--port=9"),
    });
    expect(drafts[0]).toMatchObject({
      id: "",
      command: "",
      url: "not-a-url",
      arguments: ["/tmp/My App/server.js", "--port=9"],
    });
    expect(argumentsToText(drafts[0]?.arguments)).toBe(
      "/tmp/My App/server.js\n--port=9",
    );
    expect(() => parseDraftsForSave(drafts)).toThrow();
    expect(drafts[0]?.id).toBe("");

    drafts = replaceDraft(drafts, 0, {
      ...emptyStdioDraft("saved"),
      ...(drafts[0]?.arguments
        ? { arguments: drafts[0].arguments }
        : {}),
    });
    expect(parseDraftsForSave(drafts)[0]).toMatchObject({
      id: "saved",
      transport: "stdio",
      arguments: ["/tmp/My App/server.js", "--port=9"],
    });
    expect(catalogLabel(["mcp.mock.echo", "mcp.mock.show-form"])).toBe(
      "mcp.mock.echo, mcp.mock.show-form",
    );
  });

  it("removes transport-specific fields when switching transports", () => {
    const http = changeDraftTransport(
      {
        ...emptyStdioDraft("mock"),
        arguments: ["server.mjs"],
        environmentSecretRefs: { TOKEN: "token-ref" },
      },
      "streamable-http",
    );
    expect(http).toEqual({
      id: "mock",
      enabled: true,
      reconnect: true,
      transport: "streamable-http",
      url: "http://127.0.0.1:0/mcp",
      headerSecretRefs: {},
    });
    expect(parseDraftsForSave([http])).toHaveLength(1);

    const stdio = changeDraftTransport(
      {
        ...http,
        url: "https://example.test/mcp",
        headerSecretRefs: { Authorization: "auth-ref" },
      },
      "stdio",
    );
    expect(stdio).toEqual({
      id: "mock",
      enabled: true,
      reconnect: true,
      transport: "stdio",
      command: "node",
      arguments: [],
      environmentSecretRefs: {},
    });
    expect(parseDraftsForSave([stdio])).toHaveLength(1);

    expect(() =>
      parseDraftsForSave([
        {
          ...emptyStdioDraft("invalid"),
          environmentSecretRefsText: "TOKEN",
        },
      ]),
    ).toThrow(/NAME=reference/);
  });
});
