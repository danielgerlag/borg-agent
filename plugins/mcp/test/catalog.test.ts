import { personaSchema, type McpServerConfig } from "@borg/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  McpCatalogManager,
  type LiveConnection,
  type McpSession,
} from "../src/catalog";
import type { McpToolDescriptor } from "../src/ids";
import { McpProtocolError } from "../src/protocol";
import { createMcpHarness } from "./harness";

function personaWith(servers: readonly McpServerConfig[]) {
  return personaSchema.parse({
    id: "system/general",
    name: "General",
    instructions: "Be useful.",
    preferredModels: ["borg.mock-llm:mock:scripted"],
    mcpServers: [...servers],
  });
}

function stdioConfig(id: string): McpServerConfig {
  return {
    id,
    enabled: true,
    channelClass: "private",
    reconnect: true,
    reactive: false,
    transport: "stdio",
    command: "node",
    arguments: [],
    environmentSecretRefs: {},
  };
}

function session(options: {
  initialize?: (signal?: AbortSignal) => Promise<unknown>;
  tools?: readonly McpToolDescriptor[];
  close?: () => Promise<void>;
}): McpSession {
  return {
    initialize: options.initialize ?? (async () => ({})),
    listTools: async () => [...(options.tools ?? [{ name: "echo" }])],
    callTool: async () => ({ ok: true }),
    readResource: async () => [],
    close: options.close ?? (async () => undefined),
  };
}

function connection(
  config: McpServerConfig,
  client: McpSession,
  secrets: readonly string[] = [],
): LiveConnection {
  return { client, secrets, config };
}

describe("MCP catalog preparation", () => {
  it("prepares a healthy server while a hung server times out by itself", async () => {
    const persona = personaWith([stdioConfig("hung"), stdioConfig("healthy")]);
    const harness = createMcpHarness({ persona });
    const started = Date.now();
    const manager = new McpCatalogManager(harness.context, {
      prepareTimeoutMs: 80,
      openConnection: async (_context, config, signal) => {
        if (config.id === "hung") {
          await new Promise<never>((_, reject) => {
            const fail = (): void => {
              reject(new Error("hung server aborted"));
            };
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener("abort", fail, { once: true });
          });
        }
        return connection(config, session({ tools: [{ name: "echo" }] }));
      },
    });
    const catalog = await manager.prepare({
      runId: "11111111-1111-4111-8111-111111111111",
      ownerPluginId: "borg.chat",
      persona,
      personaId: persona.id,
      sessionId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(catalog.definitions.map((tool) => tool.id)).toEqual(["mcp.healthy.echo"]);
    const snapshots = manager.snapshots(persona.id);
    expect(snapshots.find((entry) => entry.id === "healthy")).toMatchObject({
      status: "ready",
      toolIds: ["mcp.healthy.echo"],
    });
    expect(snapshots.find((entry) => entry.id === "hung")).toMatchObject({
      status: "failed",
      toolIds: [],
    });
    await catalog.close?.();
    await harness.shutdown();
  });

  it("closes a locally opened transport when initialize fails and redacts secrets", async () => {
    const persona = personaWith([stdioConfig("broken")]);
    const harness = createMcpHarness({ persona });
    let closed = 0;
    const manager = new McpCatalogManager(harness.context, {
      prepareTimeoutMs: 200,
      openConnection: async (_context, config) =>
        connection(
          config,
          session({
            initialize: async () => {
              throw new Error("initialize failed secret-token");
            },
            close: async () => {
              closed += 1;
            },
          }),
          ["secret-token"],
        ),
    });
    const catalog = await manager.prepare({
      runId: "11111111-1111-4111-8111-111111111111",
      ownerPluginId: "borg.chat",
      persona,
      personaId: persona.id,
      signal: new AbortController().signal,
    });
    expect(catalog.definitions).toEqual([]);
    expect(closed).toBe(1);
    const snapshot = manager.snapshot("broken", persona.id);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
    await catalog.close?.();
    await harness.shutdown();
  });

  it("closes a connection whose discovered catalog exposes a secret", async () => {
    const config = stdioConfig("mock");
    const persona = personaWith([config]);
    const harness = createMcpHarness({ persona });
    const close = vi.fn(async () => undefined);
    const manager = new McpCatalogManager(harness.context, {
      openConnection: async () =>
        connection(
          config,
          session({
            tools: [{ name: "echo", description: "secret-token" }],
            close,
          }),
          ["secret-token"],
        ),
    });

    const catalog = await manager.prepare({
      runId: "11111111-1111-4111-8111-111111111111",
      ownerPluginId: "borg.chat",
      persona,
      personaId: persona.id,
      sessionId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });
    expect(catalog.definitions).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(manager.snapshot("mock", persona.id))).not.toContain(
      "secret-token",
    );
    await catalog.close?.();
    await harness.shutdown();
  });

  it("does not retry a stale tool after a reconnect changes the catalog", async () => {
    const config = stdioConfig("mock");
    const persona = personaWith([config]);
    const harness = createMcpHarness({ persona });
    let opens = 0;
    const manager = new McpCatalogManager(harness.context, {
      openConnection: async () => {
        opens += 1;
        if (opens === 1) {
          return connection(
            config,
            {
              ...session({
                tools: [
                  {
                    name: "echo",
                    annotations: {
                      readOnlyHint: true,
                      destructiveHint: false,
                    },
                  },
                ],
              }),
              callTool: async () => {
                throw new McpProtocolError(
                  -32603,
                  "transport failed secret-token",
                );
              },
            },
            ["secret-token"],
          );
        }
        return connection(
          config,
          session({ tools: [{ name: "replacement" }] }),
          ["secret-token"],
        );
      },
    });
    const catalog = await manager.prepare({
      runId: "11111111-1111-4111-8111-111111111111",
      ownerPluginId: "borg.chat",
      persona,
      personaId: persona.id,
      sessionId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });

    await expect(
      catalog.execute(
        "mcp.mock.echo",
        {},
        {
          toolCallId: "call-1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/unavailable after reconnect/);
    expect(opens).toBe(2);
    await catalog.close?.();
    await harness.shutdown();
  });
});
