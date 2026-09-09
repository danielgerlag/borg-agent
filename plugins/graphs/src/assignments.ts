import { graphValueMapSchema, type GraphNode } from "@borg/contracts";
import { isJsonObject } from "./schema";

export interface AssignmentRow {
  readonly name: string;
  readonly value: string;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function parseCell(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function assignmentRows(config: GraphNode["config"]): AssignmentRow[] {
  const values = config.values ?? config.variables;
  if (isJsonObject(values)) {
    const rows = Object.entries(values).map(([name, value]) => ({
      name,
      value: stringifyValue(value),
    }));
    return rows.length > 0 ? rows : [{ name: "", value: "" }];
  }
  return [
    {
      name: typeof config.name === "string" ? config.name : "",
      value: stringifyValue(config.value),
    },
  ];
}

export function configFromAssignmentRows(
  rows: readonly AssignmentRow[],
): GraphNode["config"] {
  const filled = rows.filter((row) => row.name.trim().length > 0);
  if (filled.length <= 1) {
    const row = filled[0] ?? { name: "", value: "" };
    return graphValueMapSchema.parse({
      name: row.name,
      value: parseCell(row.value),
    });
  }
  const values: Record<string, unknown> = {};
  for (const row of filled) {
    values[row.name] = parseCell(row.value);
  }
  return graphValueMapSchema.parse({ values });
}

export interface ChoiceRow {
  readonly id: string;
  readonly label: string;
}

export function choiceRows(value: unknown): ChoiceRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: ChoiceRow[] = [];
  for (const item of value) {
    if (!isJsonObject(item) || typeof item.id !== "string") {
      continue;
    }
    rows.push({
      id: item.id,
      label: typeof item.label === "string" ? item.label : "",
    });
  }
  return rows;
}

export function isExpressionString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\$(?:input|vars|steps)(?:\.|$)/.test(value.trim())
  );
}
