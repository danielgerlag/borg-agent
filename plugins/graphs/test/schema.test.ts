import { describe, expect, it } from "vitest";
import {
  defaultValueFromSchema,
  evaluateFieldCondition,
  fieldCardsToJsonSchema,
  isNoopSchema,
  jsonSchemaToFieldCards,
  missingRequiredFields,
  schemaHasProperties,
  type SchemaFieldCard,
} from "../src/schema";

const queryCard: SchemaFieldCard = {
  name: "query",
  type: "string",
  required: true,
  description: "Search text",
  defaultValue: "hello",
  enumValues: [],
  xUi: { widget: "textarea", rows: 4 },
};

describe("graph schema cards", () => {
  it("compiles no cards to an empty schema", () => {
    expect(fieldCardsToJsonSchema([])).toEqual({});
    expect(isNoopSchema({})).toBe(true);
    expect(schemaHasProperties({})).toBe(false);
    expect(jsonSchemaToFieldCards({})).toEqual([]);
  });

  it("stores x-ui on properties only", () => {
    const schema = fieldCardsToJsonSchema([queryCard]);
    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search text",
          default: "hello",
          "x-ui": { widget: "textarea", rows: 4 },
        },
      },
    });
    expect("x-ui" in schema).toBe(false);
    expect(jsonSchemaToFieldCards(schema)).toEqual([queryCard]);
  });

  it("hides fields when x-ui.condition fails", () => {
    expect(
      evaluateFieldCondition({ field: "enabled", eq: true }, { enabled: true }),
    ).toBe(true);
    expect(
      evaluateFieldCondition({ field: "enabled", eq: true }, { enabled: false }),
    ).toBe(false);
    expect(evaluateFieldCondition({ field: "note" }, { note: "x" })).toBe(true);
    expect(evaluateFieldCondition({ field: "note" }, { note: "" })).toBe(false);
  });

  it("reads property defaults and required names", () => {
    const schema = fieldCardsToJsonSchema([
      queryCard,
      {
        name: "count",
        type: "number",
        required: false,
        description: "",
        defaultValue: "3",
        enumValues: [],
      },
    ]);
    expect(defaultValueFromSchema(schema)).toEqual({
      query: "hello",
      count: 3,
    });
    expect(missingRequiredFields(schema, {})).toEqual(["query"]);
    expect(missingRequiredFields(schema, { query: "x" })).toEqual([]);
  });
});
