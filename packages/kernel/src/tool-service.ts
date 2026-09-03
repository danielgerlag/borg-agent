import {
  z,
  type Disposable,
  type JsonValue,
  type ToolContribution,
} from "@borg/plugin-sdk";
import type { InteractionResponse } from "@borg/contracts";
import { randomUUID } from "node:crypto";
import { InteractionService } from "./interaction-service";

interface RegisteredTool {
  readonly pluginId: string;
  readonly tool: ToolContribution;
  readonly inputSchema: JsonValue;
  readonly controller: AbortController;
}

interface RunToolPolicy {
  readonly ownerPluginId: string;
  readonly allowedTools: readonly string[];
  readonly controller: AbortController;
}

export class ToolInvocationError extends Error {
  constructor(
    readonly code: "unavailable" | "forbidden" | "denied" | "invalid" | "failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolInvocationError";
  }
}

export interface ToolInvocationOptions {
  readonly callerPluginId: string;
  readonly toolCallId?: string | undefined;
  readonly runId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  onInteraction?(interactionId: string): void;
}

function isAllowed(toolId: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") {
      return true;
    }
    if (pattern.endsWith("*")) {
      return toolId.startsWith(pattern.slice(0, -1));
    }
    return toolId === pattern;
  });
}

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(asJsonValue));
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
      ),
    );
  }
  throw new ToolInvocationError(
    "invalid",
    "Tool output is not JSON-serializable",
  );
}

export class ToolService {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #runPolicies = new Map<string, RunToolPolicy>();

  constructor(readonly interactions: InteractionService) {}

