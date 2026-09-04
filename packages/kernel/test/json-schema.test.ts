import { describe, expect, it } from "vitest";
import {
  assertBoundedJsonSchema,
  validateAgainstJsonSchema,
} from "../src/json-schema";

describe("bounded JSON Schema validator", () => {
  it("accepts the object/array/scalar subset used by Borg tools", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Echo",
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0, maximum: 3 },
        flag: { type: "boolean" },
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
        },
        nested: {
          type: "object",
          properties: { id: { const: "fixed" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      required: ["text"],
      additionalProperties: false,
    };

    expect(() => assertBoundedJsonSchema(schema)).not.toThrow();
    expect(
      validateAgainstJsonSchema(schema, {
        text: "hello",
        count: 2,
        flag: true,
        tags: ["a"],
        nested: { id: "fixed" },
      }).success,
    ).toBe(true);
    expect(validateAgainstJsonSchema(schema, { text: "" }).success).toBe(false);
    expect(
      validateAgainstJsonSchema(schema, { text: "hello", extra: true }).success,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(schema, { text: "hello", count: 1.5 }).success,
    ).toBe(false);
  });

  it("supports type unions, null, and additionalProperties schemas", () => {
    const schema = {
      type: "object",
      properties: {
        value: { type: ["string", "null"] },
      },
      additionalProperties: { type: "number", exclusiveMinimum: 0 },
    };

    expect(validateAgainstJsonSchema(schema, { value: null, n: 1 }).success).toBe(
      true,
    );
    expect(validateAgainstJsonSchema(schema, { value: "x", n: 0 }).success).toBe(
      false,
    );
    expect(
      validateAgainstJsonSchema(
        { type: "object", minProperties: 1, maxProperties: 1 },
        {},
      ).success,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(
        { type: "array", items: { type: "number" } },
        Array.from({ length: 10_001 }, () => 1),
      ).success,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(
        { type: "object", minProperties: 1, maxProperties: 1 },
        { value: true, extra: true },
      ).success,
    ).toBe(false);
  });

  it("fails closed on unsupported or dangerous schema keywords", () => {
    expect(() => assertBoundedJsonSchema({ $ref: "#/$defs/x" })).toThrow(
      /unsupported keyword/,
    );
    expect(() =>
      assertBoundedJsonSchema({ oneOf: [{ type: "string" }, { type: "number" }] }),
    ).toThrow(/unsupported keyword/);
    expect(() =>
      assertBoundedJsonSchema({ type: "string", pattern: "^a+$" }),
    ).toThrow(/unsupported keyword/);
    expect(() =>
      assertBoundedJsonSchema({
        type: "array",
        prefixItems: [{ type: "string" }],
      }),
    ).toThrow(/unsupported keyword/);
    expect(() =>
      assertBoundedJsonSchema({
        type: "array",
        minContains: 1,
      }),
    ).toThrow(/unsupported keyword minContains/);
    expect(() =>
      assertBoundedJsonSchema({
        type: "array",
        maxContains: 2,
      }),
    ).toThrow(/unsupported keyword maxContains/);
    expect(() =>
      assertBoundedJsonSchema({
        type: "array",
        items: { type: "string" },
        additionalItems: false,
      }),
    ).toThrow(/unsupported keyword/);
    expect(() =>
      assertBoundedJsonSchema({
        type: "string",
        unknownConstraint: 1,
      }),
    ).toThrow(/unsupported keyword/);
    expect(
      validateAgainstJsonSchema({ $ref: "#/properties/x" }, { x: 1 }).success,
    ).toBe(false);
    expect(() =>
      assertBoundedJsonSchema({
        enum: [
          Array.from({ length: 20 }, () => []).reduce<unknown[]>(
            (nested) => [nested],
            [],
          ),
        ],
      }),
    ).toThrow(/complexity limits/);
  });

  it("treats format and standard metadata as annotations", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Contact",
      description: "Contact address",
      type: "string",
      format: "email",
      default: "nobody@example.test",
      examples: ["somebody@example.test"],
      readOnly: false,
    };
    expect(() => assertBoundedJsonSchema(schema)).not.toThrow();
    expect(validateAgainstJsonSchema(schema, "not-an-email").success).toBe(true);
    expect(() =>
      assertBoundedJsonSchema({ type: "string", format: true }),
    ).toThrow(/annotation format must be a string/);
  });
});
