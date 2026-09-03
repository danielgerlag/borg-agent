import type {
  CommandDefinition,
  CommandInput,
  CommandOutput,
  EventDefinition,
  EventPayload,
} from "@borg/contracts";
import type { Disposable } from "@borg/plugin-sdk";
import { CommandInvocationError } from "./errors";

interface CommandHandlerRecord {
  readonly pluginId: string;
  readonly command: CommandDefinition;
  readonly handler: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
}

interface EventSubscriberRecord {
  readonly pluginId: string;
  readonly handler: (payload: unknown) => void | Promise<void>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CommandEventBus {
  readonly #commandHandlers = new Map<string, CommandHandlerRecord>();
  readonly #eventSubscribers = new Map<string, Map<symbol, EventSubscriberRecord>>();

  handle<TCommand extends CommandDefinition>(
    pluginId: string,
    declaredCommandIds: ReadonlySet<string>,
    command: TCommand,
    handler: (
      input: CommandInput<TCommand>,
      signal: AbortSignal,
    ) => CommandOutput<TCommand> | Promise<CommandOutput<TCommand>>,
  ): Disposable {
    if (!declaredCommandIds.has(command.id)) {
      throw new Error(`Plugin ${pluginId} did not declare command ${command.id}`);
    }

    const existing = this.#commandHandlers.get(command.id);
    if (existing) {
      throw new Error(
        `Command ${command.id} is already handled by ${existing.pluginId}; duplicate owner ${pluginId}`,
      );
    }

    const record: CommandHandlerRecord = {
      pluginId,
      command,
      handler: handler as CommandHandlerRecord["handler"],
    };
    this.#commandHandlers.set(command.id, record);

    return {
      dispose: () => {
        if (this.#commandHandlers.get(command.id) === record) {
          this.#commandHandlers.delete(command.id);
        }
      },
    };
  }

  async invoke<TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
  ): Promise<CommandOutput<TCommand>> {
    return (await this.invokeById(command.id, input)) as CommandOutput<TCommand>;
  }

  async invokeById(commandId: string, input: unknown): Promise<unknown> {
    const record = this.#commandHandlers.get(commandId);
    if (!record) {
      throw new CommandInvocationError(
        "unavailable",
        `No active plugin handles command ${commandId}`,
      );
    }

    const parsedInput = record.command.input.safeParse(input);
    if (!parsedInput.success) {
      throw new CommandInvocationError(
        "invalid_input",
        `Input for command ${commandId} did not match its contract`,
        { cause: parsedInput.error },
      );
    }

    const controller = new AbortController();
    const timeoutMs = record.command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new CommandInvocationError(
          "timeout",
          `Command ${commandId} exceeded its ${timeoutMs}ms timeout`,
        );
        reject(timeoutError);
        controller.abort(timeoutError);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        Promise.resolve(record.handler(parsedInput.data, controller.signal)),
        timeout,
      ]);
      const parsedOutput = record.command.output.safeParse(result);
      if (!parsedOutput.success) {
        throw new CommandInvocationError(
          "invalid_output",
          `Output for command ${commandId} did not match its contract`,
          { cause: parsedOutput.error },
        );
      }
      return parsedOutput.data;
    } catch (error) {
      if (error instanceof CommandInvocationError) {
        throw error;
      }
      throw new CommandInvocationError("failed", `Command ${commandId} failed`, {
        cause: error,
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  provides(command: CommandDefinition | string): boolean {
    return this.#commandHandlers.has(typeof command === "string" ? command : command.id);
  }

  on<TEvent extends EventDefinition>(
    pluginId: string,
    event: TEvent,
    handler: (payload: EventPayload<TEvent>) => void | Promise<void>,
  ): Disposable {
    const token = Symbol(event.id);
    const subscribers = this.#eventSubscribers.get(event.id) ?? new Map();
    subscribers.set(token, {
      pluginId,
      handler: handler as EventSubscriberRecord["handler"],
    });
    this.#eventSubscribers.set(event.id, subscribers);

    return {
      dispose: () => {
        subscribers.delete(token);
        if (subscribers.size === 0) {
          this.#eventSubscribers.delete(event.id);
        }
      },
    };
  }

  async emit<TEvent extends EventDefinition>(
    pluginId: string,
    declaredEventIds: ReadonlySet<string>,
    event: TEvent,
    payload: EventPayload<TEvent>,
  ): Promise<void> {
    if (!declaredEventIds.has(event.id)) {
      throw new Error(`Plugin ${pluginId} did not declare event ${event.id}`);
    }

    const parsedPayload = event.payload.safeParse(payload);
    if (!parsedPayload.success) {
      throw new Error(`Payload for event ${event.id} did not match its contract`, {
        cause: parsedPayload.error,
      });
    }

    const subscribers = [...(this.#eventSubscribers.get(event.id)?.values() ?? [])];
    await Promise.allSettled(
      subscribers.map(async (subscriber) => subscriber.handler(parsedPayload.data)),
    );
  }

  removePlugin(pluginId: string): void {
    for (const [commandId, handler] of this.#commandHandlers) {
      if (handler.pluginId === pluginId) {
        this.#commandHandlers.delete(commandId);
      }
    }

    for (const [eventId, subscribers] of this.#eventSubscribers) {
      for (const [token, subscriber] of subscribers) {
        if (subscriber.pluginId === pluginId) {
          subscribers.delete(token);
        }
      }
      if (subscribers.size === 0) {
        this.#eventSubscribers.delete(eventId);
      }
    }
  }
}
