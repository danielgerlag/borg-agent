import {
  calendarCreateOutputSchema,
  calendarListOutputSchema,
  type CalendarCreateInput,
  type CalendarCreateOutput,
  type CalendarEvent,
  type CalendarListInput,
  type CalendarListOutput,
} from "@borg/contracts";
import {
  GoogleApisError,
  googleApisRequest,
  isRecord,
  readString,
  type GoogleApisClientOptions,
} from "./googleapis";
import {
  CALENDAR_DEFAULT_MAX_RESULTS,
  CALENDAR_DEFAULT_WINDOW_MS,
} from "./protocol";

export class GoogleCalendarClient {
  readonly #options: GoogleApisClientOptions;

  constructor(options: GoogleApisClientOptions) {
    this.#options = options;
  }

  async list(
    input: CalendarListInput,
    signal?: AbortSignal,
  ): Promise<CalendarListOutput> {
    const window = resolveCalendarWindow(input);
    const maxResults = input.maxResults ?? CALENDAR_DEFAULT_MAX_RESULTS;
    const query = new URLSearchParams({
      timeMin: window.start,
      timeMax: window.end,
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const body = await googleApisRequest(
      this.#options,
      `/calendar/v3/calendars/primary/events?${query.toString()}`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new GoogleApisError(
        "invalid",
        undefined,
        "Google returned an unusable calendar",
      );
    }
    const events: CalendarEvent[] = [];
    for (const item of body.items) {
      const parsed = parseGoogleEvent(item);
      if (parsed && events.length < maxResults) {
        events.push(parsed);
      }
    }
    return calendarListOutputSchema.parse({ events });
  }

  async create(
    input: CalendarCreateInput,
    signal?: AbortSignal,
  ): Promise<CalendarCreateOutput> {
    const window = resolveCalendarWindow(input);
    const payload: Record<string, unknown> = {
      summary: input.title,
      start: { dateTime: window.start },
      end: { dateTime: window.end },
    };
    if (input.location !== undefined) {
      payload.location = input.location;
    }
    if (input.body !== undefined) {
      payload.description = input.body;
    }
    const body = await googleApisRequest(
      this.#options,
      "/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );
    const parsed = parseGoogleEvent(body);
    if (!parsed) {
      throw new GoogleApisError(
        "invalid",
        undefined,
        "Google returned an unusable event",
      );
    }
    return calendarCreateOutputSchema.parse({
      id: parsed.id,
      title: parsed.title,
      start: parsed.start,
      end: parsed.end,
    });
  }
}

export function resolveCalendarWindow(input: {
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly now?: Date | undefined;
}): { readonly start: string; readonly end: string } {
  const startValue = input.start;
  const endValue = input.end;
  if (startValue !== undefined && endValue !== undefined) {
    return assertWindow(startValue, endValue);
  }
  const now = input.now ?? new Date();
  if (startValue === undefined && endValue === undefined) {
    return assertWindow(
      now.toISOString(),
      new Date(now.getTime() + CALENDAR_DEFAULT_WINDOW_MS).toISOString(),
    );
  }
  if (startValue === undefined) {
    const end = parseInstant(endValue, "Calendar window end");
    return assertWindow(
      new Date(end.getTime() - CALENDAR_DEFAULT_WINDOW_MS).toISOString(),
      end.toISOString(),
    );
  }
  const start = parseInstant(startValue, "Calendar window start");
  return assertWindow(
    start.toISOString(),
    new Date(start.getTime() + CALENDAR_DEFAULT_WINDOW_MS).toISOString(),
  );
}

function parseGoogleEvent(value: unknown): CalendarEvent | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  const title = readString(value.summary);
  const start = readGoogleDate(value.start);
  const end = readGoogleDate(value.end);
  if (!title || !start || !end) {
    return undefined;
  }
  const location = readString(value.location);
  return {
    id: value.id,
    title,
    start,
    end,
    ...(location !== undefined ? { location } : {}),
  };
}

function readGoogleDate(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value.dateTime) ?? readString(value.date);
}

function parseInstant(value: string | undefined, label: string): Date {
  if (value === undefined) {
    throw new GoogleApisError("invalid", undefined, `${label} is invalid`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GoogleApisError("invalid", undefined, `${label} is invalid`);
  }
  return date;
}

function assertWindow(
  start: string,
  end: string,
): { readonly start: string; readonly end: string } {
  const startDate = parseInstant(start, "Calendar window start");
  const endDate = parseInstant(end, "Calendar window end");
  if (startDate.getTime() >= endDate.getTime()) {
    throw new GoogleApisError(
      "invalid",
      undefined,
      "Calendar window start must be before end",
    );
  }
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}
