import { describe, expect, it } from "vitest";
import { projectAnthropicTools } from "./anthropic-tool-projection.js";
import { publishRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

const tool = (
  name: string,
  parameters: Record<string, unknown> = { type: "object", properties: {} },
  description = name,
) => ({ name, parameters, description });

describe("projectAnthropicTools", () => {
  it("retains same-original duplicates while sorting their descriptions", () => {
    const projection = projectAnthropicTools(
      ["Zulu", "Alpha"].map((description) => tool("Read", undefined, description)),
      (name) => name.toLowerCase(),
    );

    expect(projection.inputToolCount).toBe(2);
    expect(projection.unavailableOriginalNames).toEqual(new Set());
    expect(projection.tools).toEqual(
      ["Alpha", "Zulu"].map((description) => ({
        originalName: "Read",
        wireName: "read",
        description,
        inputSchema: { type: "object", properties: {}, required: [] },
      })),
    );
  });

  it("keeps the first accepted spelling in a collision after Read duplicates", () => {
    expect(() =>
      projectAnthropicTools(
        ["Read", "Read", "read"].map((name) => tool(name, { type: "object" })),
        () => "Read",
      ),
    ).toThrow('Anthropic tool names "Read" and "read" both map to "Read"');
  });

  it.each(
    [undefined, "http://json-schema.org/draft-07/schema#"].flatMap((dialect) =>
      ["runtime", "published"].map((mode) => ({ dialect, mode })),
    ),
  )("preserves constraints and tuples ($dialect, $mode)", ({ dialect, mode }) => {
    const definitionsKey = dialect ? "definitions" : "$defs";
    const root = {
      type: "object",
      properties: { range: { $ref: `#/${definitionsKey}/Range` } },
      required: ["range"],
      additionalProperties: false,
      allOf: [{ propertyNames: { enum: ["range"] } }],
    };
    const tuple = (items: Record<string, string>[]) => ({
      ...(dialect ? { $schema: dialect } : {}),
      type: "array",
      items,
    });
    const parameters = {
      ...root,
      ...(dialect ? { $schema: dialect } : {}),
      [definitionsKey]: {
        Range: { ...tuple([{ type: "integer" }, { type: "integer" }]), additionalItems: false },
        Trailing: tuple([]),
      },
    };
    const original = structuredClone(parameters);
    const source =
      mode === "published" ? publishRuntimeToolInputSchema(parameters).schema : parameters;
    const tools = [tool("select_range", source)];
    const projection = projectAnthropicTools(tools, (name) => name);

    expect(projection.tools[0]?.inputSchema).toEqual({
      ...root,
      [definitionsKey]: {
        Range: {
          type: "array",
          prefixItems: [{ type: "integer" }, { type: "integer" }],
          items: false,
        },
        Trailing: { type: "array", prefixItems: [] },
      },
    });
    expect(parameters).toEqual(original);
    if (mode === "published") {
      expect(projectAnthropicTools(tools, (name) => name).tools[0]?.inputSchema).toBe(
        projection.tools[0]?.inputSchema,
      );
      expect(source).toEqual(original);
    }
  });

  it("quarantines Anthropic tools with non-finite numeric schema values", () => {
    const projection = projectAnthropicTools(
      [
        tool("BadLimits", {
          type: "object",
          properties: {
            amount: { type: "number", maximum: Number.POSITIVE_INFINITY },
          },
        }),
        tool("Lookup"),
      ],
      (name) => name.toLowerCase(),
    );

    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0]?.wireName).toBe("lookup");
    expect(projection.unavailableOriginalNames).toEqual(new Set(["BadLimits"]));
  });
});
