import { describe, expect, it } from "vitest";
import {
  chatCompletionsBody,
  completionFromChatResponse,
} from "../src/compose";
import type { ModelCompletionRequest } from "@borg/plugin-sdk";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  amount: 0,
  currency: "USD" as const,
};

describe("openai-compat chat mapping", () => {
  it("sends tools, assistant tool_calls, and tool results", () => {
    const request = {
      modelId: "gpt-5-mini",
      messages: [
        { role: "user", content: "echo hello" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "tools.echo", input: { text: "hello" } },
          ],
        },
        {
          role: "tool",
          content: '{"echoed":"hello"}',
          toolCallId: "call-1",
        },
      ],
      tools: [
        {
          id: "tools.echo",
          description: "Echo text",
          inputSchema: { type: "object" },
        },
      ],
    } as unknown as ModelCompletionRequest;
    expect(chatCompletionsBody("gpt-5-mini", request)).toEqual({
      model: "gpt-5-mini",
      messages: [
        { role: "user", content: "echo hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "tools.echo",
                arguments: '{"text":"hello"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: '{"echoed":"hello"}',
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "tools.echo",
            description: "Echo text",
            parameters: { type: "object" },
          },
        },
      ],
    });
  });

  it("parses tool_calls from the chat response", () => {
    expect(
      completionFromChatResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "tools.echo",
                    arguments: '{"text":"hello"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      toolCalls: [
        { id: "call-1", name: "tools.echo", input: { text: "hello" } },
      ],
      usage,
    });
  });
});
