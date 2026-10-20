import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it.each([
    [
      "removes required when no fields match properties",
      {
        type: "object",
        properties: { action: { type: "string" } },
        required: ["missing_a", "missing_b"],
      },
      { type: "object", properties: { action: { type: "string" } } },
    ],
    [
      "removes required when properties is absent",
      { type: "object", required: ["a", "b"] },
      { type: "object" },
    ],
    [
      "coerces nested null properties while preserving valid siblings",
      {
        type: "object",
        properties: { bad: { type: "object", properties: null }, good: { type: "string" } },
      },
      {
        type: "object",
        properties: { bad: { type: "object", properties: {} }, good: { type: "string" } },
      },
    ],
    [
      "collapses type arrays by stripping null entries",
      { type: ["string", "null"], description: "nullable field" },
      { type: "string", description: "nullable field" },
    ],
    [
      "stringifies an integer const before type without changing the schema type",
      { const: 42, type: "integer" },
      { enum: ["42"], type: "integer" },
    ],
    [
      "returns no enum key when array becomes empty after coercion",
      { type: "integer", enum: [null, undefined, {}] },
      { type: "integer" },
    ],
  ])("%s", (_name, input, expected) => {
    expect(cleanSchemaForGemini(input)).toStrictEqual(expected);
  });

  it("strips empty required arrays in nested schemas", () => {
    const nested = { type: "object", properties: { optional: { type: "string" } } };
    expect(
      cleanSchemaForGemini({
        type: "object",
        properties: { nested: { ...nested, required: [] } },
        required: ["nested"],
      }),
    ).toStrictEqual({ type: "object", properties: { nested }, required: ["nested"] });
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        outer: {
          type: "array",
          items: {
            type: "object",
            properties: { score: { type: "number", enum: [1, 2, 3, 4, 5] } },
          },
        },
      },
    });
    expect(cleaned).toHaveProperty("properties.outer.items.properties.score", {
      type: "number",
      enum: ["1", "2", "3", "4", "5"],
    });
  });

  it("preserves the type behind a percent-encoded local schema reference", () => {
    const filter = { type: "object", properties: { limit: { type: "number" } } };
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { "Filter/value~": filter },
        properties: { filter: { $ref: "#%2F%24defs%2FFilter%7E1value%7E0" } },
      }),
    ).toStrictEqual({ type: "object", properties: { filter } });
  });

  it("resolves same-named definitions in the namespace named by each reference", () => {
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { Value: { type: "string" } },
        definitions: { Value: { type: "integer" } },
        properties: {
          modern: { $ref: "#/$defs/Value" },
          legacy: { $ref: "#/definitions/Value" },
        },
      }),
    ).toStrictEqual({
      type: "object",
      properties: { modern: { type: "string" }, legacy: { type: "integer" } },
    });
  });

  it("preserves shared definitions across inline and reference traversal", () => {
    const node = {
      type: "object",
      properties: { next: { $ref: "#/$defs/Node" } },
    };
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { Node: node },
        properties: { head: node },
        required: ["head"],
      }),
    ).toStrictEqual({
      type: "object",
      properties: {
        head: {
          type: "object",
          properties: { next: { type: "object", properties: { next: {} } } },
        },
      },
      required: ["head"],
    });
  });
});
