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
import type { GraphCalendarClient } from "./calendar";
import type { GraphDriveClient } from "./drive";

const TOOL_SECURITY = {
  outputClassification: "confidential",
  outputProvenance: "external",
  channelCapacity: "private",
} as const;

export function registerM365Tools(
  context: PluginContext,
  calendar: GraphCalendarClient,
  drive: GraphDriveClient,
): Disposable {
  const handles = [
    context.tools.register(
      defineTool({
        id: "m365.calendar.list",
        description: "List Microsoft 365 calendar events in a time window",
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
        id: "m365.calendar.create",
        description: "Create a Microsoft 365 calendar event",
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
        id: "m365.drive.search",
        description: "Search Microsoft 365 Drive files",
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
        id: "m365.drive.read",
        description: "Read a Microsoft 365 Drive file",
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
