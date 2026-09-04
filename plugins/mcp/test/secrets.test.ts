import { personaSchema } from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import mcpPlugin from "../src/main";
import { createMcpHarness } from "./harness";

describe("MCP secret isolation", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("injects secret values at the process boundary only", async () => {
    const captured: Array<Readonly<Record<string, string>> | undefined> = [];
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
          arguments: ["-e", "process.exit(0)"],
          environmentSecretRefs: { TOKEN: "mcpToken" },
        },
      ],
    });
    const harness = createMcpHarness({
      persona,
      secrets: { mcpToken: "super-secret-token" },
    });
    const originalSpawn = harness.context.process.spawn;
    harness.context.process.spawn = async (command, args, options) => {
      captured.push(options?.env);
      return originalSpawn(command, args, options);
    };
    const plugin = await createTestHarness(mcpPlugin, harness.context);
    cleanups.push(async () => {
      await plugin.deactivate();
      await harness.shutdown();
    });

    const catalog = await harness.prepare();
    await catalog.close?.();

    expect(captured[0]?.TOKEN).toBe("super-secret-token");
    const listed = await harness.invoke<{ servers: { error?: string }[] }>(
      { id: "borg.mcp.listServers" },
      { personaId: "system/general" },
    );
    const serialized = JSON.stringify({ listed, logs: harness.logs, emitted: harness.emitted });
    expect(serialized).not.toContain("super-secret-token");
    for (const entry of harness.logs) {
      expect(JSON.stringify(entry)).not.toContain("super-secret-token");
    }
  });

  it("injects header secrets on HTTP transports only", async () => {
    const headers: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      headers.push(request.headers.get("x-api-key") ?? "");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found: initialize" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const persona = personaSchema.parse({
      id: "system/general",
      name: "General",
      instructions: "Be useful.",
      preferredModels: ["borg.mock-llm:mock:scripted"],
      mcpServers: [
        {
          id: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:1/mcp",
          headerSecretRefs: { "x-api-key": "remoteKey" },
        },
      ],
    });
    const harness = createMcpHarness({
      persona,
      secrets: { remoteKey: "header-secret-value" },
      fetchImpl,
    });
    const plugin = await createTestHarness(mcpPlugin, harness.context);
    cleanups.push(async () => {
      await plugin.deactivate();
      await harness.shutdown();
    });
    const catalog = await harness.prepare();
    await catalog.close?.();
    expect(headers).toContain("header-secret-value");
    expect(JSON.stringify(harness.logs)).not.toContain("header-secret-value");
    expect(JSON.stringify(harness.emitted)).not.toContain("header-secret-value");
  });
});
