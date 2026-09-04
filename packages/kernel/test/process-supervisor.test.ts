import { spawn, type SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessSupervisor } from "../src";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ProcessSupervisor", () => {
  const supervisors: ProcessSupervisor[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      supervisors.splice(0).map((supervisor) => supervisor.shutdown()),
    );
  });

  function createSupervisor(): ProcessSupervisor {
    const supervisor = new ProcessSupervisor();
    supervisors.push(supervisor);
    return supervisor;
  }

  it("round-trips stdin bytes through an echo fixture", async () => {
    const supervisor = createSupervisor();
    const child = await supervisor.spawn(
      "test.echo",
      process.execPath,
      [
        "-e",
        "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(0));",
      ],
    );

    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode("hello-bytes"));
    await writer.close();

    await expect(readAll(child.stdout).then((bytes) => decoder.decode(bytes))).resolves.toBe(
      "hello-bytes",
    );
    await expect(child.exit).resolves.toMatchObject({ code: 0 });
  });

  it("spawns without a shell", async () => {
    const spawnImpl = vi.fn(
      (command: string, args: readonly string[], options: SpawnOptions) =>
        spawn(command, [...args], options),
    );
    const supervisor = new ProcessSupervisor({
      spawn: spawnImpl as unknown as typeof spawn,
    });
    supervisors.push(supervisor);
    const child = await supervisor.spawn(
      "test.shell",
      process.execPath,
      ["-e", "process.exit(0)"],
    );
    await child.exit;
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["-e", "process.exit(0)"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("inherits a safe environment and overlays explicit values", async () => {
    const supervisor = createSupervisor();
    const previous = process.env.BORG_TEST_SECRET_ENV;
    process.env.BORG_TEST_SECRET_ENV = "should-not-inherit";
    try {
      const child = await supervisor.spawn(
        "test.env",
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        {
          env: {
            CUSTOM_FLAG: "1",
            PATH: "/custom/bin",
          },
        },
      );
      const env = JSON.parse(decoder.decode(await readAll(child.stdout))) as Record<
        string,
        string
      >;
      await child.exit;
      expect(env.CUSTOM_FLAG).toBe("1");
      expect(env.PATH).toBe("/custom/bin");
      expect(env.BORG_TEST_SECRET_ENV).toBeUndefined();
      if (process.platform === "win32") {
        if (process.env.USERPROFILE) {
          expect(env.USERPROFILE ?? env.UserProfile).toBe(process.env.USERPROFILE);
        }
      } else if (process.env.HOME) {
        expect(env.HOME).toBe(process.env.HOME);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.BORG_TEST_SECRET_ENV;
      } else {
        process.env.BORG_TEST_SECRET_ENV = previous;
      }
    }
  });

  it("rejects NUL bytes and invalid environment keys without echoing values", async () => {
    const supervisor = createSupervisor();
    await expect(
      supervisor.spawn("test.env", process.execPath, ["-e", "process.exit(0)"], {
        env: { "BAD=NAME": "1" },
      }),
    ).rejects.toThrow(/Environment variable name is invalid/);
    const nulValue = "secret\0value";
    await expect(
      supervisor.spawn("test.env", process.execPath, ["-e", "process.exit(0)"], {
        env: { CUSTOM: nulValue },
      }),
    ).rejects.toThrow(/Environment variable value is invalid/);
    try {
      await supervisor.spawn("test.env", process.execPath, ["-e", "process.exit(0)"], {
        env: { CUSTOM: nulValue },
      });
      throw new Error("expected invalid environment to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret");
      expect(message).not.toContain(nulValue);
    }
  });

  it("reaps a child when abort or close is requested", async () => {
    const supervisor = createSupervisor();
    const abort = new AbortController();
    const aborted = await supervisor.spawn(
      "test.abort",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { signal: abort.signal, graceTimeoutMs: 50 },
    );
    expect(isAlive(aborted.pid)).toBe(true);
    abort.abort(new Error("caller cancelled"));
    await aborted.exit;
    expect(isAlive(aborted.pid)).toBe(false);

    const closed = await supervisor.spawn(
      "test.close",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { graceTimeoutMs: 50 },
    );
    expect(isAlive(closed.pid)).toBe(true);
    await closed.close();
    await closed.close();
    await expect(closed.exit).resolves.toEqual(expect.anything());
    expect(isAlive(closed.pid)).toBe(false);
  });

  it("escalates an ignored SIGTERM to SIGKILL", async () => {
    if (process.platform === "win32") {
      return;
    }
    const supervisor = createSupervisor();
    const child = await supervisor.spawn(
      "test.term",
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { graceTimeoutMs: 40 },
    );
    const ready = decoder.decode(await readFirst(child.stdout));
    expect(ready).toBe("ready");
    const startedAt = Date.now();
    await child.close();
    const result = await child.exit;
    expect(result.signal).toBe("SIGKILL");
    expect(isAlive(child.pid)).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it("closes and reaps when stdin is backpressured", async () => {
    const supervisor = createSupervisor();
    const graceTimeoutMs = 80;
    const child = await supervisor.spawn(
      "test.backpressure",
      process.execPath,
      [
        "-e",
        "process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { graceTimeoutMs },
    );
    expect(decoder.decode(await readFirst(child.stdout))).toBe("ready");
    const writer = child.stdin.getWriter();
    const chunk = new Uint8Array(64 * 1024);
    let backpressured = false;
    for (let index = 0; index < 64; index += 1) {
      const write = writer.write(chunk);
      const state = await Promise.race([
        write.then(() => "drained" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 15);
        }),
      ]);
      if (state === "pending") {
        backpressured = true;
        break;
      }
    }
    expect(backpressured).toBe(true);
    const startedAt = Date.now();
    await child.close();
    expect(Date.now() - startedAt).toBeLessThan(graceTimeoutMs + 50);
    await child.exit;
    expect(isAlive(child.pid)).toBe(false);
  });

  it("rejects a spawn error", async () => {
    const supervisor = createSupervisor();
    await expect(
      supervisor.spawn(
        "test.missing",
        `${process.execPath}-missing-borg-binary`,
        [],
      ),
    ).rejects.toThrow(/spawn|ENOENT/i);
  });

  it("leaves another plugin child alive after owned cleanup", async () => {
    const supervisor = createSupervisor();
    const first = await supervisor.spawn(
      "test.first",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { graceTimeoutMs: 50 },
    );
    const second = await supervisor.spawn(
      "test.second",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { graceTimeoutMs: 50 },
    );
    await supervisor.abortOwned("test.first");
    expect(isAlive(first.pid)).toBe(false);
    expect(isAlive(second.pid)).toBe(true);
    await supervisor.abortOwned("test.second");
    expect(isAlive(second.pid)).toBe(false);
  });
});

async function readFirst(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value ?? new Uint8Array();
}
