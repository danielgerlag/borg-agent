import {
  commandErrorSchema,
  defineCommand,
  defineEvent,
} from "@borg/contracts";
import { MCP_APP_MAX_MESSAGE_BYTES } from "@borg/plugin-mcp/contract";
import { z } from "zod";

export const MCP_APP_RENDERER_ID = "borg.mcp-apps";
export const MCP_APP_BRIDGE_CHANNEL = "borg.mcp-apps.bridge.v1";

export const mcpAppRequestIdSchema = z.union([
  z.string().min(1).max(256),
  z.number().int().safe(),
]);

export type McpAppRequestId = z.infer<typeof mcpAppRequestIdSchema>;

const mcpAppBridgeJsonSchema = z.json().refine(
  (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MCP_APP_MAX_MESSAGE_BYTES - 1_024,
  "MCP App bridge value exceeds the size cap",
);

export const mcpAppToolArgumentsSchema = z
  .record(z.string().min(1).max(256), z.json())
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      context.addIssue({
        code: "custom",
        message: "MCP App tool arguments exceed the size cap",
      });
    }
  });
export type McpAppToolArguments = z.infer<
  typeof mcpAppToolArgumentsSchema
>;

export const mcpAppsInvokeTool = defineCommand({
  id: "borg.mcpApps.invokeTool",
  input: z
    .object({
      appInstanceId: z.string().uuid(),
      invocationId: z.string().uuid(),
      requestId: mcpAppRequestIdSchema,
      toolName: z.string().min(1).max(256),
      arguments: mcpAppToolArgumentsSchema.default({}),
    })
    .strict(),
  output: z
    .object({
      requestId: mcpAppRequestIdSchema,
      result: mcpAppBridgeJsonSchema,
    })
    .strict(),
  timeoutMs: 300_000,
});

export const mcpAppsCancelTool = defineCommand({
  id: "borg.mcpApps.cancelTool",
  input: z
    .object({
      appInstanceId: z.string().uuid(),
      invocationId: z.string().uuid(),
    })
    .strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
});

export const mcpAppToolResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      result: mcpAppBridgeJsonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: commandErrorSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
    })
    .strict(),
]);

export const mcpAppToolResponded = defineEvent({
  id: "borg.mcpApps.toolResponded",
  payload: z
    .object({
      appInstanceId: z.string().uuid(),
      invocationId: z.string().uuid(),
      requestId: mcpAppRequestIdSchema,
      response: mcpAppToolResponseSchema,
      respondedAt: z.string().datetime(),
    })
    .strict(),
});
