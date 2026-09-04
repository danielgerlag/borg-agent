import {
  mcpAppDiscovered,
  mcpGetStatus,
  mcpListServers,
  mcpRefresh,
  personaSchema,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import mcpPlugin from "../src/main";
import { createMcpHarness } from "./harness";

const fixture = path.resolve(
  fileURLToPath(new URL("../../../tests/fixtures/mock-mcp-server.mjs", import.meta.url)),
);

describe("borg.mcp plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("matches its manifest and emits mcpAppDiscovered for show-form", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as {
      id: string;
      version: string;
      permissions: string[];
      contributes: unknown;
    };
    expect(mcpPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });

    const persona = personaSchema.parse({
      id: "system/general",
      name: "General",
      instructions: "Be useful.",
      preferredModels: ["borg.mock-llm:mock:scripted"],
      mcpServers: [
        {
          id: "mock",
          transport: "stdio",
          command: process.execPath,
          arguments: [fixture],
        },
      ],
    });
    const harness = createMcpHarness({ persona });
    const plugin = await createTestHarness(mcpPlugin, harness.context);
    cleanups.push(async () => {
      await plugin.deactivate();
      await harness.shutdown();
    });

    const listed = await harness.invoke<{ servers: { status: string }[] }>(
      mcpListServers,
      {},
    );
    expect(listed.servers).toEqual([
      { id: "mock", status: "idle", toolCount: 0, toolIds: [] },
    ]);

    const refreshed = await harness.invoke<{ servers: { status: string; toolCount: number }[] }>(
      mcpRefresh,
      { personaId: "system/general" },
    );
    expect(refreshed.servers[0]).toMatchObject({
      id: "mock",
      status: "ready",
      toolCount: 2,
      toolIds: ["mcp.mock.echo", "mcp.mock.show-form"],
    });
    const status = await harness.invoke<{ error?: string }>(mcpGetStatus, {
      serverId: "mock",
    });
    expect(status.error).toBeUndefined();

    const catalog = await harness.prepare();
    const result = await catalog.execute(
      "mcp.mock.show-form",
      {},
      {
        toolCallId: "form-1",
        sessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({
      structuredContent: { form: "mock", resourceUri: "ui://mock/form" },
    });
    const discovered = harness.emitted.find(
      (entry) => entry.id === mcpAppDiscovered.id,
    );
    expect(discovered?.payload).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      serverId: "mock",
      resourceUri: "ui://mock/form",
      sourceToolId: "mcp.mock.show-form",
      sourceToolName: "show-form",
    });
    const payload = mcpAppDiscovered.payload.parse(discovered?.payload);
    expect(payload.appInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(payload.resourceUri).toBe("ui://mock/form");
    expect(payload.html).toContain("data-testid=\"mcp-app-submit\"");
    expect(payload.html).toContain("ui/initialize");
    await catalog.close?.();
  });
});
