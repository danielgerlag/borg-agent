import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type LlmProviderContribution,
  type ProviderEgress,
} from "@borg/plugin-sdk";
import {
  A2AService,
  A2A_OWNER_PLUGIN_ID,
  LoopManager,
  PersonaService,
  WorkspaceService,
  type JsonRpcResponse,
} from "../src";
import { createSecurityRuntime } from "./security-runtime";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEST_PROVIDER_EGRESS = {
  kind: "remote",
  capacity: "internal",
  destination: "https://models.test.invalid/v1/generate",
} satisfies ProviderEgress;

function resultOf(response: JsonRpcResponse): Record<string, unknown> {
  if ("error" in response) {
    throw new Error(response.error.message);
  }
  if (!response.result || typeof response.result !== "object") {
    throw new Error("A2A response is missing a task");
  }
  return response.result as Record<string, unknown>;
}

async function createA2ARuntime(options?: {
  readonly delayMs?: number;
}) {
  const runtime = createSecurityRuntime({
    fallbackPreferences: ["borg.mock-llm:mock:scripted"],
  });
  await runtime.executions.initialize();
  const personas = new PersonaService(runtime.store);
  await personas.initialize();
  const loops = new LoopManager(
    runtime.models,
    runtime.executions,
    runtime.tools,
    runtime.costs,
    (pluginId) => pluginId === "kernel.loop" || pluginId === A2A_OWNER_PLUGIN_ID,
    personas,
  );
  runtime.models.registerProvider("borg.mock-llm", {
    id: "borg.mock-llm",
    models: ["mock:scripted"],
    egress: TEST_PROVIDER_EGRESS,
    async complete(request, permit, signal) {
      await permit.commit();
      if ((options?.delayMs ?? 0) > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options?.delayMs);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      const last = request.messages.at(-1)?.content ?? "";
      return {
        content: `a2a reply: ${last}`,
        usage: {
          inputTokens: 2,
          outputTokens: 2,
          amount: 0,
          currency: "USD",
        },
      };
    },
  } satisfies LlmProviderContribution);
  const a2a = new A2AService({
    loops,
    personas,
    hostVersion: "0.1.0",
  });
  return { ...runtime, a2a, loops, personas };
}