  register(pluginId: string, tool: ToolContribution): Disposable {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(tool.id) ||
      tool.description.trim().length === 0 ||
      !["auto", "ask", "deny"].includes(tool.approval) ||
      typeof tool.sideEffect !== "boolean" ||
      typeof tool.input?.safeParse !== "function" ||
      typeof tool.output?.safeParse !== "function" ||
      typeof tool.execute !== "function"
    ) {
      throw new Error(`Invalid tool contribution ${tool.id}`);
    }
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool ${tool.id} is already registered`);
    }
    const toolId = tool.id;
    const inputSchema = asJsonValue(z.toJSONSchema(tool.input));
    const registeredTool: ToolContribution = Object.freeze({
      id: tool.id,
      description: tool.description,
      input: tool.input,
      output: tool.output,
      approval: tool.approval,
      sideEffect: tool.sideEffect,
      execute: tool.execute.bind(tool),
    });
    const registration = {
      pluginId,
      tool: registeredTool,
      inputSchema,
      controller: new AbortController(),
    };
    this.#tools.set(toolId, registration);
    return {
      dispose: () => {
        if (this.#tools.get(toolId) === registration) {
          this.#tools.delete(toolId);
          registration.controller.abort(
            new Error(`Tool ${toolId} was unregistered`),
          );
        }
      },
    };
  }

  registerRunPolicy(
    runId: string,
    ownerPluginId: string,
    allowedTools: readonly string[],
  ): Disposable {
    if (this.#runPolicies.has(runId)) {
      throw new Error(`Tool policy for run ${runId} is already registered`);
    }
    const policy = {
      ownerPluginId,
      allowedTools: Object.freeze([...allowedTools]),
      controller: new AbortController(),
    };
    this.#runPolicies.set(runId, policy);
    return {
      dispose: () => {
        if (this.#runPolicies.get(runId) === policy) {
          this.#runPolicies.delete(runId);
          policy.controller.abort(
            new Error(`Tool policy for run ${runId} was released`),
          );
        }
      },
    };
  }

  removePlugin(pluginId: string): void {
    for (const [toolId, registration] of this.#tools) {
      if (registration.pluginId === pluginId) {
        this.#tools.delete(toolId);
        registration.controller.abort(
          new Error(`Plugin ${pluginId} was deactivated`),
        );
      }
    }
  }

  getProviderPluginId(toolId: string): string | undefined {
    return this.#tools.get(toolId)?.pluginId;
  }

  listDefinitions(allowedTools: readonly string[] = ["*"]): readonly {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
  }[] {
    return [...this.#tools.values()]
      .filter(({ tool }) => isAllowed(tool.id, allowedTools))
      .map(({ tool, inputSchema }) => ({
        id: tool.id,
        description: tool.description,
        inputSchema,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  has(toolId: string): boolean {
    return this.#tools.has(toolId);
  }

  async invoke(
    toolId: string,
    candidateInput: unknown,
    options: ToolInvocationOptions,
  ): Promise<JsonValue> {
    options.signal?.throwIfAborted();
    const registration = this.#tools.get(toolId);
    if (!registration) {
      throw new ToolInvocationError("unavailable", `Tool ${toolId} is unavailable`);
    }
    const runPolicy = options.runId
      ? this.#runPolicies.get(options.runId)
      : undefined;
    if (
      options.runId &&
      (!runPolicy || runPolicy.ownerPluginId !== options.callerPluginId)
    ) {
      throw new ToolInvocationError(
        "forbidden",
        `Tool policy for run ${options.runId} is unavailable to ${options.callerPluginId}`,
      );
    }
    const allowedTools = runPolicy?.allowedTools ?? ["*"];
    if (!isAllowed(toolId, allowedTools)) {
      throw new ToolInvocationError(
        "forbidden",
        `Tool ${toolId} is not allowed for this run`,
      );
    }
    if (registration.tool.approval === "deny") {
      throw new ToolInvocationError("denied", `Tool ${toolId} is denied by policy`);
    }
    const invocationSignal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      registration.controller.signal,
      ...(runPolicy ? [runPolicy.controller.signal] : []),
    ]);
    invocationSignal.throwIfAborted();

    const parsedInput = registration.tool.input.safeParse(candidateInput);
    if (!parsedInput.success) {
      throw new ToolInvocationError("invalid", `Tool ${toolId} input is invalid`, {
        cause: parsedInput.error,
      });
    }
    const jsonInput = asJsonValue(parsedInput.data);

    const toolCallId = options.toolCallId ?? randomUUID();
    if (registration.tool.approval === "ask") {
      const wait = this.interactions.requestSafety(
        {
          kind: "tool_approval",
          title: `Approve ${toolId}`,
          prompt: `Allow ${toolId} to run for this request?`,
          source: {
            pluginId: options.callerPluginId,
            feature: "tool",
            runId: options.runId,
            toolCallId,
          },
        },
        invocationSignal,
      );
      options.onInteraction?.(wait.interaction.id);
      let response: InteractionResponse;
      try {
        response = await wait.response;
      } catch (error) {
        if (this.#tools.get(toolId) !== registration) {
          throw new ToolInvocationError(
            "unavailable",
            `Tool ${toolId} is no longer available`,
            { cause: error },
          );
        }
        if (
          options.runId &&
          this.#runPolicies.get(options.runId) !== runPolicy
        ) {
          throw new ToolInvocationError(
            "forbidden",
            `Tool policy for run ${options.runId} is no longer active`,
            { cause: error },
          );
        }
        throw error;
      }
      if (response.kind !== "approval" || response.decision !== "allow") {
        throw new ToolInvocationError("denied", `Tool ${toolId} was denied`);
      }
    }
    invocationSignal.throwIfAborted();
    if (
      this.#tools.get(toolId) !== registration ||
      (options.runId &&
        this.#runPolicies.get(options.runId) !== runPolicy)
    ) {
      throw new ToolInvocationError(
        "unavailable",
        `Tool ${toolId} is no longer available`,
      );
    }

    try {
      const result = await registration.tool.execute(jsonInput, {
        toolCallId,
        runId: options.runId,
        signal: invocationSignal,
      });
      if (
        this.#tools.get(toolId) !== registration ||
        (options.runId &&
          this.#runPolicies.get(options.runId) !== runPolicy)
      ) {
        throw new ToolInvocationError(
          "unavailable",
          `Tool ${toolId} is no longer available`,
        );
      }
      invocationSignal.throwIfAborted();
      const parsedOutput = registration.tool.output.safeParse(result);
      if (!parsedOutput.success) {
        throw new ToolInvocationError(
          "invalid",
          `Tool ${toolId} output is invalid`,
          { cause: parsedOutput.error },
        );
      }
      return asJsonValue(parsedOutput.data);
    } catch (error) {
      if (error instanceof ToolInvocationError) {
        throw error;
      }
      throw new ToolInvocationError("failed", `Tool ${toolId} failed`, {
        cause: error,
      });
    }
  }
}
