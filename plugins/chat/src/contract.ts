import {
  defineCommand,
  defineEvent,
  discoveredSkillSchema,
  embeddedContentSnapshotSchema,
  githubSkillSourceIdSchema,
  personaIdSchema,
  skillIdSchema,
  skillSchema,
  skillSourceSchema,
  workspaceFileSchema,
  workspaceImportResultSchema,
  workspacePreviewSchema,
} from "@borg-agent/contracts";
import { z } from "zod";

export const chatUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costsByCurrency: z.record(z.string().min(1), z.number().nonnegative()),
  })
  .strict();

export type ChatUsage = z.infer<typeof chatUsageSchema>;

export const emptyChatUsage: ChatUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costsByCurrency: Object.freeze({}),
});

export const chatEntryRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "event",
]);

export const chatEntrySchema = z
  .object({
    id: z.string().uuid(),
    role: chatEntryRoleSchema,
    content: z.string(),
    metadata: z.record(z.string(), z.json()).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ChatEntry = z.infer<typeof chatEntrySchema>;

export const chatSessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    personaId: personaIdSchema,
    parentSessionId: z.string().uuid().optional(),
    status: z.enum(["idle", "running", "waiting", "error"]),
    activeRunId: z.string().uuid().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    usage: chatUsageSchema.default(emptyChatUsage),
  })
  .strict();

export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatDocumentSchema = z
  .object({
    session: chatSessionSchema,
    entries: z.array(chatEntrySchema),
  })
  .strict();

export const chatCreateSession = defineCommand({
  id: "borg.chat.createSession",
  input: z
    .object({
      personaId: personaIdSchema.optional(),
      title: z.string().min(1).optional(),
      parentSessionId: z.string().uuid().optional(),
      initialMessage: z.string().trim().min(1).optional(),
    })
    .strict(),
  output: z
    .object({
      sessionId: z.string().uuid(),
      startError: z.string().min(1).optional(),
    })
    .strict(),
});

export const chatListSessions = defineCommand({
  id: "borg.chat.listSessions",
  input: z
    .object({
      parentSessionId: z.string().uuid().optional(),
      includeChildren: z.boolean().default(true),
    })
    .strict(),
  output: z.object({ sessions: z.array(chatSessionSchema) }).strict(),
});

export const chatGetSession = defineCommand({
  id: "borg.chat.getSession",
  input: z.object({ sessionId: z.string().uuid() }).strict(),
  output: chatDocumentSchema,
});

export const chatSendMessage = defineCommand({
  id: "borg.chat.sendMessage",
  input: z
    .object({
      sessionId: z.string().uuid(),
      text: z.string().min(1),
    })
    .strict(),
  output: z.object({ runId: z.string().uuid() }).strict(),
});

export const chatAppend = defineCommand({
  id: "borg.chat.append",
  input: z
    .object({
      sessionId: z.string().uuid(),
      entry: z
        .object({
          role: z.enum(["assistant", "system", "tool", "event"]),
          content: z.string(),
          metadata: z.record(z.string(), z.json()).optional(),
        })
        .strict(),
    })
    .strict(),
  output: z.object({ messageId: z.string().uuid() }).strict(),
});

export const chatDeleteSession = defineCommand({
  id: "borg.chat.deleteSession",
  input: z.object({ sessionId: z.string().uuid() }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const chatSpawnSubAgent = defineCommand({
  id: "borg.chat.spawnSubAgent",
  input: z
    .object({
      parentSessionId: z.string().uuid(),
      personaId: personaIdSchema.optional(),
      task: z.string().min(1),
    })
    .strict(),
  output: z
    .object({
      childSessionId: z.string().uuid(),
      runId: z.string().uuid(),
    })
    .strict(),
});

export const chatListWorkspace = defineCommand({
  id: "borg.chat.listWorkspace",
  input: z.object({ sessionId: z.string().uuid() }).strict(),
  output: z.object({ files: z.array(workspaceFileSchema) }).strict(),
});

export const chatPreviewWorkspaceFile = defineCommand({
  id: "borg.chat.previewWorkspaceFile",
  input: z
    .object({
      sessionId: z.string().uuid(),
      path: z.string().min(1),
    })
    .strict(),
  output: workspacePreviewSchema,
});

export const chatImportWorkspaceFiles = defineCommand({
  id: "borg.chat.importWorkspaceFiles",
  input: z
    .object({
      sessionId: z.string().uuid(),
      nativePaths: z.array(z.string().min(1)).min(1).max(50),
      destDir: z.string().min(1).optional(),
    })
    .strict(),
  output: workspaceImportResultSchema,
});

export const chatSkillsListSources = defineCommand({
  id: "borg.chat.skills.listSources",
  input: z.object({}).strict(),
  output: z.object({ sources: z.array(skillSourceSchema) }).strict(),
});

export const chatSkillsSetSources = defineCommand({
  id: "borg.chat.skills.setSources",
  input: z.object({ sources: z.array(skillSourceSchema) }).strict(),
  output: z.object({ sources: z.array(skillSourceSchema) }).strict(),
});

export const chatSkillsDiscover = defineCommand({
  id: "borg.chat.skills.discover",
  input: z
    .object({
      sourceId: githubSkillSourceIdSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      skills: z.array(discoveredSkillSchema),
      warnings: z.array(z.string()),
    })
    .strict(),
  timeoutMs: 60_000,
});

export const chatSkillsPreview = defineCommand({
  id: "borg.chat.skills.preview",
  input: z
    .object({
      sourceId: githubSkillSourceIdSchema,
      sourcePath: z.string(),
    })
    .strict(),
  output: z
    .object({
      id: skillIdSchema,
      name: z.string().min(1),
      description: z.string().min(1),
      instructions: z.string(),
      sourceId: githubSkillSourceIdSchema,
      sourcePath: z.string(),
    })
    .strict(),
});

export const chatSkillsInstall = defineCommand({
  id: "borg.chat.skills.install",
  input: z
    .object({
      sourceId: githubSkillSourceIdSchema,
      sourcePath: z.string(),
    })
    .strict(),
  output: z.object({ skill: skillSchema }).strict(),
});

export const chatMessageAppended = defineEvent({
  id: "borg.chat.message.appended",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      entry: chatEntrySchema,
    })
    .strict(),
});

export const chatTurnStarted = defineEvent({
  id: "borg.chat.turn.started",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      runId: z.string().uuid(),
      personaId: personaIdSchema,
    })
    .strict(),
});

export const chatTurnCompleted = defineEvent({
  id: "borg.chat.turn.completed",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      runId: z.string().uuid(),
      status: z.enum(["completed", "failed", "cancelled"]),
      output: z.string().optional(),
      error: z.string().optional(),
    })
    .strict(),
});

export const chatSessionUpdated = defineEvent({
  id: "borg.chat.session.updated",
  payload: z
    .object({
      session: chatSessionSchema,
    })
    .strict(),
});

export const chatSessionDeleted = defineEvent({
  id: "borg.chat.session.deleted",
  payload: z.object({ sessionId: z.string().uuid() }).strict(),
});

export const chatWorkspaceUpdated = defineEvent({
  id: "borg.chat.workspace.updated",
  payload: z.object({ sessionId: z.string().uuid() }).strict(),
});

export const embeddedContentRegistered = defineEvent({
  id: "borg.embeddedContent.registered",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      content: embeddedContentSnapshotSchema,
    })
    .strict(),
});
