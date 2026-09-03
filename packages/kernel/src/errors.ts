import type { CommandErrorCode, CommandErrorShape } from "@borg/contracts";

export class CommandInvocationError extends Error implements CommandErrorShape {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandInvocationError";
    this.code = code;
  }

  toJSON(): CommandErrorShape {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

export class PluginLoadError extends Error {
  readonly pluginId: string;

  constructor(pluginId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginLoadError";
    this.pluginId = pluginId;
  }
}
