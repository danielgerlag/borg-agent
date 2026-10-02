import {
  defineCommand,
  defineEvent,
  feedbackAnswerSchema,
  interactionChoiceSchema,
  interactionSourceSchema,
} from "@borg-agent/contracts";
import { z } from "zod";

export const feedbackAskInputSchema = z
  .object({
    title: z.string().min(1).optional(),
    prompt: z.string().min(1),
    form: z.enum(["text", "confirm", "choice"]),
    choices: z.array(interactionChoiceSchema).min(1).optional(),
    source: interactionSourceSchema.omit({ pluginId: true, feature: true }).default({}),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.choices &&
      new Set(value.choices.map(({ id }) => id)).size !== value.choices.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Feedback choice IDs must be unique",
      });
    }
    if (value.form === "choice" && !value.choices) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choice feedback requires choices",
      });
    }
    if (value.form !== "choice" && value.choices) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choices are only valid for choice feedback",
      });
    }
  });

export const feedbackAsk = defineCommand({
  id: "borg.feedback.ask",
  input: feedbackAskInputSchema,
  output: z.object({
    interactionId: z.string().uuid(),
    answer: feedbackAnswerSchema,
  }),
  timeoutMs: 86_405_000,
});

export const feedbackRequested = defineEvent({
  id: "borg.feedback.requested",
  payload: z.object({
    interactionId: z.string().uuid(),
    request: feedbackAskInputSchema,
  }),
});

export const feedbackResolved = defineEvent({
  id: "borg.feedback.resolved",
  payload: z.object({
    interactionId: z.string().uuid(),
    source: interactionSourceSchema,
    status: z.enum(["answered", "cancelled", "timed_out"]),
  }),
});
