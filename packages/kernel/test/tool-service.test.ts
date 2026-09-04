import { defineTool, z, type PreparedToolCatalog } from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { InteractionService, ToolService } from "../src";

const echoSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Echo input",
  type: "object",
  properties: {
    text: { type: "string", minLength: 1 },
  },
  required: ["text"],
  additionalProperties: false,
};

const echoOutputSchema = {
  type: "object",
  properties: {
    echoed: { type: "string" },
  },
  required: ["echoed"],
  additionalProperties: false,
};

function createPersona(id: string, sessionMarker: string) {
  return {
    id,
    name: id,
    instructions: sessionMarker,
    preferredModels: ["borg.mock-llm:mock:scripted"],
    secondaryModels: [],
    allowedTools: ["*"],
    mcpServers: [],
    loopStrategy: "react" as const,
    toolExecutionMode: "sequential-partial" as const,
    skillIds: [],
    archived: false,
    bundled: false,
  };
}

function createCatalog(
  execute: PreparedToolCatalog["execute"],
  close?: () => void,
): PreparedToolCatalog {
  return {
    definitions: [
      {
        id: "mcp.demo.echo",
        description: "Echo through a scoped catalog",
        inputSchema: echoSchema,
        outputSchema: echoOutputSchema,
        approval: "auto",
        sideEffect: false,
      },
    ],
    execute,
    ...(close ? { close } : {}),
  };
}

