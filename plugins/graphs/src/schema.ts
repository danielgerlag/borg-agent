import {
  graphValueMapSchema,
  type GraphDefinition,
} from "@borg/contracts";

export type FieldType = "string" | "number" | "boolean" | "object" | "array";

export type UiWidget =
  | "textarea"
  | "code-editor"
  | "password"
  | "date"
  | "color-picker"
  | "slider";

export interface FieldCondition {
  readonly field: string;
  readonly eq?: unknown;
}

export interface SchemaUiHint {
  readonly widget?: UiWidget;
  readonly rows?: number;
  readonly step?: number;
  readonly condition?: FieldCondition;
}

export interface SchemaFieldCard {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue: string;
  readonly enumValues: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly xUi?: SchemaUiHint;
}

export type GraphSchema = GraphDefinition["inputSchema"];

function asFieldType(value: unknown): FieldType | undefined {
  if (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "object" ||
    value === "array"
  ) {
    return value;
  }
  return undefined;
}

function asUiWidget(value: unknown): UiWidget | undefined {
  if (
    value === "textarea" ||
    value === "code-editor" ||
    value === "password" ||
    value === "date" ||
    value === "color-picker" ||
    value === "slider"
  ) {
    return value;
  }
  return undefined;
}

export function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function schemaHasProperties(schema: unknown): boolean {
  if (!isJsonObject(schema)) {
    return false;
  }
  const properties = schema.properties;
  return isJsonObject(properties) && Object.keys(properties).length > 0;
}

export function isNoopSchema(schema: unknown): boolean {
  return !schemaHasProperties(schema);
}

export function evaluateFieldCondition(
  condition: FieldCondition | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!condition?.field) {
    return true;
  }
  const actual = values[condition.field];
  if (Object.hasOwn(condition, "eq")) {
    return actual === condition.eq;
  }
  return Boolean(actual);
}

export function emptyFieldCard(index: number): SchemaFieldCard {
  return {
    name: `field_${index + 1}`,
    type: "string",
    required: false,
    description: "",
    defaultValue: "",
    enumValues: [],
  };
}

function coerceDefault(type: FieldType, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (type === "string") {
    return raw;
  }
  if (type === "boolean") {
    return trimmed === "true";
  }
  if (type === "number") {
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : trimmed;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function defaultToEditor(type: FieldType, value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (type === "string") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (type === "boolean") {
    return value === true ? "true" : "false";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function parseUiHint(value: unknown): SchemaUiHint | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const widget = asUiWidget(value.widget);
  const hint: SchemaUiHint = {
    ...(widget ? { widget } : {}),
    ...(typeof value.rows === "number" ? { rows: value.rows } : {}),
    ...(typeof value.step === "number" ? { step: value.step } : {}),
    ...(isJsonObject(value.condition) &&
    typeof value.condition.field === "string"
      ? {
          condition: Object.hasOwn(value.condition, "eq")
            ? { field: value.condition.field, eq: value.condition.eq }
            : { field: value.condition.field },
        }
      : {}),
  };
  if (
    hint.widget === undefined &&
    hint.rows === undefined &&
    hint.step === undefined &&
    hint.condition === undefined
  ) {
    return undefined;
  }
  return hint;
}

function compileProperty(card: SchemaFieldCard): Record<string, unknown> {
  const property: Record<string, unknown> = { type: card.type };
  if (card.description) {
    property.description = card.description;
  }
  const defaultValue = coerceDefault(card.type, card.defaultValue);
  if (defaultValue !== undefined) {
    property.default = defaultValue;
  }
  if (card.enumValues.length > 0) {
    property.enum = [...card.enumValues];
  }
  if (card.type === "string") {
    if (card.minLength !== undefined) {
      property.minLength = card.minLength;
    }
    if (card.maxLength !== undefined) {
      property.maxLength = card.maxLength;
    }
    if (card.pattern) {
      property.pattern = card.pattern;
    }
  }
  if (card.type === "number") {
    if (card.minimum !== undefined) {
      property.minimum = card.minimum;
    }
    if (card.maximum !== undefined) {
      property.maximum = card.maximum;
    }
  }
  if (card.xUi) {
    const xUi: Record<string, unknown> = {};
    if (card.xUi.widget) {
      xUi.widget = card.xUi.widget;
    }
    if (card.xUi.rows !== undefined) {
      xUi.rows = card.xUi.rows;
    }
    if (card.xUi.step !== undefined) {
      xUi.step = card.xUi.step;
    }
    if (card.xUi.condition) {
      xUi.condition = { ...card.xUi.condition };
    }
    if (Object.keys(xUi).length > 0) {
      property["x-ui"] = xUi;
    }
  }
  return property;
}

export function fieldCardsToJsonSchema(
  cards: readonly SchemaFieldCard[],
): GraphSchema {
  const named = cards.filter((card) => card.name.trim().length > 0);
  if (named.length === 0) {
    return graphValueMapSchema.parse({});
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const card of named) {
    properties[card.name] = compileProperty(card);
    if (card.required) {
      required.push(card.name);
    }
  }
  return graphValueMapSchema.parse({
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  });
}

export function jsonSchemaToFieldCards(schema: unknown): SchemaFieldCard[] {
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) {
    return [];
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  return Object.entries(schema.properties).map(([name, raw]) => {
    const property = isJsonObject(raw) ? raw : {};
    const type = asFieldType(property.type) ?? "string";
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((item): item is string => typeof item === "string")
      : [];
    const card: SchemaFieldCard = {
      name,
      type,
      required: required.has(name),
      description:
        typeof property.description === "string" ? property.description : "",
      defaultValue: defaultToEditor(type, property.default),
      enumValues,
      ...(typeof property.minLength === "number"
        ? { minLength: property.minLength }
        : {}),
      ...(typeof property.maxLength === "number"
        ? { maxLength: property.maxLength }
        : {}),
      ...(typeof property.pattern === "string"
        ? { pattern: property.pattern }
        : {}),
      ...(typeof property.minimum === "number"
        ? { minimum: property.minimum }
        : {}),
      ...(typeof property.maximum === "number"
        ? { maximum: property.maximum }
        : {}),
    };
    const xUi = parseUiHint(property["x-ui"]);
    return xUi ? { ...card, xUi } : card;
  });
}

export function defaultValueFromSchema(
  schema: unknown,
): Record<string, unknown> {
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) {
    return {};
  }
  const values: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (isJsonObject(raw) && Object.hasOwn(raw, "default")) {
      values[name] = raw.default;
    } else if (isJsonObject(raw) && raw.type === "boolean") {
      values[name] = false;
    }
  }
  return values;
}

export function schemaRequiredNames(schema: unknown): readonly string[] {
  if (!isJsonObject(schema) || !Array.isArray(schema.required)) {
    return [];
  }
  return schema.required.filter((item): item is string => typeof item === "string");
}

export function missingRequiredFields(
  schema: unknown,
  values: Record<string, unknown>,
): readonly string[] {
  return schemaRequiredNames(schema).filter((name) => {
    const value = values[name];
    return value === undefined || value === null || value === "";
  });
}

export function readPropertySchema(
  schema: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) {
    return undefined;
  }
  const property = schema.properties[name];
  return isJsonObject(property) ? property : undefined;
}
