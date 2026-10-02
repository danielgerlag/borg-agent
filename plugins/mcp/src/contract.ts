import {
  defineCommand,
  defineEvent,
  mcpServerIdSchema,
  personaIdSchema,
} from "@borg-agent/contracts";
import { z } from "zod";

export const MCP_APP_MAX_MESSAGE_BYTES = 256 * 1024;

export const mcpServerStatusSchema = z.enum([
  "idle",
  "connecting",
  "ready",
  "degraded",
  "failed",
  "closed",
]);

export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerSnapshotSchema = z
  .object({
    id: mcpServerIdSchema,
    status: mcpServerStatusSchema,
    toolCount: z.number().int().nonnegative(),
    toolIds: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/),
      )
      .max(10_000)
      .default([]),
    error: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export const mcpListServers = defineCommand({
  id: "borg.mcp.listServers",
  input: z
    .object({
      personaId: personaIdSchema.optional(),
    })
    .strict(),
  output: z
    .object({ servers: z.array(mcpServerSnapshotSchema).max(64) })
    .strict(),
});

export const mcpGetStatus = defineCommand({
  id: "borg.mcp.getStatus",
  input: z
    .object({
      serverId: mcpServerIdSchema,
      personaId: personaIdSchema.optional(),
    })
    .strict(),
  output: mcpServerSnapshotSchema,
});

export const mcpRefresh = defineCommand({
  id: "borg.mcp.refresh",
  input: z
    .object({
      serverId: mcpServerIdSchema.optional(),
      personaId: personaIdSchema.optional(),
    })
    .strict(),
  output: z
    .object({ servers: z.array(mcpServerSnapshotSchema).max(64) })
    .strict(),
});

export const mcpAppCspSchema = z
  .object({
    resourceDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
    connectDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
    frameDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
    baseUriDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
  })
  .strict();

export type McpAppCsp = z.infer<typeof mcpAppCspSchema>;

export const mcpAppPermissionsSchema = z
  .object({
    camera: z.boolean().default(false),
    microphone: z.boolean().default(false),
    geolocation: z.boolean().default(false),
    clipboardWrite: z.boolean().default(false),
  })
  .strict();

export type McpAppPermissions = z.infer<typeof mcpAppPermissionsSchema>;

export const mcpAppToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    toolId: z
      .string()
      .max(512)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/),
    description: z.string().max(10_000),
    inputSchema: z.json(),
  })
  .strict();

export type McpAppTool = z.infer<typeof mcpAppToolSchema>;

export const mcpAppDiscovered = defineEvent({
  id: "borg.mcp.appDiscovered",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      personaId: personaIdSchema,
      appInstanceId: z.string().uuid(),
      serverId: mcpServerIdSchema,
      resourceUri: z.string().min(6).max(2_048).startsWith("ui://"),
      html: z.string().max(2 * 1024 * 1024),
      csp: mcpAppCspSchema,
      permissions: mcpAppPermissionsSchema,
      tools: z.array(mcpAppToolSchema).max(256),
      sourceToolId: z.string().min(1).max(512),
      sourceToolName: z.string().min(1).max(256),
      toolInput: z.json(),
      callResult: z.json(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime(),
      discoveredAt: z.string().datetime(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new TextEncoder().encode(value.html).byteLength >
        2 * 1024 * 1024
      ) {
        context.addIssue({
          code: "custom",
          path: ["html"],
          message: "MCP App HTML exceeds the size cap",
        });
      }
      const payloads = [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: value.toolInput },
        },
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: value.callResult,
        },
        {
          jsonrpc: "2.0",
          id: "x".repeat(256),
          result: {
            tools: value.tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        },
      ];
      if (
        payloads.some(
          (payload) =>
            new TextEncoder().encode(JSON.stringify(payload)).byteLength >
            MCP_APP_MAX_MESSAGE_BYTES,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "MCP App bridge payload exceeds the size cap",
        });
      }
    }),
});

export type McpAppDiscovered = z.infer<typeof mcpAppDiscovered.payload>;

export const mcpAppSnapshotSchema = mcpAppDiscovered.payload
  .extend({
    version: z.literal(1),
  })
  .strict();

export type McpAppSnapshot = z.infer<typeof mcpAppSnapshotSchema>;
