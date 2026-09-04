const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_MEMBERS = 1_024;
const MAX_UNIQUE_ITEMS = 1_000;

const ASSERTION_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "nullable",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

const STRING_ANNOTATION_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "format",
  "contentEncoding",
  "contentMediaType",
]);

const BOOLEAN_ANNOTATION_KEYS = new Set([
  "deprecated",
  "readOnly",
  "writeOnly",
]);

export class JsonSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSchemaValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null) {
    return left === right;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => sameJson(left[key], right[key]))
    );
  }
  return false;
}

function fail(message: string): never {
  throw new JsonSchemaValidationError(message);
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  const number = assertFiniteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return number;
}

function assertJsonLiteral(
  value: unknown,
  path: string,
  depth: number,
  budget: { remaining: number },
): void {
  budget.remaining -= 1;
  if (depth > MAX_SCHEMA_DEPTH || budget.remaining < 0) {
    fail(`Schema literal at ${path} exceeds complexity limits`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SCHEMA_MEMBERS) {
      fail(`Schema literal at ${path} has too many items`);
    }
    value.forEach((entry, index) =>
      assertJsonLiteral(entry, `${path}/${index}`, depth + 1, budget),
    );
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_SCHEMA_MEMBERS) {
      fail(`Schema literal at ${path} has too many properties`);
    }
    for (const [key, entry] of entries) {
      assertJsonLiteral(entry, `${path}/${key}`, depth + 1, budget);
    }
    return;
  }
  fail(`Schema literal at ${path} is not JSON`);
}

function typeNames(schema: Record<string, unknown>): readonly string[] | undefined {
  if (schema.type === undefined) {
    return undefined;
  }
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (
    Array.isArray(schema.type) &&
    schema.type.length > 0 &&
    schema.type.length <= 8 &&
    schema.type.every((entry) => typeof entry === "string")
  ) {
    return schema.type;
  }
  fail("Schema type must be a string or a non-empty array of strings");
}