describe("A2AService", () => {
  it("starts a loop whose task id equals the snapshot id and returns immediately", async () => {
    const { a2a, loops } = await createA2ARuntime();
    const messageId = randomUUID();
    const response = await a2a.dispatch({
      jsonrpc: "2.0",
      id: "send-1",
      method: "message/send",
      params: {
        message: {
          messageId,
          role: "user",
          parts: [{ kind: "text", text: "hello a2a" }],
        },
      },
    });
    const task = resultOf(response);
    expect(task.kind).toBe("task");
    expect(typeof task.id).toBe("string");
    expect(task.status).toEqual(
      expect.objectContaining({ state: "working" }),
    );
    const snapshot = loops.get(String(task.id), A2A_OWNER_PLUGIN_ID);
    expect(snapshot?.id).toBe(task.id);
    expect(snapshot?.prompt).toBe("hello a2a");
    await vi.waitFor(() =>
      expect(loops.get(String(task.id), A2A_OWNER_PLUGIN_ID)?.status).toBe(
        "completed",
      ),
    );
  });

  it("accepts SendMessage aliases, gets the same task, and cancels a live run", async () => {
    const { a2a, loops } = await createA2ARuntime({ delayMs: 30_000 });
    const sent = resultOf(
      await a2a.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: randomUUID(),
            parts: [{ type: "text", text: "stay running" }],
          },
        },
      }),
    );
    const taskId = String(sent.id);
    expect(loops.get(taskId, A2A_OWNER_PLUGIN_ID)?.status).toBe("running");

    const fetched = resultOf(
      await a2a.dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "GetTask",
        params: { id: taskId },
      }),
    );
    expect(fetched.id).toBe(taskId);
    expect(fetched.status).toEqual(
      expect.objectContaining({ state: "working" }),
    );

    const cancelled = resultOf(
      await a2a.dispatch({
        jsonrpc: "2.0",
        id: 3,
        method: "CancelTask",
        params: { taskId },
      }),
    );
    expect(cancelled.id).toBe(taskId);
    expect(cancelled.status).toEqual(
      expect.objectContaining({ state: "canceled" }),
    );
    expect(loops.get(taskId, A2A_OWNER_PLUGIN_ID)?.status).toBe("cancelled");
  });

  it("rejects unknown methods and missing tasks", async () => {
    const { a2a } = await createA2ARuntime();
    await expect(
      a2a.dispatch({
        jsonrpc: "2.0",
        id: "nope",
        method: "tasks/explode",
      }),
    ).resolves.toMatchObject({
      error: { code: -32_601 },
    });
    await expect(
      a2a.dispatch({
        jsonrpc: "2.0",
        id: "missing",
        method: "tasks/get",
        params: { id: randomUUID() },
      }),
    ).resolves.toMatchObject({
      error: { code: -32_001 },
    });
  });

  it("listens on 127.0.0.1 and serves the agent card plus JSON-RPC", async () => {
    const { a2a } = await createA2ARuntime();
    await a2a.listen(0);
    const address = a2a.address();
    expect(address?.host).toBe("127.0.0.1");
    expect(address?.port).toBeGreaterThan(0);
    try {
      const cardResponse = await fetch(
        `http://127.0.0.1:${address?.port}/.well-known/agent-card.json`,
      );
      const card = (await cardResponse.json()) as { readonly name?: string };
      expect(card.name).toBe("General");

      const rpcResponse = await fetch(`http://127.0.0.1:${address?.port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "http-1",
          method: "message/send",
          params: {
            message: {
              messageId: randomUUID(),
              parts: [{ kind: "text", text: "from http" }],
            },
          },
        }),
      });
      const body = (await rpcResponse.json()) as JsonRpcResponse;
      expect(resultOf(body).status).toEqual(
        expect.objectContaining({ state: "working" }),
      );
    } finally {
      await a2a.close();
    }
  });

  it("allocates a workspace session when WorkspaceService is provided", async () => {
    const security = createSecurityRuntime({
      fallbackPreferences: ["borg.mock-llm:mock:scripted"],
    });
    await security.executions.initialize();
    const personas = new PersonaService(security.store);
    await personas.initialize();
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-a2a-"));
    const workspaces = new WorkspaceService(root);
    const loops = new LoopManager(
      security.models,
      security.executions,
      security.tools,
      security.costs,
      (pluginId) =>
        pluginId === "kernel.loop" || pluginId === A2A_OWNER_PLUGIN_ID,
      personas,
      undefined,
      workspaces,
    );
    security.models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        return {
          content: "workspace reply",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            amount: 0,
            currency: "USD",
          },
        };
      },
    } satisfies LlmProviderContribution);
    const a2a = new A2AService({
      loops,
      personas,
      workspaces,
    });
    const contextId = randomUUID();
    const task = resultOf(
      await a2a.dispatch({
        jsonrpc: "2.0",
        id: "ws",
        method: "message/send",
        params: {
          message: {
            messageId: randomUUID(),
            contextId,
            parts: [{ kind: "text", text: "with workspace" }],
          },
        },
      }),
    );
    expect(workspaces.get(A2A_OWNER_PLUGIN_ID, contextId)?.sessionId).toBe(
      contextId,
    );
    expect(loops.get(String(task.id), A2A_OWNER_PLUGIN_ID)?.sessionId).toBe(
      contextId,
    );
  });

  it("stays disabled until listen is requested and closes when disabled", async () => {
    const { a2a } = await createA2ARuntime();
    expect(a2a.listening()).toBe(false);
    await a2a.applyConfig({ enabled: false, port: 8_733 });
    expect(a2a.listening()).toBe(false);
    await a2a.listen(0);
    expect(a2a.listening()).toBe(true);
    expect(a2a.address()?.host).toBe("127.0.0.1");
    await a2a.applyConfig({ enabled: false, port: 8_733 });
    expect(a2a.listening()).toBe(false);
  });
});
