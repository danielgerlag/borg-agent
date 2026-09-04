import type {
  PluginProcess,
  PluginProcessExit,
  PluginProcessSpawnOptions,
} from "@borg/plugin-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

const DEFAULT_GRACE_TIMEOUT_MS = 1_000;
const FORCE_KILL_TIMEOUT_MS = 1_000;
const STDIN_CLOSE_TIMEOUT_MS = 25;

export interface ProcessSupervisorOptions {
  readonly spawn?: typeof spawn;
}

const UNIX_INHERITED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LANGUAGE",
] as const;

const WINDOWS_INHERITED_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "LANG",
  "LC_ALL",
] as const;

export class ProcessSupervisor {
  readonly #owned = new Map<string, Set<SupervisedProcess>>();
  readonly #spawn: typeof spawn;
  #stopped = false;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.#spawn = options.spawn ?? spawn;
  }

  async spawn(
    pluginId: string,
    command: string,
    args: readonly string[],
    options: PluginProcessSpawnOptions = {},
  ): Promise<PluginProcess> {
    if (this.#stopped) {
      throw new Error("Process supervisor is shut down");
    }
    assertCommand(command);
    assertArgs(args);
    const graceTimeoutMs = options.graceTimeoutMs ?? DEFAULT_GRACE_TIMEOUT_MS;
    if (!Number.isFinite(graceTimeoutMs) || graceTimeoutMs < 0) {
      throw new Error("Process grace timeout is invalid");
    }
    if (
      options.cwd !== undefined &&
      (typeof options.cwd !== "string" ||
        options.cwd.length === 0 ||
        options.cwd.includes("\0"))
    ) {
      throw new Error("Process working directory is invalid");
    }
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }

    const env = inheritedEnvironment();
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        assertEnvEntry(key, value);
        assignEnv(env, key, value);
      }
    }

    const child = this.#spawn(command, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const abortDuringSpawn = (): void => {
      if (child.pid !== undefined) {
        try {
          child.kill("SIGKILL");
        } catch {
          if (!hasExited(child)) {
            console.error("[kernel] spawned child process could not be killed");
          }
        }
      }
    };
    options.signal?.addEventListener("abort", abortDuringSpawn, { once: true });
    try {
      await waitForSpawn(child);
    } catch (error) {
      throw sanitizeSpawnError(error);
    } finally {
      options.signal?.removeEventListener("abort", abortDuringSpawn);
    }

    if (options.signal?.aborted) {
      abortDuringSpawn();
      await waitForExit(child, graceTimeoutMs);
      throw abortReason(options.signal);
    }

    const pid = child.pid;
    if (
      pid === undefined ||
      !child.stdin ||
      !child.stdout ||
      !child.stderr
    ) {
      abortDuringSpawn();
      throw new Error("Child process stdio is unavailable");
    }

    const supervised = new SupervisedProcess(
      child,
      pid,
      graceTimeoutMs,
      options.signal,
      (handle) => this.#release(pluginId, handle),
    );
    let owned = this.#owned.get(pluginId);
    if (!owned) {
      owned = new Set();
      this.#owned.set(pluginId, owned);
    }
    owned.add(supervised);
    return supervised;
  }

  async abortOwned(pluginId: string): Promise<void> {
    const owned = this.#owned.get(pluginId);
    if (!owned) {
      return;
    }
    await Promise.allSettled(
      [...owned].map((child) => child.close()),
    );
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled(
      [...this.#owned.keys()].map((pluginId) => this.abortOwned(pluginId)),
    );
  }

  #release(pluginId: string, child: SupervisedProcess): void {
    const owned = this.#owned.get(pluginId);
    if (!owned) {
      return;
    }
    owned.delete(child);
    if (owned.size === 0) {
      this.#owned.delete(pluginId);
    }
  }
}

