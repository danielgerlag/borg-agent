import {
  feedbackAsk,
  feedbackAskInputSchema,
  feedbackRequested,
  feedbackResolved,
} from "@borg/contracts";
import { definePlugin, defineTool, z } from "@borg/plugin-sdk";

const feedbackConfigSchema = z.object({
  defaultTimeoutMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
  notifyOnRequest: z.boolean().default(true),
  focusOnRequest: z.boolean().default(false),
});

export default definePlugin({
  id: "borg.feedback",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "interactions.read",
    "interactions.request:human_input",
    "notifications:send",
    "tools.register",
    "window.show",
    "ui.flightDeck",
    "ui.interactions",
    "ui.settings",
  ],
  contributes: {
    commands: [feedbackAsk.id],
    events: [feedbackRequested.id, feedbackResolved.id],
    kinds: ["tool", "interactionRenderer", "flightDeckWidget", "settingsPage"],
  },
  configSchema: feedbackConfigSchema,
  activate(context) {
    context.bus.handle(feedbackAsk, async (candidate, signal) => {
      const request = feedbackAskInputSchema.parse(candidate);
      const config = feedbackConfigSchema.parse(await context.config.get());
      const source = {
        pluginId: context.pluginId,
        feature: "feedback",
        ...request.source,
      };
      const wait = context.interactions.requestHumanInput(
        {
          ...request,
          timeoutMs: request.timeoutMs ?? config.defaultTimeoutMs,
        },
        signal,
      );
      void wait.response.catch(() => undefined);
      await context.bus.emit(feedbackRequested, {
        interactionId: wait.interactionId,
        request,
      });
      if (config.notifyOnRequest) {
        context.notify({
          title: "Input requested",
          body: "A Borg run is waiting for your response.",
          level: "info",
          os: true,
        });
      }
      if (config.focusOnRequest) {
        context.window.show();
      }
      try {
        const answer = await wait.response;
        await context.bus.emit(feedbackResolved, {
          interactionId: wait.interactionId,
          source,
          status: "answered",
        });
        return {
          interactionId: wait.interactionId,
          answer,
        };
      } catch (error) {
        await context.bus.emit(feedbackResolved, {
          interactionId: wait.interactionId,
          source,
          status:
            error instanceof Error && error.name === "InteractionTimedOutError"
              ? "timed_out"
              : "cancelled",
        });
        throw error;
      }
    });

    context.tools.register(
      defineTool({
        id: "feedback.ask",
        description: "Ask the user a text, confirmation, or choice question",
        input: feedbackAskInputSchema,
        output: z.object({
          interactionId: z.string().uuid(),
          answer: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("text"), text: z.string() }),
            z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }),
            z.object({
              kind: z.literal("choice"),
              choiceId: z.string(),
              text: z.string().optional(),
            }),
          ]),
        }),
        approval: "auto",
        sideEffect: false,
        execute: (input, execution) =>
          context.bus.invoke(feedbackAsk, {
            ...input,
            source: {
              ...input.source,
              runId: execution.runId ?? input.source.runId,
              toolCallId: execution.toolCallId,
            },
          }, {
            signal: execution.signal,
          }),
      }),
    );
  },
});
