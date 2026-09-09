import {
  calendarCreateInputSchema,
  calendarCreateOutputSchema,
  calendarListInputSchema,
  calendarListOutputSchema,
  contactsSearchInputSchema,
  contactsSearchOutputSchema,
  driveReadInputSchema,
  driveReadOutputSchema,
  driveSearchInputSchema,
  driveSearchOutputSchema,
} from "@borg/contracts";
import {
  defineTool,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import type { GoogleCalendarClient } from "./calendar";
import type { GoogleContactsClient } from "./contacts";
import type { GoogleDriveClient } from "./drive";

const TOOL_SECURITY = {
  outputClassification: "confidential",
  outputProvenance: "external",
  channelCapacity: "private",
} as const;

export interface GoogleToolClients {
  readonly calendar: GoogleCalendarClient;
  readonly drive: GoogleDriveClient;
  readonly contacts: GoogleContactsClient;
}

export type GoogleToolAccountResolver = (
  accountId: string | undefined,
) => Promise<GoogleToolClients>;

export function registerGoogleTools(
  context: PluginContext,
  resolveAccount: GoogleToolAccountResolver,
): Disposable {
  const handles = [
    context.tools.register(
      defineTool({
        id: "google.calendar.list",
        description: "List Google Calendar events in a time window",
        input: calendarListInputSchema,
        output: calendarListOutputSchema,
        approval: "ask",
        sideEffect: false,
        security: TOOL_SECURITY,
        execute: async (input, execution) => {
          const clients = await resolveAccount(input.accountId);
          return clients.calendar.list(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "google.calendar.create",
        description: "Create a Google Calendar event",
        input: calendarCreateInputSchema,
        output: calendarCreateOutputSchema,
        approval: "ask",
        sideEffect: true,
        security: TOOL_SECURITY,
        execute: async (input, execution) => {
          const clients = await resolveAccount(input.accountId);
          return clients.calendar.create(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "google.drive.search",
        description: "Search Google Drive files",
        input: driveSearchInputSchema,
        output: driveSearchOutputSchema,
        approval: "ask",
        sideEffect: false,
        security: TOOL_SECURITY,
        execute: async (input, execution) => {
          const clients = await resolveAccount(input.accountId);
          return clients.drive.search(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "google.drive.read",
        description: "Read a Google Drive file",
        input: driveReadInputSchema,
        output: driveReadOutputSchema,
        approval: "ask",
        sideEffect: false,
        security: TOOL_SECURITY,
        execute: async (input, execution) => {
          const clients = await resolveAccount(input.accountId);
          return clients.drive.read(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "google.contacts.search",
        description: "Search Google contacts by name",
        input: contactsSearchInputSchema,
        output: contactsSearchOutputSchema,
        approval: "ask",
        sideEffect: false,
        security: TOOL_SECURITY,
        execute: async (input, execution) => {
          const clients = await resolveAccount(input.accountId);
          return clients.contacts.search(input, execution.signal);
        },
      }),
    ),
  ];
  return {
    dispose: async () => {
      for (const handle of [...handles].reverse()) {
        await handle.dispose();
      }
    },
  };
}