export function assertBoundedJsonSchema(
  schema: unknown,
  path = "#",
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_SCHEMA_NODES },
): void {
  budget.remaining -= 1;
  if (depth > MAX_SCHEMA_DEPTH || budget.remaining < 0) {
    fail(`Schema at ${path} exceeds the maximum nesting depth`);
  }
  if (typeof schema === "boolean") {
    return;
  }
  if (!isPlainObject(schema)) {
    fail(`Schema at ${path} must be a boolean or a plain object`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) {
      fail(`Schema at ${path}/${key} is not JSON`);
    }
    if (
      !ASSERTION_KEYS.has(key) &&
      !STRING_ANNOTATION_KEYS.has(key) &&
      !BOOLEAN_ANNOTATION_KEYS.has(key) &&
      key !== "default" &&
      key !== "examples"
    ) {
      fail(`Schema at ${path} uses unsupported keyword ${key}`);
    }
    if (STRING_ANNOTATION_KEYS.has(key) && typeof value !== "string") {
      fail(`Schema at ${path} annotation ${key} must be a string`);
    }
    if (BOOLEAN_ANNOTATION_KEYS.has(key) && typeof value !== "boolean") {
      fail(`Schema at ${path} annotation ${key} must be a boolean`);
    }
    if (key === "default") {
      assertJsonLiteral(value, `${path}/default`, depth + 1, budget);
    }
    if (key === "examples") {
      if (!Array.isArray(value) || value.length > MAX_SCHEMA_MEMBERS) {
        fail(`Schema at ${path} examples must be an array`);
      }
      value.forEach((entry, index) =>
        assertJsonLiteral(
          entry,
          `${path}/examples/${index}`,
          depth + 1,
          budget,
        ),
      );
    }
  }
  const types = typeNames(schema);
  if (types) {
    if (new Set(types).size !== types.length) {
      fail(`Schema at ${path} repeats a type`);
    }
    for (const type of types) {
      if (
        !["object", "array", "string", "number", "integer", "boolean", "null"].includes(
          type,
        )
      ) {
        fail(`Schema at ${path} uses unsupported type ${type}`);
      }
    }
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      fail(`Schema at ${path} properties must be a plain object`);
    }
    if (Object.keys(schema.properties).length > MAX_SCHEMA_MEMBERS) {
      fail(`Schema at ${path} has too many properties`);
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      assertBoundedJsonSchema(
        property,
        `${path}/properties/${key}`,
        depth + 1,
        budget,
      );
    }
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.length > MAX_SCHEMA_MEMBERS ||
      schema.required.some((entry) => typeof entry !== "string")
    ) {
      fail(`Schema at ${path} required must be an array of strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      fail(`Schema at ${path} required contains duplicates`);
    }
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties !== "boolean") {
      assertBoundedJsonSchema(
        schema.additionalProperties,
        `${path}/additionalProperties`,
        depth + 1,
        budget,
      );
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      fail(`Schema at ${path} tuple items are unsupported`);
    }
    assertBoundedJsonSchema(schema.items, `${path}/items`, depth + 1, budget);
  }
  if (schema.minItems !== undefined) {
    assertNonNegativeInteger(schema.minItems, `${path} minItems`);
  }
  if (schema.maxItems !== undefined) {
    assertNonNegativeInteger(schema.maxItems, `${path} maxItems`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    fail(`${path} uniqueItems must be a boolean`);
  }
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > MAX_SCHEMA_MEMBERS
    ) {
      fail(`Schema at ${path} enum must be a non-empty array`);
    }
    schema.enum.forEach((entry, index) =>
      assertJsonLiteral(entry, `${path}/enum/${index}`, depth + 1, budget),
    );
  }
  if (schema.const !== undefined) {
    assertJsonLiteral(schema.const, `${path}/const`, depth + 1, budget);
  }
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
    fail(`Schema at ${path} nullable must be a boolean`);
  }
  if (schema.minProperties !== undefined) {
    assertNonNegativeInteger(schema.minProperties, `${path} minProperties`);
  }
  if (schema.maxProperties !== undefined) {
    assertNonNegativeInteger(schema.maxProperties, `${path} maxProperties`);
  }
  if (schema.minLength !== undefined) {
    assertNonNegativeInteger(schema.minLength, `${path} minLength`);
  }
  if (schema.maxLength !== undefined) {
    assertNonNegativeInteger(schema.maxLength, `${path} maxLength`);
  }
  if (schema.minimum !== undefined) {
    assertFiniteNumber(schema.minimum, `${path} minimum`);
  }
  if (schema.maximum !== undefined) {
    assertFiniteNumber(schema.maximum, `${path} maximum`);
  }
  if (schema.exclusiveMinimum !== undefined) {
    if (typeof schema.exclusiveMinimum === "boolean") {
      if (schema.minimum === undefined) {
        fail(`${path} boolean exclusiveMinimum requires minimum`);
      }
    } else {
      assertFiniteNumber(schema.exclusiveMinimum, `${path} exclusiveMinimum`);
    }
  }
  if (schema.exclusiveMaximum !== undefined) {
    if (typeof schema.exclusiveMaximum === "boolean") {
      if (schema.maximum === undefined) {
        fail(`${path} boolean exclusiveMaximum requires maximum`);
      }
    } else {
      assertFiniteNumber(schema.exclusiveMaximum, `${path} exclusiveMaximum`);
    }
  }
  if (schema.multipleOf !== undefined) {
    const multipleOf = assertFiniteNumber(schema.multipleOf, `${path} multipleOf`);
    if (multipleOf <= 0) {
      fail(`${path} multipleOf must be greater than 0`);
    }
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function validateSchema(
  schema: unknown,
  value: unknown,
  path: string,
  depth: number,
  budget: { remaining: number },
): void {
  budget.remaining -= 1;
  if (depth > MAX_SCHEMA_DEPTH || budget.remaining < 0) {
    fail(`Value at ${path} exceeds complexity limits`);
  }
  if (schema === true) {
    return;
  }
  if (schema === false) {
    fail(`Value at ${path} is rejected by a boolean schema`);
  }
  if (!isPlainObject(schema)) {
    fail(`Schema at ${path} is invalid`);
  }
  const types = typeNames(schema);
  const nullable = schema.nullable === true;
  if (types) {
    const allowed = nullable ? [...types, "null"] : types;
    if (!allowed.some((type) => matchesType(value, type))) {
      fail(`Value at ${path} does not match type ${allowed.join("|")}`);
    }
  } else if (nullable && value === null) {
    return;
  }
  if (schema.const !== undefined && !sameJson(value, schema.const)) {
    fail(`Value at ${path} does not match const`);
  }
  if (schema.enum !== undefined) {
    const options = schema.enum as readonly unknown[];
    if (!options.some((option) => sameJson(value, option))) {
      fail(`Value at ${path} does not match enum`);
    }
  }
  if (typeof value === "string") {
    const minLength = asNumber(schema.minLength);
    const maxLength = asNumber(schema.maxLength);
    if (minLength !== undefined && value.length < minLength) {
      fail(`Value at ${path} is shorter than minLength`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
      fail(`Value at ${path} is longer than maxLength`);
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const minimum = asNumber(schema.minimum);
    const maximum = asNumber(schema.maximum);
    const exclusiveMinimum = asNumber(schema.exclusiveMinimum);
    const exclusiveMaximum = asNumber(schema.exclusiveMaximum);
    const multipleOf = asNumber(schema.multipleOf);
    if (minimum !== undefined) {
      if (schema.exclusiveMinimum === true ? value <= minimum : value < minimum) {
        fail(`Value at ${path} is below minimum`);
      }
    }
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
      fail(`Value at ${path} is below exclusiveMinimum`);
    }
    if (maximum !== undefined) {
      if (schema.exclusiveMaximum === true ? value >= maximum : value > maximum) {
        fail(`Value at ${path} is above maximum`);
      }
    }
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
      fail(`Value at ${path} is above exclusiveMaximum`);
    }
    if (multipleOf !== undefined) {
      const quotient = value / multipleOf;
      if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-10) {
        fail(`Value at ${path} is not a multiple of ${multipleOf}`);
      }
    }
  }
  if (Array.isArray(value)) {
    const minItems = asNumber(schema.minItems);
    const maxItems = asNumber(schema.maxItems);
    if (minItems !== undefined && value.length < minItems) {
      fail(`Value at ${path} has fewer than minItems`);
    }
    if (maxItems !== undefined && value.length > maxItems) {
      fail(`Value at ${path} has more than maxItems`);
    }
    if (schema.uniqueItems === true) {
      if (value.length > MAX_UNIQUE_ITEMS) {
        fail(`Value at ${path} has too many items for uniqueItems`);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (
          value.some(
            (entry, other) => other !== index && sameJson(entry, value[index]),
          )
        ) {
          fail(`Value at ${path} contains duplicate items`);
        }
      }
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        validateSchema(
          schema.items,
          entry,
          `${path}/${index}`,
          depth + 1,
          budget,
        );
      });
    }
  }
  if (isPlainObject(value)) {
    const propertyCount = Object.keys(value).length;
    const minProperties = asNumber(schema.minProperties);
    const maxProperties = asNumber(schema.maxProperties);
    if (minProperties !== undefined && propertyCount < minProperties) {
      fail(`Value at ${path} has fewer than minProperties`);
    }
    if (maxProperties !== undefined && propertyCount > maxProperties) {
      fail(`Value at ${path} has more than maxProperties`);
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        fail(`Value at ${path} is missing required property ${key}`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateSchema(
          properties[key],
          entry,
          `${path}/${key}`,
          depth + 1,
          budget,
        );
        continue;
      }
      if (schema.additionalProperties === false) {
        fail(`Value at ${path} has unexpected property ${key}`);
      }
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        validateSchema(
          schema.additionalProperties,
          entry,
          `${path}/${key}`,
          depth + 1,
          budget,
        );
      }
    }
  }
}

export function validateAgainstJsonSchema(
  schema: unknown,
  value: unknown,
):
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: JsonSchemaValidationError } {
  try {
    assertBoundedJsonSchema(schema);
    validateSchema(schema, value, "#", 0, { remaining: MAX_SCHEMA_NODES });
    return { success: true, data: value };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof JsonSchemaValidationError
          ? error
          : new JsonSchemaValidationError(
              error instanceof Error ? error.message : String(error),
            ),
    };
  }
}
