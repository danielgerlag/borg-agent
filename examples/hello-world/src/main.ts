/**
 * Hello world plugin. Activation registers the folder tools and serves snapshot and act.
 */

import { randomUUID } from "node:crypto";
import { definePlugin, z, type PluginContext } from "@borg-agent/plugin-sdk";
import {
  actInputSchema,
  deleteChatToolId,
  effectSchema,
  helloWorldAct,
  helloWorldAssistantId,
  helloWorldSnapshot,
  newChatToolId,
  snapshotSchema,
  openChatToolId,
  preferModelToolId,
  promptToolId,
} from "./contract.js";
import { helloWorldPersonas } from "./personas.js";
import { createChatWriter, type Chat, type ChatWriter } from "./session.js";
import { adoptAssistantModel, chosenModel, createFileTools } from "./tools.js";

type Effect = z.output<typeof effectSchema>;

const pluginId = "example.hello-world";

export default definePlugin({
  id: pluginId,
  version: "0.1.0",
  engines: { borg: "^0.1.0" },
  permissions: [
    "tools.register",
    "tools.invoke",
    "loops.start",
    "personas.read",
    "personas.write",
    "workspace.manage",
    "fs:sessionWorkspace",
    "ui.workspace",
  ],
  contributes: {
    commands: [helloWorldSnapshot.id, helloWorldAct.id],
    kinds: ["tool", "workspaceView"],
  },
  async activate(context) {
    const chats = createChatWriter(context.store);
    const tools = createFileTools(context, chats).map((tool) => context.tools.register(tool));
    for (const persona of helloWorldPersonas) {
      const existing = context.personas.get(persona.id);
      if (!existing) {
        await context.personas.create({
          id: persona.id,
          name: persona.name,
          instructions: persona.instructions,
          preferredModels: [...persona.preferredModels],
          allowedTools: [...persona.allowedTools],
        });
      } else if (
        existing.instructions !== persona.instructions ||
        !sameTools(existing.allowedTools, persona.allowedTools)
      ) {
        await context.personas.update(persona.id, {
          instructions: persona.instructions,
          allowedTools: [...persona.allowedTools],
        });
      }
    }
    await adoptAssistantModel(context);
    if (
      context.personas.getDefault().id === helloWorldAssistantId &&
      context.personas.get("system/general")
    ) {
      await context.personas.setDefault("system/general");
    }
    await ensureWorkspaces(context, chats);
    const snapshotCommand = context.bus.handle(helloWorldSnapshot, async () => project(context, chats));
    const actCommand = context.bus.handle(helloWorldAct, async (input, signal) => {
      signal.throwIfAborted();
      const action = actInputSchema.parse(input);
      if (action.tool === preferModelToolId) {
        await context.personas.update(helloWorldAssistantId, {
          preferredModels: [action.preferenceId],
        });
        return {
          snapshot: await project(context, chats),
          effect: { type: "model" as const },
        };
      }
      if (action.tool === newChatToolId) {
        const chat = await chats.create();
        context.workspace.allocate(chat.id);
      } else if (action.tool === openChatToolId) {
        await chats.open(action.chatId);
      } else if (action.tool === deleteChatToolId) {
        const current = await chats.remove(action.chatId);
        await context.workspace.release(action.chatId);
        context.workspace.allocate(current.id);
      } else {
        const effect = await apply(context, chats, action);
        return {
          snapshot: await project(context, chats),
          effect,
        };
      }
      return {
        snapshot: await project(context, chats),
        effect: { type: "chat" as const },
      };
    });
    return {
      async dispose() {
        snapshotCommand.dispose();
        actCommand.dispose();
        for (const tool of tools) {
          tool.dispose();
        }
      },
    };
  },
});

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

async function ensureWorkspaces(context: PluginContext, chats: ChatWriter): Promise<void> {
  for (const chat of await chats.list()) {
    context.workspace.allocate(chat.id);
  }
}

async function apply(
  context: PluginContext,
  chats: ChatWriter,
  action: z.output<typeof actInputSchema>,
): Promise<Effect> {
  if (action.tool !== promptToolId) {
    throw new Error(`Act ${action.tool} is not a folder tool`);
  }
  const chat = await chats.read();
  return effectSchema.parse(
    await scopedInvoke(context, chat, action.tool, { text: action.text }),
  );
}

async function scopedInvoke(
  context: PluginContext,
  chat: Chat,
  toolId: string,
  input: unknown,
): Promise<unknown> {
  const runId = randomUUID();
  const scope = context.tools.registerExecutionScope({
    runId,
    sessionId: chat.id,
    personaId: chat.personaId,
  });
  try {
    await scope.prepare();
    return await context.tools.invoke(toolId, input, { runId });
  } finally {
    scope.dispose();
  }
}

async function project(context: PluginContext, chats: ChatWriter) {
  const chat = await chats.read();
  const persona = context.personas.get(chat.personaId);
  if (!persona) {
    throw new Error(`Persona ${chat.personaId} is unavailable`);
  }
  const files = [...(await context.workspace.listFiles(chat.id))].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return snapshotSchema.parse({
    chat: { id: chat.id, title: chat.title },
    chats: await chats.list(),
    persona: {
      id: persona.id,
      name: persona.name,
      allowedTools: [...persona.allowedTools],
    },
    turns: chat.turns,
    files: files.map((file) => ({ path: file.path, size: file.size })),
    model: chosenModel(context),
  });
}