describe("ToolService scoped catalogs", () => {
  it("keeps static tools on the global map and isolated from dynamic catalogs", () => {
    const tools = new ToolService(new InteractionService());
    tools.register(
      "borg.tools.echo",
      defineTool({
        id: "tools.echo",
        description: "Static echo",
        input: z.object({ text: z.string() }),
        output: z.object({ echoed: z.string() }),
        approval: "auto",
        sideEffect: false,
        execute: ({ text }) => ({ echoed: text }),
      }),
    );
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      namespace: "mcp.demo",
      prepare: async () =>
        createCatalog(async (toolId, input) => ({
          echoed: `${toolId}:${JSON.stringify(input)}`,
        })),
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"]);

    expect(tools.has("tools.echo")).toBe(true);
    expect(tools.has("mcp.demo.echo")).toBe(false);
    expect(tools.listDefinitions(["*"]).map(({ id }) => id)).toEqual([
      "tools.echo",
    ]);
  });

  it("gives concurrent runs distinct implementations for the same dynamic id", async () => {
    const tools = new ToolService(new InteractionService());
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare(scope) {
        return createCatalog(async (_toolId, input) => ({
          echoed: `${scope.personaId}:${scope.sessionId}:${(input as { text: string }).text}`,
        }));
      },
    });
    const personaA = createPersona("user/one", "alpha");
    const personaB = createPersona("user/two", "beta");
    tools.registerRunPolicy("run-a", "borg.owner", ["*"], {
      persona: personaA,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    tools.registerRunPolicy("run-b", "borg.owner", ["*"], {
      persona: personaB,
      sessionId: "22222222-2222-4222-8222-222222222222",
    });

    await Promise.all([tools.prepareRun("run-a"), tools.prepareRun("run-b")]);

    await expect(
      tools.invoke("mcp.demo.echo", { text: "hello" }, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).resolves.toEqual({
      echoed: "user/one:11111111-1111-4111-8111-111111111111:hello",
    });
    await expect(
      tools.invoke("mcp.demo.echo", { text: "hello" }, {
        callerPluginId: "borg.owner",
        runId: "run-b",
      }),
    ).resolves.toEqual({
      echoed: "user/two:22222222-2222-4222-8222-222222222222:hello",
    });
  });

  it("does not let one run's allow-all list reveal another run's dynamic tools", async () => {
    const tools = new ToolService(new InteractionService());
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare(scope) {
        return {
          definitions: [
            {
              id: `mcp.demo.${scope.sessionId === "session-a" ? "alpha" : "beta"}`,
              description: "Scoped tool",
              inputSchema: { type: "object", additionalProperties: false },
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ ok: true }),
        };
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"], { sessionId: "session-a" });
    tools.registerRunPolicy("run-b", "borg.owner", ["*"], { sessionId: "session-b" });
    await Promise.all([tools.prepareRun("run-a"), tools.prepareRun("run-b")]);

    expect(
      tools.listDefinitions(["*"], undefined, "run-a").map(({ id }) => id),
    ).toEqual(["mcp.demo.alpha"]);
    expect(
      tools.listDefinitions(["*"], undefined, "run-b").map(({ id }) => id),
    ).toEqual(["mcp.demo.beta"]);
    expect(tools.listDefinitions(["*"]).map(({ id }) => id)).toEqual([]);
    await expect(
      tools.invoke("mcp.demo.beta", {}, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      tools.invoke("mcp.demo.alpha", {}, {
        callerPluginId: "borg.owner",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      tools.invoke("mcp.demo.alpha", {}, {
        callerPluginId: "borg.other",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps app-only dynamic tools invokable but hidden from models", async () => {
    const tools = new ToolService(new InteractionService());
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.app-only",
              description: "App-only tool",
              inputSchema: { type: "object", additionalProperties: false },
              approval: "auto" as const,
              sideEffect: false,
              modelVisible: false,
            },
          ],
          execute: async () => ({ app: true }),
        };
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["mcp.demo.app-only"]);
    await tools.prepareRun("run-a");

    expect(tools.listDefinitions(["*"], undefined, "run-a")).toEqual([]);
    await expect(
      tools.invoke("mcp.demo.app-only", {}, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).resolves.toEqual({ app: true });
  });

  it("runs dynamic tools through approval, validation, workspace, output, and cancel paths", async () => {
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
    const seen: Array<Record<string, unknown>> = [];
    let finish: (() => void) | undefined;
    tools.registerProvider(
      "borg.mcp",
      {
        id: "borg.mcp",
        async prepare() {
          return {
            definitions: [
              {
                id: "mcp.demo.echo",
                description: "Ask first",
                inputSchema: echoSchema,
                outputSchema: echoOutputSchema,
                approval: "ask" as const,
                sideEffect: true,
              },
            ],
            async execute(_toolId, input, context) {
              seen.push({
                input,
                workspaceRoot: context.workspaceRoot,
                sessionId: context.sessionId,
              });
              context.signal.throwIfAborted();
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              context.signal.throwIfAborted();
              return { echoed: (input as { text: string }).text };
            },
          };
        },
      },
      { workspaceAccess: true },
    );
    const policy = tools.registerRunPolicy("run-a", "borg.owner", ["*"], {
      sessionId: "33333333-3333-4333-8333-333333333333",
      workspaceRoot: "/tmp/workspace-a",
    });
    await tools.prepareRun("run-a");

    await expect(
      tools.invoke("mcp.demo.echo", { text: "" }, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "invalid" });

    const invocation = tools.invoke("mcp.demo.echo", { text: "hello" }, {
      callerPluginId: "borg.owner",
      runId: "run-a",
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    interactions.respond(interactions.listPending()[0]!.id, {
      kind: "approval",
      decision: "allow",
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(seen).toEqual([
      {
        input: { text: "hello" },
        workspaceRoot: "/tmp/workspace-a",
        sessionId: "33333333-3333-4333-8333-333333333333",
      },
    ]);
    policy.dispose();
    finish?.();
    await expect(invocation).rejects.toMatchObject({ code: "failed" });
  });

  it("rejects invalid dynamic output and hides workspace without access", async () => {
    const tools = new ToolService(new InteractionService());
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        return createCatalog(async (_toolId, _input, context) => ({
          echoed: "ok",
          leaked: context.workspaceRoot ?? null,
        }));
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"], {
      workspaceRoot: "/tmp/hidden",
    });
    await tools.prepareRun("run-a");
    await expect(
      tools.invoke("mcp.demo.echo", { text: "hello" }, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("isolates a provider prepare failure from the rest of the catalog", async () => {
    const tools = new ToolService(new InteractionService());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tools.registerProvider("borg.broken", {
      id: "borg.broken",
      prepare: async () => {
        throw new Error("provider down");
      },
    });
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      prepare: async () => createCatalog(async () => ({ echoed: "ok" })),
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"]);
    await tools.prepareRun("run-a");

    expect(tools.listDefinitions(["*"], undefined, "run-a").map(({ id }) => id)).toEqual([
      "mcp.demo.echo",
    ]);
    await expect(
      tools.invoke("mcp.demo.echo", { text: "hello" }, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).resolves.toEqual({ echoed: "ok" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("prepares a run once under concurrent callers", async () => {
    const tools = new ToolService(new InteractionService());
    let prepares = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        prepares += 1;
        await gate;
        return createCatalog(async () => ({ echoed: "ok" }));
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"]);
    const first = tools.prepareRun("run-a");
    const second = tools.prepareScope("run-a");
    await Promise.resolve();
    expect(prepares).toBe(1);
    release();
    await Promise.all([first, second]);
    await tools.prepareRun("run-a");
    expect(prepares).toBe(1);
  });

  it("aborts and closes catalogs when a run is disposed or a plugin is removed", async () => {
    const tools = new ToolService(new InteractionService());
    const closed: string[] = [];
    const seenSignals: AbortSignal[] = [];
    tools.registerProvider("borg.keep", {
      id: "borg.keep",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.keep.tool",
              description: "Survivor",
              inputSchema: { type: "object" },
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ ok: true }),
          close: () => {
            closed.push("keep");
          },
        };
      },
    });
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Removable",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          async execute(_toolId, input, context) {
            seenSignals.push(context.signal);
            await new Promise<void>((_resolve, reject) => {
              if (context.signal.aborted) {
                reject(context.signal.reason);
                return;
              }
              context.signal.addEventListener(
                "abort",
                () => reject(context.signal.reason),
                { once: true },
              );
            });
            return { echoed: (input as { text: string }).text };
          },
          close: () => {
            closed.push("mcp");
          },
          dispose: () => {
            closed.push("mcp-dispose");
          },
        };
      },
    });
    const policy = tools.registerRunPolicy("run-a", "borg.owner", ["*"]);
    await tools.prepareRun("run-a");
    const invocation = tools.invoke("mcp.demo.echo", { text: "hello" }, {
      callerPluginId: "borg.owner",
      runId: "run-a",
    });
    await vi.waitFor(() => expect(seenSignals).toHaveLength(1));
    tools.removePlugin("borg.mcp");
    await expect(invocation).rejects.toMatchObject({ code: "failed" });
    expect(seenSignals[0]?.aborted).toBe(true);
    expect(closed).toEqual(["mcp"]);
    expect(
      tools.listDefinitions(["*"], undefined, "run-a").map(({ id }) => id),
    ).toEqual(["mcp.keep.tool"]);

    const other = tools.invoke("mcp.keep.tool", {}, {
      callerPluginId: "borg.owner",
      runId: "run-a",
    });
    await expect(other).resolves.toEqual({ ok: true });
    policy.dispose();
    tools.removePlugin("borg.mcp");
    expect(closed).toEqual(["mcp", "keep"]);
  });

  it("closes a catalog once when the run is disposed before plugin removal", async () => {
    const tools = new ToolService(new InteractionService());
    let closed = 0;
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Once",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ echoed: "ok" }),
          close: () => {
            closed += 1;
          },
          dispose: () => {
            closed += 1;
          },
        };
      },
    });
    const policy = tools.registerRunPolicy("run-a", "borg.owner", ["*"]);
    await tools.prepareRun("run-a");
    policy.dispose();
    tools.removePlugin("borg.mcp");
    expect(closed).toBe(1);
  });

  it("omits workspaceRoot from prepare scope without workspace access", async () => {
    const tools = new ToolService(new InteractionService());
    const seen: Array<string | undefined> = [];
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare(scope) {
        seen.push(scope.workspaceRoot);
        return createCatalog(async () => ({ echoed: "ok" }));
      },
    });
    tools.registerProvider(
      "borg.files",
      {
        id: "borg.files",
        namespace: "mcp.files",
        async prepare(scope) {
          seen.push(scope.workspaceRoot);
          return {
            definitions: [
              {
                id: "mcp.files.read",
                description: "Read",
                inputSchema: { type: "object" },
                approval: "auto" as const,
                sideEffect: false,
              },
            ],
            execute: async () => ({ ok: true }),
          };
        },
      },
      { workspaceAccess: true },
    );
    tools.registerRunPolicy("run-a", "borg.owner", ["*"], {
      workspaceRoot: "/tmp/session-workspace",
    });
    await tools.prepareRun("run-a");
    expect(seen).toEqual([undefined, "/tmp/session-workspace"]);
  });

  it("rejects invalid namespaces and definitions outside the provider namespace", async () => {
    const tools = new ToolService(new InteractionService());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      tools.registerProvider("borg.mcp", {
        id: "borg.mcp",
        namespace: "MCP.Demo",
        prepare: async () => createCatalog(async () => ({ echoed: "ok" })),
      }),
    ).toThrow(/Invalid tool provider/);
    expect(() =>
      tools.registerProvider("borg.mcp", {
        id: "borg.mcp",
        namespace: "mcp.",
        prepare: async () => createCatalog(async () => ({ echoed: "ok" })),
      }),
    ).toThrow(/Invalid tool provider/);
    expect(() =>
      tools.registerProvider("borg.mcp", {
        id: "borg.mcp",
        namespace: "mcp_demo",
        prepare: async () => createCatalog(async () => ({ echoed: "ok" })),
      }),
    ).toThrow(/Invalid tool provider/);
    expect(() =>
      tools.registerProvider("borg.mcp", {
        id: "borg.mcp",
        namespace: "mcp.demo_server",
        prepare: async () => createCatalog(async () => ({ echoed: "ok" })),
      }),
    ).toThrow(/Invalid tool provider/);

    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      namespace: "mcp.demo",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Inside",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
            {
              id: "mcp.demoevil.echo",
              description: "Confused",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
            {
              id: "mcp.other.echo",
              description: "Foreign",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ echoed: "ok" }),
        };
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"]);
    await tools.prepareRun("run-a");
    expect(
      tools.listDefinitions(["*"], undefined, "run-a").map(({ id }) => id),
    ).toEqual(["mcp.demo.echo"]);
    consoleError.mockRestore();
  });

  it("lists a run catalog through the frozen policy allowlist, not caller patterns", async () => {
    const tools = new ToolService(new InteractionService());
    for (const id of ["tools.allowed", "tools.blocked"]) {
      tools.register(
        "borg.tools.layered",
        defineTool({
          id,
          description: id,
          input: z.object({}).strict(),
          output: z.object({ id: z.string() }).strict(),
          approval: "auto",
          sideEffect: false,
          execute: () => ({ id }),
        }),
      );
    }
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      namespace: "mcp.demo",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Allowed dynamic",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
            {
              id: "mcp.demo.other",
              description: "Blocked dynamic",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ echoed: "ok" }),
        };
      },
    });
    tools.registerRunPolicy("run-restricted", "borg.owner", [
      "tools.allowed",
      "mcp.demo.echo",
    ]);
    await tools.prepareRun("run-restricted");

    expect(
      tools
        .listDefinitions(["*"], undefined, "run-restricted")
        .map(({ id }) => id),
    ).toEqual(["mcp.demo.echo", "tools.allowed"]);
    expect(tools.listDefinitions(["*"]).map(({ id }) => id)).toEqual([
      "tools.allowed",
      "tools.blocked",
    ]);
  });

  it("surfaces raw JSON Schema unchanged and freezes the run persona snapshot", async () => {
    const tools = new ToolService(new InteractionService());
    const seen: unknown[] = [];
    const persona = createPersona("user/one", "original");
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare(scope) {
        seen.push(scope.persona?.instructions);
        return createCatalog(async () => ({ echoed: "ok" }));
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"], { persona });
    persona.instructions = "mutated later";
    await tools.prepareRun("run-a");

    const listed = tools.listDefinitions(["*"], undefined, "run-a")[0];
    expect(listed?.inputSchema).toEqual(echoSchema);
    expect(listed?.inputSchema).not.toBe(echoSchema);
    expect(Object.isFrozen(listed?.inputSchema)).toBe(true);
    expect(seen).toEqual(["original"]);
  });

  it("rejects dynamic ids that collide with static tools or each other", async () => {
    const tools = new ToolService(new InteractionService());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tools.register(
      "borg.tools.echo",
      defineTool({
        id: "tools.echo",
        description: "Static",
        input: z.object({ text: z.string() }),
        output: z.object({ echoed: z.string() }),
        approval: "auto",
        sideEffect: false,
        execute: ({ text }) => ({ echoed: `static:${text}` }),
      }),
    );
    tools.registerProvider("borg.first", {
      id: "borg.first",
      async prepare() {
        return {
          definitions: [
            {
              id: "tools.echo",
              description: "Shadow",
              inputSchema: echoSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
            {
              id: "mcp.demo.echo",
              description: "First",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ echoed: "first" }),
        };
      },
    });
    tools.registerProvider("borg.second", {
      id: "borg.second",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Second",
              inputSchema: echoSchema,
              outputSchema: echoOutputSchema,
              approval: "auto" as const,
              sideEffect: false,
            },
          ],
          execute: async () => ({ echoed: "second" }),
        };
      },
    });
    tools.registerRunPolicy("run-a", "borg.owner", ["*"]);
    await tools.prepareRun("run-a");

    expect(
      tools.listDefinitions(["*"], undefined, "run-a").map(({ id }) => id),
    ).toEqual(["mcp.demo.echo", "tools.echo"]);
    await expect(
      tools.invoke("tools.echo", { text: "hello" }, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).resolves.toEqual({ echoed: "static:hello" });
    await expect(
      tools.invoke("mcp.demo.echo", { text: "hello" }, {
        callerPluginId: "borg.owner",
        runId: "run-a",
      }),
    ).resolves.toEqual({ echoed: "first" });
    consoleError.mockRestore();
  });
});
