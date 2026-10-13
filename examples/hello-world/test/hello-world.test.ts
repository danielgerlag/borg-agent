/**
 * Kernel tests for folder confinement, chat sessions, and assistant turns.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "@borg-agent/kernel";
import type { PendingInteraction } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHelloWorld } from "../src/boot.js";
import {
  connectModelMessage,
  deleteChatToolId,
  helloWorldAct,
  helloWorldAssistantId,
  helloWorldSnapshot,
  listToolInput,
  newChatToolId,
  openChatToolId,
  preferModelToolId,
  promptToolId,
  readToolInput,
  writeToolInput,
} from "../src/contract.js";
import { chatTitle, newChatTitle } from "../src/session.js";
import { FILE_QUESTION, helloWorldModelPreference, installHelloWorldFetch } from "./model-double.js";

let dataDirectory: string | undefined;
let kernel: Kernel | undefined;
let fetchDouble: ReturnType<typeof installHelloWorldFetch> | undefined;

beforeEach(() => {
  fetchDouble = installHelloWorldFetch();
});

afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
  fetchDouble?.restore();
  fetchDouble = undefined;
  if (dataDirectory) {
    await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  }
});

describe("hello world", () => {
  it("publishes object schemas for the folder tools", () => {
    for (const schema of [listToolInput, readToolInput, writeToolInput]) {
      expect(z.toJSONSchema(schema)).toMatchObject({ type: "object" });
    }
    expect(chatTitle(newChatTitle, ` ${"a".repeat(80)} `)).toBe("a".repeat(48));
    expect(chatTitle("Notes", "hello")).toBe("Notes");
  });

  it("boots Hello world without chat, bots, graphs, or the shell tools", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "hello-world-"));
    kernel = await startHelloWorld(dataDirectory);
    const ids = kernel.plugins.getActivePluginIds();
    expect(ids).toContain("example.hello-world");
    expect(ids).toContain("borg.feedback");
    expect(ids).toContain("borg.openai");
    expect(ids).not.toContain("borg.chat");
    expect(ids).not.toContain("borg.bots");
    expect(ids).not.toContain("borg.graphs");
    expect(ids).not.toContain("borg.tools.core");
    const opened = await kernel.bus.invoke(helloWorldSnapshot, {});
    expect(opened.chat.title).toBe(newChatTitle);
    expect(opened.persona.id).toBe(helloWorldAssistantId);
    expect(opened.files).toEqual([]);
    expect(opened.model).toBeNull();
    expect(opened.persona.allowedTools).toContain("example.hello-world.read");
    expect(opened.persona.allowedTools).toContain("example.hello-world.write");
    expect(opened.persona.allowedTools).not.toContain("shell.exec");
    expect(opened.persona.allowedTools).not.toContain("code.run");
  });

  it("creates, switches, and deletes chats", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "hello-world-"));
    kernel = await startHelloWorld(dataDirectory);
    const opened = await kernel.bus.invoke(helloWorldSnapshot, {});
    const created = await kernel.bus.invoke(helloWorldAct, { tool: newChatToolId });
    expect(created.effect.type).toBe("chat");
    expect(created.snapshot.chats).toHaveLength(2);
    expect(created.snapshot.chat.id).not.toBe(opened.chat.id);
    const back = await kernel.bus.invoke(helloWorldAct, {
      tool: openChatToolId,
      chatId: opened.chat.id,
    });
    expect(back.snapshot.chat.id).toBe(opened.chat.id);
    const removed = await kernel.bus.invoke(helloWorldAct, {
      tool: deleteChatToolId,
      chatId: created.snapshot.chat.id,
    });
    expect(removed.snapshot.chats.map((chat) => chat.id)).not.toContain(created.snapshot.chat.id);
    await expect(stat(sessionDir(dataDirectory, created.snapshot.chat.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records the connect message when no model is chosen", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "hello-world-"));
    kernel = await startHelloWorld(dataDirectory);
    const asked = await kernel.bus.invoke(helloWorldAct, { tool: promptToolId, text: "hello" });
    expect(asked.effect.type).toBe("asked");
    expect(asked.snapshot.chat.title).toBe("hello");
    expect(asked.snapshot.turns.map((turn) => turn.text)).toEqual(["hello", connectModelMessage]);
    expect(fetchDouble?.requests).toEqual([]);
  });

  it("reads a file and writes the summary after approval", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "hello-world-"));
    kernel = await startHelloWorld(dataDirectory);
    await connectAssistant(kernel);
    const opened = await kernel.bus.invoke(helloWorldSnapshot, {});
    const note = "The pump needs a 12mm bolt.";
    await writeFile(join(sessionDir(dataDirectory, opened.chat.id), "notes.txt"), note);
    const pending = kernel.bus.invoke(helloWorldAct, {
      tool: promptToolId,
      text: "Read notes.txt and write the summary to summary.txt",
    });
    const done = await finishAct(kernel, pending);
    expect(done.effect.type).toBe("asked");
    expect(done.snapshot.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(done.snapshot.turns.at(-1)?.text).toBe("Wrote summary.txt.");
    expect(done.snapshot.files.map((file) => file.path)).toEqual(["notes.txt", "summary.txt"]);
    expect(await readFile(join(sessionDir(dataDirectory, opened.chat.id), "summary.txt"), "utf8")).toBe(
      note,
    );
    const first = JSON.stringify(fetchDouble?.requests[0]);
    expect(first).toContain("example_hello-world_read");
    expect(first).toContain("example_hello-world_write");
    expect(first).toContain("example_hello-world_list");
    expect(first).toContain("feedback_ask");
    expect(first).not.toContain("example_hello-world_prompt");
    expect(first).not.toContain("shell_exec");
    expect(first).not.toContain("code_run");
    expect(first).not.toContain("filesystem_read");
  }, 60_000);

  it("refuses a path that climbs out of the chat folder", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "hello-world-"));
    kernel = await startHelloWorld(dataDirectory);
    await connectAssistant(kernel);
    const opened = await kernel.bus.invoke(helloWorldSnapshot, {});
    const secret = join(sessionDir(dataDirectory, opened.chat.id), "..", "secret.txt");
    await writeFile(secret, "TOP-SECRET-TOKEN");
    const pending = kernel.bus.invoke(helloWorldAct, {
      tool: promptToolId,
      text: "read ../secret.txt",
    });
    const done = await finishAct(kernel, pending);
    expect(done.snapshot.turns.at(-1)?.text).toBe("Workspace path escapes the session workspace");
    expect(JSON.stringify(fetchDouble?.requests)).not.toContain("TOP-SECRET-TOKEN");
    expect(await readFile(secret, "utf8")).toBe("TOP-SECRET-TOKEN");
    expect(done.snapshot.files).toEqual([]);
  }, 60_000);

  it("asks for a missing path, then writes the answer", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "hello-world-"));
    kernel = await startHelloWorld(dataDirectory);
    await connectAssistant(kernel);
    const pending = kernel.bus.invoke(helloWorldAct, { tool: promptToolId, text: "write a file" });
    void pending.catch(() => undefined);
    const question = await waitForKind(kernel, "human_input", pending);
    expect(question.prompt).toBe(FILE_QUESTION);
    expect(
      kernel.interactions.respond(question.id, { kind: "text", text: "hello.txt | hello from the desk" }),
    ).toBe(true);
    const done = await finishAct(kernel, pending);
    expect(done.snapshot.turns.at(-1)?.text).toBe("Wrote hello.txt.");
    expect(done.snapshot.files.map((file) => file.path)).toEqual(["hello.txt"]);
    expect(
      await readFile(join(sessionDir(dataDirectory, done.snapshot.chat.id), "hello.txt"), "utf8"),
    ).toBe("hello from the desk");
  }, 60_000);
});

function sessionDir(root: string, chatId: string): string {
  return join(root, "workspaces", "sessions", "example.hello-world", chatId);
}

async function connectAssistant(running: Kernel): Promise<void> {
  await running.secrets.set("borg.openai", "apiKey", "sk-test");
  await running.bus.invokeById("borg.openai.connect", {});
  const chosen = await running.bus.invoke(helloWorldAct, {
    tool: preferModelToolId,
    preferenceId: helloWorldModelPreference,
  });
  expect(chosen.effect.type).toBe("model");
  expect(chosen.snapshot.model).toBe(helloWorldModelPreference);
}

function approveTools(running: Kernel): { stop(): void } {
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      for (const item of running.interactions.listPending()) {
        if (item.kind === "tool_approval" || item.kind === "classification") {
          running.interactions.respond(item.id, { kind: "approval", decision: "allow" });
        }
      }
      await delay(15);
    }
  };
  void loop();
  return {
    stop() {
      stopped = true;
    },
  };
}

async function finishAct<T>(running: Kernel, pending: Promise<T>): Promise<T> {
  const approvals = approveTools(running);
  const started = Date.now();
  try {
    while (Date.now() - started < 20_000) {
      const settled = await Promise.race([
        pending.then((value) => ({ done: true as const, value })),
        delay(20).then(() => ({ done: false as const })),
      ]);
      if (settled.done) {
        return settled.value;
      }
    }
  } finally {
    approvals.stop();
  }
  throw new Error("hello world act timed out");
}

async function waitForKind(
  runningKernel: Kernel,
  kind: PendingInteraction["kind"],
  pending: Promise<unknown>,
): Promise<PendingInteraction> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const match = runningKernel.interactions.listPending().find((item) => item.kind === kind);
    if (match) {
      return match;
    }
    const settled = await Promise.race([
      pending.then((value) => ({ done: true as const, value })),
      delay(20).then(() => ({ done: false as const })),
    ]);
    if (settled.done) {
      throw new Error(`Act finished before ${kind}: ${JSON.stringify(settled.value)}`);
    }
  }
  throw new Error(`No ${kind} interaction`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