class SupervisedProcess implements PluginProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<PluginProcessExit>;
  readonly #child: ChildProcess;
  readonly #graceTimeoutMs: number;
  readonly #release: (handle: SupervisedProcess) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: (() => void) | undefined;
  #terminating: Promise<void> | undefined;
  #forceKill = false;
  #released = false;

  constructor(
    child: ChildProcess,
    pid: number,
    graceTimeoutMs: number,
    signal: AbortSignal | undefined,
    release: (handle: SupervisedProcess) => void,
  ) {
    this.#child = child;
    this.pid = pid;
    this.#graceTimeoutMs = graceTimeoutMs;
    this.#signal = signal;
    this.#release = release;
    this.stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    this.stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    this.stderr = Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>;
    this.exit = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({
          code: child.exitCode,
          signal: child.signalCode,
        });
        return;
      }
      child.once("exit", (code, childSignal) => {
        resolve({
          code,
          signal: childSignal,
        });
      });
    });
    void this.exit.finally(() => this.#detach());
    if (signal) {
      this.#onAbort = () => {
        void this.close();
      };
      signal.addEventListener("abort", this.#onAbort, { once: true });
      if (signal.aborted) {
        this.#onAbort();
      }
    }
  }

  close(): Promise<void> {
    this.#terminating ??= this.#terminate();
    return this.#terminating;
  }

  kill(): Promise<void> {
    this.#forceKill = true;
    if (this.#terminating) {
      this.#send("SIGKILL");
      return this.#terminating;
    }
    this.#terminating = this.#terminate();
    return this.#terminating;
  }

  dispose(): Promise<void> {
    return this.close();
  }

  async #terminate(): Promise<void> {
    const deadline = Date.now() + this.#graceTimeoutMs;
    await closeStdin(
      this.#child,
      Math.min(STDIN_CLOSE_TIMEOUT_MS, remainingMs(deadline)),
    );
    if (hasExited(this.#child) || this.#forceKill) {
      this.#send("SIGKILL");
      await this.#waitForExit(
        this.#forceKill ? FORCE_KILL_TIMEOUT_MS : remainingMs(deadline),
      );
      this.#detach();
      return;
    }
    this.#send("SIGTERM");
    if (await this.#waitForExit(remainingMs(deadline))) {
      this.#detach();
      return;
    }
    this.#send("SIGKILL");
    await this.#waitForExit(FORCE_KILL_TIMEOUT_MS);
    this.#detach();
  }

  #send(signal: NodeJS.Signals): void {
    if (hasExited(this.#child)) {
      return;
    }
    try {
      this.#child.kill(signal);
    } catch {
      if (!hasExited(this.#child)) {
        console.error("[kernel] child process signal failed");
      }
    }
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (hasExited(this.#child)) {
      return Promise.resolve(true);
    }
    if (timeoutMs === 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      this.#child.once("exit", onExit);
    });
  }

  #detach(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    if (this.#signal && this.#onAbort) {
      this.#signal.removeEventListener("abort", this.#onAbort);
    }
    this.#release(this);
  }
}

function inheritedEnvironment(): Record<string, string> {
  const keys =
    process.platform === "win32"
      ? WINDOWS_INHERITED_ENV_KEYS
      : UNIX_INHERITED_ENV_KEYS;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = lookupEnv(key);
    if (value !== undefined && !value.includes("\0")) {
      assignEnv(env, key, value);
    }
  }
  return env;
}

function lookupEnv(name: string): string | undefined {
  if (process.platform !== "win32") {
    const value = process.env[name];
    return typeof value === "string" ? value : undefined;
  }
  const match = Object.keys(process.env).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  if (match === undefined) {
    return undefined;
  }
  const value = process.env[match];
  return typeof value === "string" ? value : undefined;
}

function assignEnv(
  env: Record<string, string>,
  key: string,
  value: string,
): void {
  if (process.platform === "win32") {
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete env[existing];
      }
    }
  }
  env[key] = value;
}

function assertCommand(command: string): void {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("\0")
  ) {
    throw new Error("Process command is invalid");
  }
}

function assertArgs(args: readonly string[]): void {
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("Process arguments are invalid");
  }
}

function assertEnvEntry(key: string, value: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.includes("=") ||
    key.includes("\0")
  ) {
    throw new Error("Environment variable name is invalid");
  }
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Environment variable value is invalid");
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Process spawn was aborted");
}

function sanitizeSpawnError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(error.message);
  }
  return new Error("Process spawn failed");
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve();
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function closeStdin(child: ChildProcess, timeoutMs: number): Promise<void> {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    return Promise.resolve();
  }
  if (timeoutMs <= 0) {
    stdin.destroy();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("error", onError);
      resolve();
    };
    const onError = (): void => {
      finish();
    };
    const timer = setTimeout(() => {
      stdin.destroy();
      finish();
    }, timeoutMs);
    stdin.end(() => finish());
    stdin.once("error", onError);
  });
}
