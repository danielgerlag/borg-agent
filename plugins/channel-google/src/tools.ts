import {
  calendarCreateInputSchema,
  calendarCreateOutputSchema,
  calendarListInputSchema,
  calendarListOutputSchema,
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
import type { GoogleDriveClient } from "./drive";

const TOOL_SECURITY = {
  outputClassification: "confidential",
  outputProvenance: "external",
  channelCapacity: "private",
} as const;

export function registerGoogleTools(
  context: PluginContext,
  calendar: GoogleCalendarClient,
  drive: GoogleDriveClient,
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
        execute: (input, execution) => calendar.list(input, execution.signal),
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
        execute: (input, execution) => calendar.create(input, execution.signal),
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
        execute: (input, execution) => drive.search(input, execution.signal),
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
        execute: (input, execution) => drive.read(input, execution.signal),
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
