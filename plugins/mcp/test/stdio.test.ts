import { createTestHarness } from "@borg/plugin-sdk";
import {
  mcpAppDiscovered,
  mcpAppSnapshotSchema,
  personaSchema,
} from "@borg/contracts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../src/json-rpc";
import { MAX_JSONRPC_BYTES } from "../src/protocol";
import { StdioTransport } from "../src/stdio";
import mcpPlugin from "../src/main";
import { createMcpHarness } from "./harness";

const fixture = path.resolve(
  fileURLToPath(new URL("../../../tests/fixtures/mock-mcp-server.mjs", import.meta.url)),
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("MCP stdio fixture", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("discovers echo, cancels a held call, and cleans up the process", async () => {
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

    const catalog = await harness.prepare();
    expect(catalog.definitions.map((tool) => tool.id)).toEqual([
      "mcp.mock.echo",
      "mcp.mock.show-form",
      "mcp.mock.app-only",
    ]);
    expect(
      catalog.definitions.find(({ id }) => id === "mcp.mock.app-only"),
    ).toMatchObject({ modelVisible: false });
    expect(
      catalog.definitions
        .filter((tool) => tool.modelVisible !== false)
        .some((tool) => tool.id.endsWith(".app-only")),
    ).toBe(false);
    const echo = catalog.definitions.find((tool) => tool.id === "mcp.mock.echo");
    expect(echo?.approval).toBe("auto");

    const echoed = await catalog.execute(
      "mcp.mock.echo",
      { text: "hello" },
      {
        toolCallId: "call-1",
        sessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
      },
    );
    expect(echoed).toMatchObject({
      structuredContent: { echoed: "hello" },
    });

    await catalog.execute(
      "mcp.mock.show-form",
      {},
      {
        toolCallId: "call-app",
        sessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
      },
    );
    const discovered = harness.emitted.find(
      ({ id }) => id === mcpAppDiscovered.id,
    )?.payload;
    const discoveredPayload = mcpAppDiscovered.payload.parse(discovered);
    expect(discoveredPayload).toMatchObject({
      sourceToolId: "mcp.mock.show-form",
      resourceUri: "ui://mock/form",
    });
    expect(() =>
      mcpAppSnapshotSchema.parse({ ...discoveredPayload, version: 1 }),
    ).not.toThrow();

    const controller = new AbortController();
    const held = catalog.execute(
      "mcp.mock.echo",
      { text: "__hold__" },
      {
        toolCallId: "call-2",
        sessionId: "11111111-1111-4111-8111-111111111111",
        signal: controller.signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(held).rejects.toThrow(/aborted|cancelled|closed/);

    expect(harness.spawnedPids.length).toBeGreaterThan(0);
    await catalog.close?.();
    await new Promise((resolve) => setTimeout(resolve, 75));
    for (const pid of harness.spawnedPids) {
      expect(isAlive(pid)).toBe(false);
    }
  });

  it("rejects pending calls when stdout is malformed or oversized", async () => {
    const harness = createMcpHarness();
    cleanups.push(() => harness.shutdown());

    const malformed = await StdioTransport.open({
      process: harness.context.process,
      command: process.execPath,
      args: ["-e", replyThen('"{not-json\\n"')],
    });
    const malformedPeer = new JsonRpcPeer(malformed);
    await expect(malformedPeer.request("ping")).resolves.toEqual({ ok: true });
    await expect(malformedPeer.request("ping")).rejects.toThrow(/closed|malformed/);
    await malformedPeer.close().catch(() => undefined);

    const oversized = await StdioTransport.open({
      process: harness.context.process,
      command: process.execPath,
      args: [
        "-e",
        replyThen(`"x".repeat(${MAX_JSONRPC_BYTES + 1})`),
      ],
    });
    const oversizedPeer = new JsonRpcPeer(oversized);
    await expect(oversizedPeer.request("ping")).resolves.toEqual({ ok: true });
    await expect(oversizedPeer.request("ping")).rejects.toThrow(/closed|too large/);
    await oversizedPeer.close().catch(() => undefined);
  });
});

function replyThen(secondWrite: string): string {
  return `
    let n = 0;
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        n += 1;
        if (n === 1) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
          continue;
        }
        process.stdout.write(${secondWrite});
      }
    });
  `;
}
