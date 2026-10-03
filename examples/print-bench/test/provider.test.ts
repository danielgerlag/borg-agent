import { describe, expect, it } from "vitest";
import type { ModelCompletionRequest } from "@borg-agent/contracts";
import {
  addToolId,
  designerModelId,
  feedbackAskToolId,
  placeToolId,
} from "../src/contract.js";
import {
  completeDesignerTurn,
  designerModelUrl,
  missingDesignerKeyMessage,
  wireToolName,
} from "../src/provider.js";

const request: ModelCompletionRequest = {
  modelId: designerModelId,
  messages: [
    { role: "system", content: "Be the designer." },
    { role: "user", content: "draw a gear\nSelection: none\nScene: []" },
  ],
  tools: [
    { id: addToolId, description: "Add a solid", inputSchema: { type: "object" } },
    { id: placeToolId, description: "Place solids", inputSchema: { type: "object" } },
    { id: feedbackAskToolId, description: "Ask the person", inputSchema: { type: "object" } },
  ],
};

describe("print bench designer model", () => {
  it("refuses to call the model when the key is missing", async () => {
    let committed = false;
    let fetched = false;
    await expect(
      completeDesignerTurn({
        request,
        permit: {
          async commit() {
            committed = true;
          },
        },
        signal: new AbortController().signal,
        env: {},
        fetchImpl: async () => {
          fetched = true;
          return Response.json({});
        },
      }),
    ).rejects.toThrow(missingDesignerKeyMessage);
    expect(committed).toBe(false);
    expect(fetched).toBe(false);
  });

  it("refuses a model URL that is not on this machine", async () => {
    let committed = false;
    await expect(
      completeDesignerTurn({
        request,
        permit: {
          async commit() {
            committed = true;
          },
        },
        signal: new AbortController().signal,
        env: { XAI_API_KEY: "test-key", BORG_PRINT_BENCH_MODEL_URL: "https://evil.example/responses" },
        fetchImpl: async () => {
          throw new Error("fetched");
        },
      }),
    ).rejects.toThrow(/must stay on this machine/);
    expect(committed).toBe(false);
  });

  it("sends the conversation and tool names, then runs the returned call", async () => {
    let committed = false;
    let seenUrl = "";
    let seen: unknown;
    const result = await completeDesignerTurn({
      request,
      permit: {
        async commit() {
          committed = true;
        },
      },
      signal: new AbortController().signal,
      env: { XAI_API_KEY: "test-key" },
      fetchImpl: async (url, init) => {
        expect(committed).toBe(true);
        seenUrl = String(url);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-key");
        seen = JSON.parse(String(init?.body));
        return Response.json({
          output: [
            {
              type: "function_call",
              name: wireToolName(feedbackAskToolId),
              call_id: "call-ask",
              arguments: JSON.stringify({
                prompt: "How many teeth, and what diameter in millimetres?",
                form: "text",
              }),
            },
          ],
          usage: { input_tokens: 12, output_tokens: 5 },
        });
      },
    });
    expect(seenUrl).toBe(designerModelUrl);
    expect(seen).toMatchObject({
      model: designerModelId,
      input: [
        { role: "system", content: "Be the designer." },
        { role: "user", content: "draw a gear\nSelection: none\nScene: []" },
      ],
      tools: [
        { type: "function", name: wireToolName(addToolId) },
        { type: "function", name: wireToolName(placeToolId) },
        { type: "function", name: wireToolName(feedbackAskToolId) },
      ],
    });
    expect(JSON.stringify(seen)).not.toContain("radiusMm");
    expect(result.toolCalls).toEqual([
      {
        id: "call-ask",
        name: feedbackAskToolId,
        input: {
          prompt: "How many teeth, and what diameter in millimetres?",
          form: "text",
        },
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it("maps a place call and keeps an object argument", async () => {
    const posed = {
      kind: "cylinder",
      radiusMm: 10,
      heightMm: 4,
      position: { x: 20, y: 30, z: 2 },
      rotationDeg: { x: 0, y: 0, z: 15 },
    };
    const result = await completeDesignerTurn({
      request,
      permit: { async commit() {} },
      signal: new AbortController().signal,
      env: { XAI_API_KEY: "test-key", BORG_PRINT_BENCH_MODEL_URL: "http://127.0.0.1:9/responses" },
      fetchImpl: async (url) => {
        expect(String(url)).toBe("http://127.0.0.1:9/responses");
        return Response.json({
          output: [
            {
              type: "function_call",
              name: wireToolName(placeToolId),
              call_id: "call-place",
              arguments: { parts: [posed] },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    expect(result.toolCalls?.[0]).toMatchObject({
      name: placeToolId,
      input: { parts: [posed] },
    });
  });

  it("forwards earlier tool calls and their results", async () => {
    let seen: unknown;
    await completeDesignerTurn({
      request: {
        ...request,
        messages: [
          { role: "user", content: "a sphere" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                name: feedbackAskToolId,
                input: { prompt: "What radius?", form: "text" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            content: JSON.stringify({ answer: { kind: "text", text: "15" } }),
          },
        ],
      },
      permit: { async commit() {} },
      signal: new AbortController().signal,
      env: { XAI_API_KEY: "test-key" },
      fetchImpl: async (_url, init) => {
        seen = JSON.parse(String(init?.body));
        return Response.json({ output_text: "Added a sphere.", usage: { input_tokens: 2, output_tokens: 2 } });
      },
    });
    expect(seen).toMatchObject({
      input: [
        { role: "user", content: "a sphere" },
        {
          type: "function_call",
          call_id: "call-1",
          name: wireToolName(feedbackAskToolId),
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ answer: { kind: "text", text: "15" } }),
        },
      ],
    });
  });

  it("includes a rejected request's reason", async () => {
    const result = await completeDesignerTurn({
      request,
      permit: { async commit() {} },
      signal: new AbortController().signal,
      env: { XAI_API_KEY: "test-key" },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "parameters must be an object" } }), {
          status: 400,
        }),
    });
    expect(result.content).toBe("The designer rejected the request. parameters must be an object");
  });

  it("reports a rejected key without the response body", async () => {
    const result = await completeDesignerTurn({
      request,
      permit: { async commit() {} },
      signal: new AbortController().signal,
      env: { XAI_API_KEY: "test-key" },
      fetchImpl: async () => new Response("secret-leak", { status: 401 }),
    });
    expect(result.content).toBe("The designer rejected the API key.");
    expect(result.content).not.toContain("secret-leak");
    expect(result.toolCalls).toBeUndefined();
  });

  it("reports an unknown tool name", async () => {
    const result = await completeDesignerTurn({
      request,
      permit: { async commit() {} },
      signal: new AbortController().signal,
      env: { XAI_API_KEY: "test-key" },
      fetchImpl: async () =>
        Response.json({
          output: [{ type: "function_call", name: "not_a_tool", call_id: "c", arguments: "{}" }],
        }),
    });
    expect(result.content).toBe("The designer called an unknown tool.");
  });
});
