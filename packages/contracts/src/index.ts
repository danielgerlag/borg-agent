import { z } from "zod";

export type CommandErrorCode =
  | "unavailable"
  | "invalid_input"
  | "invalid_output"
  | "forbidden"
  | "timeout"
  | "failed";

export interface CommandDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly timeoutMs?: number;
}

export interface EventDefinition<TPayload extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly payload: TPayload;
}

export type CommandInput<TCommand extends CommandDefinition> = z.input<TCommand["input"]>;
export type CommandOutput<TCommand extends CommandDefinition> = z.output<TCommand["output"]>;
export type EventPayload<TEvent extends EventDefinition> = z.output<TEvent["payload"]>;

export function defineCommand<
  const TInput extends z.ZodType,
  const TOutput extends z.ZodType,
>(definition: CommandDefinition<TInput, TOutput>): CommandDefinition<TInput, TOutput> {
  return Object.freeze(definition);
}

export function defineEvent<const TPayload extends z.ZodType>(
  definition: EventDefinition<TPayload>,
): EventDefinition<TPayload> {
  return Object.freeze(definition);
}

export const commandErrorCodeSchema = z.enum([
  "unavailable",
  "invalid_input",
  "invalid_output",
  "forbidden",
  "timeout",
  "failed",
]);

export const commandErrorSchema = z.object({
  code: commandErrorCodeSchema,
  message: z.string(),
});

export type CommandErrorShape = z.infer<typeof commandErrorSchema>;

export const helloGetStatus = defineCommand({
  id: "borg.hello.getStatus",
  input: z.object({}).strict(),
  output: z.object({
    pluginId: z.string(),
    kernelVersion: z.string(),
    status: z.literal("alive"),
    message: z.string(),
    startedAt: z.string().datetime(),
    now: z.string().datetime(),
  }),
});
