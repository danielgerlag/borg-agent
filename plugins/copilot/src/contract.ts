import { defineCommand } from "@borg-agent/contracts";
import { z } from "zod";

export const copilotStatusSchema = z
  .object({
    hasToken: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type CopilotStatus = z.infer<typeof copilotStatusSchema>;

export const copilotGetStatus = defineCommand({
  id: "borg.copilot.getStatus",
  input: z.object({}).strict(),
  output: copilotStatusSchema,
});

export const copilotConnect = defineCommand({
  id: "borg.copilot.connect",
  input: z.object({}).strict(),
  output: copilotStatusSchema,
});

export const copilotDisconnect = defineCommand({
  id: "borg.copilot.disconnect",
  input: z.object({}).strict(),
  output: copilotStatusSchema,
});

export const copilotDeviceFlowStartSchema = z
  .object({
    userCode: z.string().min(1),
    verificationUri: z.string().min(1),
    interval: z.number().int().positive(),
    expiresIn: z.number().int().positive(),
  })
  .strict();

export type CopilotDeviceFlowStart = z.infer<
  typeof copilotDeviceFlowStartSchema
>;

export const copilotStartDeviceFlow = defineCommand({
  id: "borg.copilot.startDeviceFlow",
  input: z.object({}).strict(),
  output: copilotDeviceFlowStartSchema,
});

export const copilotDeviceFlowPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("complete") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.string().min(1).optional(),
    })
    .strict(),
]);

export type CopilotDeviceFlowPoll = z.infer<typeof copilotDeviceFlowPollSchema>;

export const copilotPollDeviceFlow = defineCommand({
  id: "borg.copilot.pollDeviceFlow",
  input: z.object({}).strict(),
  output: copilotDeviceFlowPollSchema,
});
