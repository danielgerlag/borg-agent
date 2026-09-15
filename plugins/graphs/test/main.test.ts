import {
  channelInboundMessage,
  graphsAssist,
  graphsListCatalog,
  graphsListInstances,
  graphsSaveDefinition,
  type GraphDefinition,
  type GraphInstance,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import graphsPlugin from "../src/main";
import { createGraphHarness, linearDefinition } from "./harness";

describe("borg.graphs plugin", () => {
  it("matches its manifest and launches an incoming-message graph via handlers", async () => {
    const fixture = createGraphHarness();
    const manifest = JSON.parse(
      await readFile(
        new URL("../borg.plugin.json", import.meta.url),
        "utf8",
      ),
    ) as {
      id: string;
      version: string;
      permissions: string[];
      contributes: {
        commands: string[];
        events: string[];
        extensionPoints: string[];
        kinds: string[];
      };
    };
    expect(graphsPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });

    const harness = await createTestHarness(graphsPlugin, fixture.context);
    const definition = linearDefinition({
      id: "incoming-fixture",
      triggerKind: "incoming_message",
      triggerConfig: { channelId: "matching-channel" },
      taskConfig: { name: "message", value: "$input.text" },
      output: { message: "$vars.message" },
    });
    await fixture.invokeCommand<{ definition: GraphDefinition }>(
      graphsSaveDefinition,
      { definition },
    );

    await fixture.emitEvent(channelInboundMessage, {
      id: crypto.randomUUID(),
      channelId: "other-channel",
      text: "ignore me",
      metadata: {},
      receivedAt: new Date().toISOString(),
    });
    const inboundId = crypto.randomUUID();
    const matchingMessage = {
      id: inboundId,
      channelId: "matching-channel",
      text: "launch this graph",
      sender: "fixture-user",
      metadata: { source: "unit-test" },
      receivedAt: new Date().toISOString(),
    };
    await fixture.emitEvent(channelInboundMessage, matchingMessage);
    await fixture.emitEvent(channelInboundMessage, matchingMessage);
    await fixture.flush();

    const listed = await fixture.invokeCommand<{
      instances: GraphInstance[];
    }>(graphsListInstances, { graphId: definition.id });
    const catalog = await fixture.invokeCommand<{
      tools: { id: string; description: string; inputSchema: unknown }[];
    }>(graphsListCatalog, {});
    expect(catalog.tools.map(({ id }) => id).sort()).toEqual(
      ["graphs.inspect", "graphs.list", "graphs.run"].sort(),
    );

    expect(listed.instances).toHaveLength(1);
    expect(listed.instances[0]).toMatchObject({
      graphId: definition.id,
      trigger: "incoming_message",
      status: "completed",
      input: {
        channelId: "matching-channel",
        text: "launch this graph",
        sender: "fixture-user",
        metadata: { source: "unit-test" },
      },
      output: { message: "launch this graph" },
    });

    await harness.deactivate();
  });

  it("assists a graph definition from a model JSON reply", async () => {
    const fixture = createGraphHarness();
    const sample = linearDefinition({ id: "assisted-echo" });
    fixture.setCompleteContent(
      `Created the graph.\n\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``,
    );
    const harness = await createTestHarness(graphsPlugin, fixture.context);
    const result = await fixture.invokeCommand<{
      definition: GraphDefinition;
      summary: string;
    }>(graphsAssist, { prompt: "Echo hello then end" });
    expect(result.definition.id).toBe("assisted-echo");
    expect(result.summary).toContain("Created the graph.");
    await harness.deactivate();
  });
});
