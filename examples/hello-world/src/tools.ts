/**
 * Folder tools. List, read, and write stay in the chat folder, and prompt starts the assistant loop.
 */

import { randomUUID } from "node:crypto";
import { defineTool, z, type PluginContext } from "@borg-agent/plugin-sdk";
import { modelOperationPrefixSchema } from "@borg-agent/contracts";
import {
  connectModelMessage,
  effectSchema,
  feedbackAskToolId,
  helloWorldAssistantId,
  listToolId,
  listToolInput,
  listToolOutput,
  promptToolId,
  readToolId,
  readToolInput,
  readToolOutput,
  unconfiguredModelPreference,
  writeToolId,
  writeToolInput,
  writeToolOutput,
} from "./contract.js";
import { listWorkspaceFiles, readWorkspaceText, writeWorkspaceText } from "./folder.js";
import { chatTitle, type ChatWriter } from "./session.js";

type Effect = z.output<typeof effectSchema>;

const promptInput = z.object({ text: z.string().min(1) }).strict();
const demoModelPreference = "borg.mock-llm:mock:scripted";

export function createFileTools(
  context: PluginContext,
  chats: ChatWriter,
): ReturnType<typeof defineTool>[] {
  return [listTool(), readTool(), writeTool(), promptTool(context, chats)];
}

function listTool() {
  return defineTool({
    id: listToolId,
    description: "List the relative paths in this chat's folder.",
    input: listToolInput,
    output: listToolOutput,
    approval: "auto",
    sideEffect: false,
    async execute(input, toolContext) {
      try {
        void input;
        toolContext.signal.throwIfAborted();
        const files = await listWorkspaceFiles(toolContext.workspaceRoot);
        return { files: files.map((file) => ({ path: file.path, size: file.size })) };
      } catch (error) {
        toolContext.signal.throwIfAborted();
        return { files: [], error: reported(error) };
      }
    },
  });
}

function readTool() {
  return defineTool({
    id: readToolId,
    description: "Read a UTF-8 text file in this chat's folder. The path is relative.",
    input: readToolInput,
    output: readToolOutput,
    approval: "auto",
    sideEffect: false,
    async execute(input, toolContext) {
      try {
        toolContext.signal.throwIfAborted();
        return await readWorkspaceText(toolContext.workspaceRoot, input.path);
      } catch (error) {
        toolContext.signal.throwIfAborted();
        return { path: input.path, content: "", error: reported(error) };
      }
    },
  });
}

function writeTool() {
  return defineTool({
    id: writeToolId,
    description:
      "Replace a UTF-8 text file in this chat's folder. The path is relative. The person approves this write.",
    input: writeToolInput,
    output: writeToolOutput,
    approval: "ask",
    sideEffect: true,
    async execute(input, toolContext) {
      try {
        toolContext.signal.throwIfAborted();
        return await writeWorkspaceText(toolContext.workspaceRoot, input.path, input.content);
      } catch (error) {
        toolContext.signal.throwIfAborted();
        return { path: input.path, bytesWritten: 0, error: reported(error) };
      }
    },
  });
}

function promptTool(context: PluginContext, chats: ChatWriter) {
  return defineTool({
    id: promptToolId,
    description: "Ask the assistant about the files in this chat.",
    input: promptInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      const chatId = toolContext.sessionId;
      if (!chatId) {
        throw new Error("Chat is unavailable");
      }
      await chats.edit(chatId, async (session) => {
        session.commit({
          ...session.chat,
          title: chatTitle(session.chat.title, input.text),
          turns: [...session.chat.turns, { role: "user", text: input.text }],
        });
      });
      const preference = await adoptAssistantModel(context);
      if (preference === undefined) {
        await remember(chats, chatId, connectModelMessage);
        return { type: "asked" };
      }
      const chat = await chats.get(chatId);
      const names = (await context.workspace.listFiles(chatId)).map((file) => file.path);
      const shown = names.slice(0, 50);
      const folder =
        shown.length === 0
          ? "none"
          : `${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}`;
      const prior = chat.turns.slice(0, -1).map((turn) => ({
        role: turn.role,
        content: turn.text,
      }));
      // The loop calls the file tools and feedback.ask, which must not wait behind this writer.
      const started = await context.loops.start({
        prompt: [input.text, `Files in this chat: ${folder}.`].join("\n"),
        personaId: helloWorldAssistantId,
        // File tools receive workspaceRoot only when sessionId names an allocated workspace.
        sessionId: chatId,
        conversation: prior,
        allowedTools: [listToolId, readToolId, writeToolId, feedbackAskToolId],
        security: {
          kind: "root",
          // A repeated subject resumes the same root, and the loop closes that root when the turn ends.
          subject: { kind: "hello-world", id: randomUUID() },
          classification: "confidential",
          provenance: { kind: "user", id: "hello-world" },
          operationPrefix: modelOperationPrefixSchema.parse("example.hello-world"),
        },
      });
      let reply = "Done.";
      try {
        await waitForLoop(context, started.id, toolContext.signal);
        const output = context.loops.get(started.id)?.output?.trim() ?? "";
        if (output.length > 0) {
          reply = output;
        }
      } catch (error) {
        reply =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The assistant stopped.";
        await remember(chats, chatId, reply);
        throw error;
      }
      await remember(chats, chatId, reply);
      return { type: "asked" };
    },
  });
}

function reported(error: unknown): string {
  if (!(error instanceof Error)) {
    return "The file tool could not finish";
  }
  if (
    error.message.startsWith("Workspace ") ||
    error.message === "This tool requires a session workspace"
  ) {
    return error.message;
  }
  return "The file tool could not finish";
}

function usableModel(preference: string): boolean {
  return preference !== unconfiguredModelPreference && preference !== demoModelPreference;
}

function assistantModels(context: PluginContext): string[] {
  const general = context.personas.get("system/general");
  const rest = context.personas
    .list()
    .filter(
      (persona) =>
        persona.id !== helloWorldAssistantId && persona.id !== "system/general" && !persona.archived,
    );
  const seen = new Set<string>();
  const models: string[] = [];
  for (const preference of [general, ...rest].flatMap((persona) => persona?.preferredModels ?? [])) {
    if (!usableModel(preference) || seen.has(preference)) {
      continue;
    }
    seen.add(preference);
    models.push(preference);
  }
  return models;
}

export async function adoptAssistantModel(context: PluginContext): Promise<string | undefined> {
  const current = context.personas.get(helloWorldAssistantId)?.preferredModels.filter(usableModel) ?? [];
  if (current.length > 0) {
    return current[0];
  }
  const adopted = assistantModels(context);
  const first = adopted[0];
  if (first === undefined) {
    return undefined;
  }
  await context.personas.update(helloWorldAssistantId, { preferredModels: adopted });
  return first;
}

export function chosenModel(context: PluginContext): string | null {
  const preference = context.personas.get(helloWorldAssistantId)?.preferredModels.find(usableModel);
  return preference ?? null;
}

async function remember(chats: ChatWriter, chatId: string, reply: string): Promise<void> {
  await chats.edit(chatId, async (session) => {
    session.commit({
      ...session.chat,
      turns: [...session.chat.turns, { role: "assistant", text: reply }],
    });
  });
}

async function waitForLoop(
  context: PluginContext,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const snapshot = context.loops.get(runId);
    if (!snapshot) {
      throw new Error(`Assistant loop ${runId} disappeared`);
    }
    if (snapshot.status === "completed") {
      return;
    }
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      throw new Error(snapshot.error ?? `Assistant loop ${snapshot.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
