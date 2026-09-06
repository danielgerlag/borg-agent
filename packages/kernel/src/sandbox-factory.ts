import type {
  SandboxRunInput,
  SandboxRunResult,
} from "@borg/plugin-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type { SandboxKind, SandboxRunInput, SandboxRunResult } from "@borg/plugin-sdk";

export type SandboxProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<SandboxRunResult>;

export interface SandboxFactoryOptions {
  readonly runProcess?: SandboxProcessRunner;
  readonly nodeExecutable?: string;
  readonly uvExecutable?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const UNIX_INHERITED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
const WINDOWS_INHERITED_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
] as const;

export class SandboxFactory {
  readonly #runProcess: SandboxProcessRunner;
  readonly #nodeExecutable: string;
  readonly #uvExecutable: string;

  constructor(options: SandboxFactoryOptions = {}) {
    this.#runProcess = options.runProcess ?? defaultRunProcess;
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#uvExecutable = options.uvExecutable ?? "uv";
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const root = await resolveSandboxRoot(input.root);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Sandbox timeout is invalid");
    }
    input.signal?.throwIfAborted();
    const env = inheritedEnvironment();
    if (input.kind === "os") {
      const argv = input.argv;
      if (!argv || argv.length === 0) {
        throw new Error("OS sandbox requires argv");
      }
      const command = resolveOsCommand(root, argv[0]!);
      return this.#runProcess(command, argv.slice(1), {
        cwd: root,
        env,
        timeoutMs,
        signal: input.signal,
      });
    }
    if (input.source === undefined || input.source.length === 0) {
      throw new Error(`${input.kind} sandbox requires source`);
    }
    const filename = path.join(
      root,
      input.kind === "node"
        ? `.borg-sandbox-${randomUUID()}.mjs`
        : `.borg-sandbox-${randomUUID()}.py`,
    );
    await writeFile(filename, input.source, { encoding: "utf8", flag: "wx" });
    try {
      if (input.kind === "node") {
        return await this.#runProcess(
          this.#nodeExecutable,
          nodePermissionArgs(root, filename),
          {
            cwd: root,
            env,
            timeoutMs,
            signal: input.signal,
          },
        );
      }
      return await this.#runProcess(
        this.#uvExecutable,
        ["run", "--directory", root, "python", filename],
        {
          cwd: root,
          env,
          timeoutMs,
          signal: input.signal,
        },
      );
    } finally {
      await unlink(filename).catch(() => undefined);
    }
  }
}

async function resolveSandboxRoot(root: string): Promise<string> {
  if (root.length === 0 || root.includes("\0")) {
    throw new Error("Sandbox root is invalid");
  }
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Sandbox root must be a real directory");
  }
  return realpath(root);
}

function resolveOsCommand(root: string, command: string): string {
  if (command.length === 0 || command.includes("\0")) {
    throw new Error("Sandbox command is invalid");
  }
  if (command.includes("/") || command.includes("\\")) {
    const resolved = path.resolve(root, command);
    const relative = path.relative(root, resolved);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Sandbox command escapes the sandbox root");
    }
    return resolved;
  }
  return command;
}

function nodePermissionArgs(root: string, script: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${root}`,
    `--allow-fs-write=${root}`,
    script,
  ];
}

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const keys =
    process.platform === "win32"
      ? WINDOWS_INHERITED_ENV_KEYS
      : UNIX_INHERITED_ENV_KEYS;
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && !value.includes("\0")) {
      env[key] = value;
    }
  }
  return env;
}

function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<SandboxRunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = (error: Error | undefined, exitCode: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    const kill = (): void => {
      killProcess(child);
    };
    const onAbort = (): void => {
      kill();
      finish(abortReason(options.signal), 1);
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error("Sandbox run timed out"), 1);
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    child.once("error", (error) => {
      finish(error, 1);
    });
    child.once("exit", (code) => {
      finish(undefined, code ?? 1);
    });
  });
}

function killProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited between the check and kill.
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new Error("Sandbox run aborted");
}
