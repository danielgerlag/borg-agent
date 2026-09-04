const FIELD_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 7 },
] as const;

const MAX_SEARCH_MS = 4 * 365 * 24 * 60 * 60 * 1000;

export interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly day: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly weekday: ReadonlySet<number>;
  readonly dayRestricted: boolean;
  readonly weekdayRestricted: boolean;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expression must have five fields");
  }
  const [minute, hour, day, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const parsedWeekday = parseField(weekday, FIELD_RANGES[4]);
  const weekdayValues = new Set<number>();
  for (const value of parsedWeekday) {
    weekdayValues.add(value === 7 ? 0 : value);
  }
  return {
    minute: parseField(minute, FIELD_RANGES[0]),
    hour: parseField(hour, FIELD_RANGES[1]),
    day: parseField(day, FIELD_RANGES[2]),
    month: parseField(month, FIELD_RANGES[3]),
    weekday: weekdayValues,
    dayRestricted: day !== "*",
    weekdayRestricted: weekday !== "*",
  };
}

export function nextCronOccurrence(expression: string, fromMs: number): number {
  const cron = parseCron(expression);
  const cursor = new Date(fromMs);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const deadline = fromMs + MAX_SEARCH_MS;
  while (cursor.getTime() <= deadline) {
    if (matchesCron(cron, cursor)) {
      return cursor.getTime();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`Cron expression ${expression} has no occurrence in the next four years`);
}

function parseField(
  field: string,
  range: (typeof FIELD_RANGES)[number],
): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [span, stepToken] = part.split("/");
    if (!span) {
      throw new Error(`Cron ${range.name} field is empty`);
    }
    const step = stepToken === undefined ? 1 : Number(stepToken);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Cron ${range.name} step is invalid`);
    }
    if (span === "*") {
      addRange(values, range.min, range.max, step);
      continue;
    }
    const [startToken, endToken] = span.split("-");
    const start = Number(startToken);
    const end = endToken === undefined ? start : Number(endToken);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < range.min ||
      end > range.max ||
      start > end
    ) {
      throw new Error(`Cron ${range.name} value is out of range`);
    }
    addRange(values, start, end, step);
  }
  if (values.size === 0) {
    throw new Error(`Cron ${range.name} field matches nothing`);
  }
  return values;
}

function addRange(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
): void {
  for (let value = start; value <= end; value += step) {
    values.add(value);
  }
}

function matchesCron(cron: CronFields, date: Date): boolean {
  if (
    !cron.minute.has(date.getUTCMinutes()) ||
    !cron.hour.has(date.getUTCHours()) ||
    !cron.month.has(date.getUTCMonth() + 1)
  ) {
    return false;
  }
  const dayMatches = cron.day.has(date.getUTCDate());
  const weekdayMatches = cron.weekday.has(date.getUTCDay());
  if (cron.dayRestricted && cron.weekdayRestricted) {
    return dayMatches || weekdayMatches;
  }
  if (cron.dayRestricted) {
    return dayMatches;
  }
  if (cron.weekdayRestricted) {
    return weekdayMatches;
  }
  return true;
}
