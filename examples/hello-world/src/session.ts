/**
 * Chat sessions stored under the plugin. Each chat keeps its transcript.
 */

import { randomUUID } from "node:crypto";
import type { JsonValue } from "@borg-agent/plugin-sdk";
import { z } from "@borg-agent/plugin-sdk";
import { chatSummarySchema, helloWorldAssistantId, turnSchema } from "./contract.js";

export const newChatTitle = "New chat";

const chatSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(48),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    personaId: z.string().min(1),
    turns: z.array(turnSchema),
  })
  .strict();

const catalogSchema = z
  .object({
    currentId: z.string().uuid(),
    chats: z.array(chatSchema).min(1),
  })
  .strict();

export type Chat = z.output<typeof chatSchema>;
type Catalog = z.output<typeof catalogSchema>;

export interface ChatStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}

export interface ChatSession {
  readonly chat: Chat;
  commit(next: Chat): void;
}

export type ChatSummary = z.output<typeof chatSummarySchema>;

export interface ChatWriter {
  read(): Promise<Chat>;
  get(chatId: string): Promise<Chat>;
  list(): Promise<readonly ChatSummary[]>;
  edit<T>(chatId: string, operation: (session: ChatSession) => Promise<T>): Promise<T>;
  create(): Promise<Chat>;
  open(chatId: string): Promise<Chat>;
  remove(chatId: string): Promise<Chat>;
}

const CHAT_KEY = "chats";

export function chatTitle(current: string, text: string): string {
  if (current !== newChatTitle) {
    return current;
  }
  const next = text.trim().slice(0, 48);
  return next.length > 0 ? next : current;
}

export function readCatalog(stored: unknown): Catalog {
  const catalog = catalogSchema.safeParse(stored);
  if (!catalog.success) {
    throw new Error("Hello world chat is corrupt");
  }
  return seal(catalog.data);
}

function seal(catalog: Catalog): Catalog {
  const ids = new Set<string>();
  for (const chat of catalog.chats) {
    if (ids.has(chat.id)) {
      throw new Error("Hello world chat is corrupt");
    }
    ids.add(chat.id);
  }
  if (!ids.has(catalog.currentId)) {
    throw new Error("Hello world chat is corrupt");
  }
  return catalog;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function toJson(catalog: Catalog): JsonValue {
  const value: unknown = JSON.parse(JSON.stringify(catalog));
  if (!isJsonValue(value)) {
    throw new Error("Hello world chat is corrupt");
  }
  return value;
}

function currentChat(catalog: Catalog): Chat {
  const chat = catalog.chats.find((item) => item.id === catalog.currentId);
  if (!chat) {
    throw new Error("Hello world chat is corrupt");
  }
  return chat;
}

function seed(now = new Date().toISOString()): Chat {
  return chatSchema.parse({
    id: randomUUID(),
    title: newChatTitle,
    createdAt: now,
    updatedAt: now,
    personaId: helloWorldAssistantId,
    turns: [],
  });
}

function summaries(catalog: Catalog): readonly ChatSummary[] {
  return catalog.chats
    .map((chat) =>
      chatSummarySchema.parse({
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt,
      }),
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title),
    );
}

export function createChatWriter(store: ChatStore): ChatWriter {
  let tail = Promise.resolve();
  let memory: Catalog | undefined;

  async function load(): Promise<Catalog> {
    if (memory) {
      return memory;
    }
    const stored = await store.get(CHAT_KEY);
    if (stored === undefined) {
      const chat = seed();
      memory = seal({ currentId: chat.id, chats: [chat] });
      await store.set(CHAT_KEY, toJson(memory));
      return memory;
    }
    memory = readCatalog(stored);
    return memory;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function save(catalog: Catalog): Promise<void> {
    memory = seal(catalogSchema.parse(catalog));
    await store.set(CHAT_KEY, toJson(memory));
  }

  function replace(catalog: Catalog, chatId: string, next: Chat): Catalog {
    return {
      currentId: catalog.currentId,
      chats: catalog.chats.map((item) => (item.id === chatId ? next : item)),
    };
  }

  async function editChat<T>(
    chatId: string,
    operation: (session: ChatSession) => Promise<T>,
  ): Promise<T> {
    const catalog = await load();
    const chat = catalog.chats.find((item) => item.id === chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} is unavailable`);
    }
    let next = chat;
    let committed = false;
    const result = await operation({
      chat,
      commit(value) {
        next = chatSchema.parse({
          ...value,
          id: chat.id,
          createdAt: chat.createdAt,
          personaId: chat.personaId,
          updatedAt: new Date().toISOString(),
        });
        committed = true;
      },
    });
    if (committed) {
      await save(replace(catalog, chat.id, next));
    }
    return result;
  }

  return {
    read: async () => currentChat(await load()),
    get: async (chatId) => {
      const chat = (await load()).chats.find((item) => item.id === chatId);
      if (!chat) {
        throw new Error(`Chat ${chatId} is unavailable`);
      }
      return chat;
    },
    list: async () => summaries(await load()),
    edit(chatId, operation) {
      return enqueue(() => editChat(chatId, operation));
    },
    create() {
      return enqueue(async () => {
        const catalog = await load();
        const chat = seed();
        await save({ currentId: chat.id, chats: [chat, ...catalog.chats] });
        return chat;
      });
    },
    open(chatId) {
      return enqueue(async () => {
        const catalog = await load();
        const chat = catalog.chats.find((item) => item.id === chatId);
        if (!chat) {
          throw new Error(`Chat ${chatId} is unavailable`);
        }
        if (catalog.currentId !== chatId) {
          await save({ ...catalog, currentId: chatId });
        }
        return chat;
      });
    },
    remove(chatId) {
      return enqueue(async () => {
        const catalog = await load();
        const remaining = catalog.chats.filter((item) => item.id !== chatId);
        if (remaining.length === catalog.chats.length) {
          throw new Error(`Chat ${chatId} is unavailable`);
        }
        let chats = remaining;
        let currentId = catalog.currentId;
        if (chats.length === 0) {
          const chat = seed();
          chats = [chat];
          currentId = chat.id;
        } else if (currentId === chatId) {
          const newest = summaries({ currentId, chats })[0];
          if (!newest) {
            throw new Error("Hello world chat is corrupt");
          }
          currentId = newest.id;
        }
        await save({ currentId, chats });
        return currentChat(memory ?? { currentId, chats });
      });
    },
  };
}
