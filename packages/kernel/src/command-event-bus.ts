import {
  isKernelOnlyEvent,
  type BusEnvelope,
  type CommandDefinition,
  type CommandInput,
  type CommandOutput,
  type EventDefinition,
  type EventPayload,
} from "@borg/contracts";
import type { Disposable } from "@borg/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { CommandInvocationError } from "./errors";

interface CommandHandlerRecord {
  readonly pluginId: string;
  readonly command: CommandDefinition;
  readonly handler: (
    input: unknown,
    signal: AbortSignal,
    envelope: BusEnvelope,
  ) => unknown | Promise<unknown>;
}

interface EventSubscriberRecord {
  readonly pluginId: string;
  readonly handler: (
    payload: unknown,
    envelope: BusEnvelope,
  ) => void | Promise<void>;
}

interface CorrelationContext {
  readonly correlationId: string;
  readonly operationId: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CommandEventBus {
  readonly #commandHandlers = new Map<string, CommandHandlerRecord>();
  readonly #eventSubscribers = new Map<string, Map<symbol, EventSubscriberRecord>>();
  readonly #correlationContext = new AsyncLocalStorage<CorrelationContext>();

  handle<TCommand extends CommandDefinition>(
    pluginId: string,
    declaredCommandIds: ReadonlySet<string>,
    command: TCommand,
    handler: (
      input: CommandInput<TCommand>,
      signal: AbortSignal,
      envelope: BusEnvelope,
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
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly source?: BusEnvelope["source"] | undefined;
    },
  ): Promise<CommandOutput<TCommand>> {
    return (await this.invokeById(
      command.id,
      input,
      options,
    )) as CommandOutput<TCommand>;
  }

  async invokeById(
    commandId: string,
    input: unknown,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly source?: BusEnvelope["source"] | undefined;
    },
  ): Promise<unknown> {
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
    if (options?.signal?.aborted) {
      throw new CommandInvocationError(
        "failed",
        `Command ${commandId} was cancelled`,
        { cause: options.signal.reason },
      );
    }
    const timeoutMs = record.command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const parent = this.#correlationContext.getStore();
    const envelope: BusEnvelope = Object.freeze({
      correlationId: parent?.correlationId ?? randomUUID(),
      causationId: parent?.operationId,
      source: Object.freeze(
        options?.source ?? { kind: "kernel" as const, id: "kernel" },
      ),
      timestamp: new Date().toISOString(),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeCancellationListener: (() => void) | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new CommandInvocationError(
          "timeout",
          `Command ${commandId} exceeded its ${timeoutMs}ms timeout`,
        );
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      if (!options?.signal) {
        return;
      }
      const onAbort = (): void => {
        const error = new CommandInvocationError(
          "failed",
          `Command ${commandId} was cancelled`,
          { cause: options.signal?.reason },
        );
        controller.abort(error);
        reject(error);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeCancellationListener = () =>
        options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) {
        onAbort();
      }
    });

    try {
      const result = await Promise.race([
        this.#correlationContext.run(
          {
            correlationId: envelope.correlationId,
            operationId: commandId,
          },
          () =>
            Promise.resolve(
              record.handler(parsedInput.data, controller.signal, envelope),
            ),
        ),
        timeout,
        cancellation,
      ]);
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof CommandInvocationError
          ? reason
          : new CommandInvocationError(
              "failed",
              `Command ${commandId} was cancelled`,
              { cause: reason },
            );
      }
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
      removeCancellationListener?.();
    }
  }

  provides(command: CommandDefinition | string): boolean {
    return this.#commandHandlers.has(typeof command === "string" ? command : command.id);
  }

  on<TEvent extends EventDefinition>(
    pluginId: string,
    event: TEvent,
    handler: (
      payload: EventPayload<TEvent>,
      envelope: BusEnvelope,
    ) => void | Promise<void>,
  ): Disposable {
    return this.onById(
      pluginId,
      event.id,
      handler as (
        payload: unknown,
        envelope: BusEnvelope,
      ) => void | Promise<void>,
    );
  }

  onById(
    pluginId: string,
    eventId: string,
    handler: (
      payload: unknown,
      envelope: BusEnvelope,
    ) => void | Promise<void>,
  ): Disposable {
    const token = Symbol(eventId);
    const subscribers = this.#eventSubscribers.get(eventId) ?? new Map();
    subscribers.set(token, {
      pluginId,
      handler,
    });
    this.#eventSubscribers.set(eventId, subscribers);

    return {
      dispose: () => {
        subscribers.delete(token);
        if (subscribers.size === 0) {
          this.#eventSubscribers.delete(eventId);
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
    if (isKernelOnlyEvent(event.id)) {
      throw new Error(`Event ${event.id} is reserved for kernel emission`);
    }
    if (!declaredEventIds.has(event.id)) {
      throw new Error(`Plugin ${pluginId} did not declare event ${event.id}`);
    }

    await this.#publish(event, payload, { kind: "plugin", id: pluginId });
  }

  async emitKernel<TEvent extends EventDefinition>(
    event: TEvent,
    payload: EventPayload<TEvent>,
  ): Promise<void> {
    await this.#publish(event, payload, { kind: "kernel", id: "kernel" });
  }

  async #publish<TEvent extends EventDefinition>(
    event: TEvent,
    payload: EventPayload<TEvent>,
    source: BusEnvelope["source"],
  ): Promise<void> {
    const parsedPayload = event.payload.safeParse(payload);
    if (!parsedPayload.success) {
      throw new Error(`Payload for event ${event.id} did not match its contract`, {
        cause: parsedPayload.error,
      });
    }

    const subscribers = [...(this.#eventSubscribers.get(event.id)?.values() ?? [])];
    const parent = this.#correlationContext.getStore();
    const envelope: BusEnvelope = Object.freeze({
      correlationId: parent?.correlationId ?? randomUUID(),
      causationId: parent?.operationId,
      source: Object.freeze({ ...source }),
      timestamp: new Date().toISOString(),
    });
    await Promise.allSettled(
      subscribers.map(async (subscriber) =>
        this.#correlationContext.run(
          {
            correlationId: envelope.correlationId,
            operationId: event.id,
          },
          () => subscriber.handler(parsedPayload.data, envelope),
        ),
      ),
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
