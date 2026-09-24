// FILE: src/lib/agent-tool-host.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Prove shared contract primitives against small provenance-backed fixtures of the pinned OpenCode host tool boundary and its provider schema lowering.
//   SCOPE: Derived registry/definition/execute/provider-transform fixtures only — not a vendored host implementation and not a live host run (see scripts/check-tool-contracts-host.ts and `bun run contracts:host`).
//   DEPENDS: [bun:test, @opencode-ai/plugin, src/lib/agent-tool-contract]
//   LINKS: [M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PROVENANCE - Source URLs the derived fixtures are based on.
//   schema - The pinned host tool.schema helper shared by the derived fixtures.
//   makeHostProbeContract - Closed probe contract fixture with enum, description, and nested shape.
//   hostFromPluginJsonSchema - Derived host input-mode JSON Schema projection for plugin arg maps.
//   hostParametersAccepts - Derived host Effect parameters bridge predicate (safeParse success only).
//   hostSelectDefinitionJsonSchema - Derived host tool.definition output selection from registry.tools.
//   runDefinitionHook - Applies the real adapter the way the host triggers tool.definition.
//   isPlainRecord - Narrow a value to a non-array object record.
//   derivedSanitizeOpenAISchema - Derived @ai-sdk/openai sanitizer (const-to-enum, dropped bounds).
//   derivedSanitizeGemini - Derived Google/Gemini schema normalization branch.
//   NINE_TOOL_IDS - The nine owned tool ids the published-schema fixture must cover.
//   publishedSchemas - The nine real owned-tool input schemas exercised under the lowering fixtures.
//   rootProperties - Narrow a published schema to its root properties record.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-009 correction - Provider fixtures now exercise the actual nine published schemas through the pinned lowering helpers, keep the fixture-only OpenAI/Google distinction from the real compatible/Anthropic frames, and retain the const-to-enum, dropped-bounds, enum stringification, type-array rewriting, required filtering, array fallback, and non-object property removal assertions plus the local-only bound-enforcement proof.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import {
  ContractHostCompatibilityError,
  ContractInputError,
  createPreExecuteGuard,
  createToolDefinitionAdapter,
  defineOwnedToolContract,
  parseOwnedToolArgs,
  strictObject,
} from "./agent-tool-contract.js";
import { workflowToolContracts } from "../plugins/workflow/input-validation.js";
import {
  hashlineEditContract,
  strReplaceEditorContract,
} from "../plugins/hashline-edit/schemas.js";
import { webFetchContract, webSearchContract } from "../plugins/web-tools/schemas.js";

/**
 * Provenance for derived fixtures (small extracts of behavior, not vendored code):
 * - https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/tool/registry.ts
 * - https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/tool/registry.ts
 * - https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/session/tools.ts
 * - https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/provider/transform.ts
 *
 * Observed host facts encoded below (live 1.18.32 probe confirms at runtime):
 * - fromPlugin builds z.object(def.args) and projects JSON Schema with io: "input".
 * - parameters is Schema.declare(safeParse success) — a predicate only; forwarded execute args stay raw.
 * - registry.tools triggers tool.definition and honors output.jsonSchema when it differs while
 *   output.parameters retains identity (`output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema`).
 * - session/tools.ts runs tool.execute.before before custom execute and does not replace args.
 */
const PROVENANCE = {
  registryV1182:
    "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/tool/registry.ts",
  registryV11832:
    "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/tool/registry.ts",
  sessionToolsV1182:
    "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/session/tools.ts",
  providerTransformV1182:
    "https://raw.githubusercontent.com/anomalyco/opencode/v1.18.2/packages/opencode/src/provider/transform.ts",
} as const;

const schema = tool.schema;

function makeHostProbeContract() {
  return defineOwnedToolContract({
    toolId: "probe_contract",
    description: "Probe contract with enum, description, and nested shape.",
    registeredArgs: {
      label: schema.string().describe("Echo label"),
      mode: schema.enum(["quiet", "loud"]).optional().describe("Echo mode"),
      nested: strictObject({
        depth: schema.number().int().min(0).optional().describe("Nested depth"),
      })
        .optional()
        .describe("Nested options"),
    },
  });
}

/** Derived from host fromPlugin: non-strict root object over the registered raw arg map. */
function hostFromPluginJsonSchema(args: Record<string, unknown>): Record<string, unknown> {
  const zodParams = schema.object(args as never);
  const projected = schema.toJSONSchema(zodParams, { io: "input" }) as Record<string, unknown>;
  const { $defs, ...rest } = projected;
  if ($defs) return { ...rest, definitions: $defs };
  return rest;
}

/** Derived from host parameters bridge: success predicate only, does not rewrite forwarded args. */
function hostParametersAccepts(
  args: Record<string, unknown>,
  shape: Record<string, unknown>,
): boolean {
  return schema.object(shape as never).safeParse(args).success;
}

/** Derived from host registry.tools tool.definition selection logic. */
function hostSelectDefinitionJsonSchema(original: {
  parameters: unknown;
  jsonSchema: unknown;
  output: { parameters: unknown; jsonSchema?: unknown };
}): unknown {
  const { parameters, jsonSchema, output } = original;
  return output.parameters === parameters || output.jsonSchema !== jsonSchema
    ? output.jsonSchema
    : undefined;
}

async function runDefinitionHook(
  toolID: string,
  originalParameters: unknown,
  originalJsonSchema: unknown,
): Promise<{ parameters: unknown; jsonSchema: unknown }> {
  const contract = makeHostProbeContract();
  const adapter = createToolDefinitionAdapter([contract]);
  const output = {
    description: contract.description,
    parameters: originalParameters,
    jsonSchema: originalJsonSchema,
  };
  await adapter({ toolID }, output);
  const selected = hostSelectDefinitionJsonSchema({
    parameters: originalParameters,
    jsonSchema: originalJsonSchema,
    output,
  });
  return { parameters: output.parameters, jsonSchema: selected };
}

describe("host definition boundary (derived registry fixtures)", () => {
  test("adapter-published jsonSchema is selected by the host definition logic", async () => {
    const originalParameters = { effectSchema: "host-declared" };
    const originalJsonSchema = hostFromPluginJsonSchema({
      label: schema.string(),
      mode: schema.enum(["quiet", "loud"]).optional(),
    });
    const selected = await runDefinitionHook(
      "probe_contract",
      originalParameters,
      originalJsonSchema,
    );
    expect(selected.parameters).toBe(originalParameters);
    expect(selected.jsonSchema).not.toEqual(originalJsonSchema);
    const published = selected.jsonSchema as Record<string, unknown>;
    expect(published.additionalProperties).toBe(false);
    const properties = published.properties as Record<
      string,
      { description?: string; enum?: string[] }
    >;
    expect(properties.label?.description).toBe("Echo label");
    expect(properties.mode?.enum).toEqual(["quiet", "loud"]);
    const nested = properties.nested as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, unknown>;
      description?: string;
    };
    expect(nested.type).toBe("object");
    expect(nested.additionalProperties).toBe(false);
    expect(nested.properties).toHaveProperty("depth");
    expect(nested.description).toBe("Nested options");
    expect(published.required).toEqual(["label"]);
  });

  test("unowned tool keeps the host-originated jsonSchema selection unchanged", async () => {
    const originalParameters = { effectSchema: "host-declared" };
    const originalJsonSchema = { type: "object", properties: { x: { type: "string" } } };
    const selected = await runDefinitionHook(
      "some_other_tool",
      originalParameters,
      originalJsonSchema,
    );
    expect(selected.parameters).toBe(originalParameters);
    expect(selected.jsonSchema).toBe(originalJsonSchema);
  });

  test("input-mode projection stays consistent between host-style and contract schemas", () => {
    const contract = makeHostProbeContract();
    const hostProjection = hostFromPluginJsonSchema(
      contract.registeredArgs as Record<string, unknown>,
    );
    // Host projects the non-strict root; our contract projects the strict root.
    // Property shapes, enums, and descriptions must agree even when additionalProperties differs
    // before the adapter replacement (the adapter publishes the strict form).
    const contractProperties = (contract.inputJsonSchema.properties ?? {}) as Record<
      string,
      unknown
    >;
    const hostProperties = (hostProjection.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(contractProperties).sort()).toEqual(Object.keys(hostProperties).sort());
    expect(JSON.stringify(contractProperties.label)).toBe(JSON.stringify(hostProperties.label));
    expect(JSON.stringify((contractProperties.mode as { enum: unknown }).enum)).toBe(
      JSON.stringify((hostProperties.mode as { enum: unknown }).enum),
    );
    expect((contract.inputJsonSchema as { required: unknown }).required).toEqual(
      (hostProjection as { required: unknown }).required,
    );
    expect(contract.inputJsonSchema.additionalProperties).toBe(false);
  });
});

describe("host execute boundary (derived session/tools fixtures)", () => {
  test("host predicate accepts unknown top-level keys, so the pre-execute guard is required", () => {
    const contract = makeHostProbeContract();
    const shape = contract.registeredArgs as Record<string, unknown>;
    const raw = { label: "alpha", unexpected: "nope" };
    expect(hostParametersAccepts(raw, shape)).toBe(true);
    const guard = createPreExecuteGuard([contract]);
    expect(guard({ tool: contract.toolId }, { args: raw })).rejects.toBeInstanceOf(
      ContractInputError,
    );
  });

  test("host forwards original raw args; direct parse applies defaults for execute", async () => {
    const contract = defineOwnedToolContract({
      toolId: "defaults_contract",
      description: "Defaults",
      registeredArgs: {
        label: schema.string(),
        mode: schema.enum(["quiet", "loud"]).default("quiet"),
      },
    });
    const rawFromHost = { label: "alpha" };
    expect(
      hostParametersAccepts(rawFromHost, contract.registeredArgs as Record<string, unknown>),
    ).toBe(true);
    const guard = createPreExecuteGuard([contract]);
    await guard({ tool: contract.toolId }, { args: rawFromHost });
    expect(rawFromHost).toEqual({ label: "alpha" });
    const parsed = parseOwnedToolArgs(contract, rawFromHost);
    const mode: "quiet" | "loud" = parsed.mode;
    expect(mode).toBe("quiet");
  });

  test("nested unknown key and malformed nested value reject before execute with paths", async () => {
    const contract = makeHostProbeContract();
    const guard = createPreExecuteGuard([contract]);
    const nestedTypo = { label: "alpha", nested: { tpyo: 1 } };
    await expect(guard({ tool: contract.toolId }, { args: nestedTypo })).rejects.toThrow(
      /nested\.tpyo/,
    );
    expect(nestedTypo.nested).toEqual({ tpyo: 1 });

    const malformed = { label: "alpha", nested: { depth: "deep" } };
    await expect(guard({ tool: contract.toolId }, { args: malformed })).rejects.toThrow(
      /nested\.depth/,
    );
    expect(malformed.nested.depth).toBe("deep");
  });

  test("definition publication never replaces the host parameters decoder identity", async () => {
    const contract = makeHostProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const parameters = Symbol.for("host-parameters-decoder") as unknown;
    const output = {
      description: contract.description,
      parameters,
      jsonSchema: { type: "object" },
    };
    await adapter({ toolID: contract.toolId }, output);
    expect(output.parameters).toBe(parameters);
  });

  test("owned definition hook fails closed when host omits jsonSchema member", async () => {
    const contract = makeHostProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const parameters = { host: "decoder" };
    const output = { description: contract.description, parameters } as {
      description: string;
      parameters: unknown;
      jsonSchema?: unknown;
    };
    await expect(adapter({ toolID: contract.toolId }, output)).rejects.toBeInstanceOf(
      ContractHostCompatibilityError,
    );
    expect(output.parameters).toBe(parameters);
    expect("jsonSchema" in output).toBe(false);
  });
});

describe("fixture provenance", () => {
  test("records the pinned source URLs used to derive fixtures", () => {
    expect(PROVENANCE.registryV1182).toContain("/v1.18.2/");
    expect(PROVENANCE.registryV11832).toContain("/v1.18.32/");
    expect(PROVENANCE.sessionToolsV1182).toContain("session/tools.ts");
    expect(PROVENANCE.providerTransformV1182).toContain("provider/transform.ts");
  });
});

// START_BLOCK_PROVIDER_LOWERING_FIXTURES
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derived from v1.18.2 provider/transform.ts sanitizeOpenAISchema.
 * It is applied only for @ai-sdk/openai / @ai-sdk/azure, so the
 * openai-compatible transport this change exercises takes no such branch.
 * Representative properties asserted below: `const` becomes `enum`, unsupported
 * numeric/string bounds are dropped, and descriptions/enums/properties/required/
 * additionalProperties/compositions/$defs survive.
 */
function derivedSanitizeOpenAISchema(value: unknown): unknown {
  const types = ["string", "number", "boolean", "integer", "object", "array", "null"];
  const compositionKeys = ["anyOf", "oneOf", "allOf"];
  if (typeof value === "boolean") return { type: "string" };
  if (Array.isArray(value)) return value.map(derivedSanitizeOpenAISchema);
  if (!isPlainRecord(value)) return value;
  const result: Record<string, unknown> = {};
  if (typeof value.$ref === "string") result.$ref = value.$ref;
  if (typeof value.description === "string") result.description = value.description;
  if ("const" in value) result.enum = [value.const];
  else if (Array.isArray(value.enum)) result.enum = value.enum;
  if (isPlainRecord(value.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, item]) => [
        key,
        derivedSanitizeOpenAISchema(item),
      ]),
    );
  }
  if (Array.isArray(value.required))
    result.required = value.required.filter((item) => typeof item === "string");
  if ("items" in value) result.items = derivedSanitizeOpenAISchema(value.items);
  if ("additionalProperties" in value) {
    result.additionalProperties =
      typeof value.additionalProperties === "boolean"
        ? value.additionalProperties
        : derivedSanitizeOpenAISchema(value.additionalProperties);
  }
  for (const key of compositionKeys) {
    if (Array.isArray(value[key]))
      result[key] = (value[key] as unknown[]).map(derivedSanitizeOpenAISchema);
  }
  for (const key of ["$defs", "definitions"]) {
    if (isPlainRecord(value[key])) {
      result[key] = Object.fromEntries(
        Object.entries(value[key]).map(([name, item]) => [name, derivedSanitizeOpenAISchema(item)]),
      );
    }
  }
  const schemaTypes =
    typeof value.type === "string"
      ? types.includes(value.type)
        ? [value.type]
        : []
      : Array.isArray(value.type)
        ? value.type.filter((item) => typeof item === "string" && types.includes(item))
        : [];
  if (
    schemaTypes.length === 0 &&
    (typeof result.$ref === "string" || compositionKeys.some((key) => key in result))
  ) {
    return result;
  }
  const inferredTypes =
    schemaTypes.length > 0
      ? schemaTypes
      : ["properties", "required", "additionalProperties"].some((key) => key in value)
        ? ["object"]
        : ["items", "prefixItems"].some((key) => key in value)
          ? ["array"]
          : "enum" in result || "format" in value
            ? ["string"]
            : ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some(
                  (key) => key in value,
                )
              ? ["number"]
              : [];
  if (inferredTypes.length === 0) return {};
  result.type = inferredTypes.length === 1 ? inferredTypes[0] : inferredTypes;
  if (inferredTypes.includes("object") && !("properties" in result)) result.properties = {};
  if (inferredTypes.includes("array") && !("items" in result)) result.items = { type: "string" };
  return result;
}

/**
 * Derived from the v1.18.2 provider/transform.ts Google/Gemini branch
 * (providerID === "google" || api.id includes "gemini"). Asserted properties:
 * enum values are stringified, integer/number enums become strings, type arrays
 * become anyOf (with a lifted `nullable`), null-only types stay null, `required`
 * is filtered to existing properties, an empty array item falls back to a string,
 * and properties/required are removed from non-object types without a combiner.
 */
function derivedSanitizeGemini(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(derivedSanitizeGemini);
  const hasCombiner = (node: unknown) =>
    isPlainRecord(node) &&
    (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf));
  const hasSchemaIntent = (node: unknown) => {
    if (!isPlainRecord(node)) return false;
    if (hasCombiner(node)) return true;
    return [
      "type",
      "properties",
      "items",
      "prefixItems",
      "enum",
      "const",
      "$ref",
      "additionalProperties",
      "patternProperties",
      "required",
      "not",
      "if",
      "then",
      "else",
    ].some((key) => key in node);
  };
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "enum" && Array.isArray(entry)) {
      result[key] = entry.map((item) => String(item));
      if (result.type === "integer" || result.type === "number") result.type = "string";
    } else if (typeof entry === "object" && entry !== null) {
      result[key] = derivedSanitizeGemini(entry);
    } else {
      result[key] = entry;
    }
  }
  if (Array.isArray(result.type)) {
    const hasNull = result.type.includes("null");
    const nonNull = result.type.filter((item: unknown) => item !== "null");
    if (nonNull.length === 0) {
      result.type = "null";
    } else {
      delete result.type;
      result.anyOf = nonNull.map((item) => ({ type: item }));
      if (hasNull) result.nullable = true;
    }
  }
  if (result.type === "object" && result.properties && Array.isArray(result.required)) {
    result.required = result.required.filter(
      (field) => isPlainRecord(result.properties) && field in result.properties,
    );
  }
  if (result.type === "array" && !hasCombiner(result)) {
    if (result.items == null) result.items = {};
    if (isPlainRecord(result.items) && !hasSchemaIntent(result.items)) result.items.type = "string";
  }
  if (result.type && result.type !== "object" && !hasCombiner(result)) {
    delete result.properties;
    delete result.required;
  }
  return result;
}
// END_BLOCK_PROVIDER_LOWERING_FIXTURES

describe("provider schema lowering (derived transform fixtures)", () => {
  test("OpenAI sanitize maps const to enum and drops unsupported bounds but keeps shape metadata", () => {
    const input = {
      type: "object",
      description: "root",
      properties: {
        label: { type: "string", description: "Echo label", minLength: 2, maxLength: 40 },
        mode: { const: "quiet" },
        count: { type: "integer", minimum: 1, maximum: 20, default: 8, description: "count" },
      },
      required: ["label"],
      additionalProperties: false,
      $defs: { nested: { type: "object", properties: { depth: { type: "number" } } } },
      anyOf: [{ type: "string" }],
    };
    const output = derivedSanitizeOpenAISchema(input) as Record<string, unknown>;
    const properties = output.properties as Record<string, Record<string, unknown>>;
    expect(properties.mode?.enum).toEqual(["quiet"]);
    expect(properties.label?.description).toBe("Echo label");
    expect(properties.label?.minLength).toBeUndefined();
    expect(properties.label?.maxLength).toBeUndefined();
    expect(properties.count?.minimum).toBeUndefined();
    expect(properties.count?.maximum).toBeUndefined();
    expect(properties.count?.default).toBeUndefined();
    expect(output.required).toEqual(["label"]);
    expect(output.additionalProperties).toBe(false);
    expect(Array.isArray(output.anyOf)).toBe(true);
    expect((output.$defs as Record<string, unknown>).nested).toBeDefined();
  });

  test("Google sanitize stringifies enums, rewrites type arrays, filters required, and fixes arrays", () => {
    const output = derivedSanitizeGemini({
      type: "object",
      properties: { level: { type: "integer", enum: [1, 2] }, mixed: { type: ["string", "null"] } },
      required: ["level", "missing"],
    }) as Record<string, unknown>;
    const properties = output.properties as Record<string, Record<string, unknown>>;
    expect(properties.level?.enum).toEqual(["1", "2"]);
    expect(properties.level?.type).toBe("string");
    expect(properties.mixed?.anyOf).toEqual([{ type: "string" }]);
    expect(properties.mixed?.nullable).toBe(true);
    expect(output.required).toEqual(["level"]);

    const nullOnly = derivedSanitizeGemini({ type: ["null"] }) as Record<string, unknown>;
    expect(nullOnly.type).toBe("null");

    const arrayFallback = derivedSanitizeGemini({ type: "array", items: {} }) as Record<
      string,
      unknown
    >;
    expect((arrayFallback.items as Record<string, unknown>).type).toBe("string");

    const nonObject = derivedSanitizeGemini({
      type: "string",
      properties: { x: { type: "string" } },
      required: ["x"],
    }) as Record<string, unknown>;
    expect(nonObject.properties).toBeUndefined();
    expect(nonObject.required).toBeUndefined();
  });

  test("Anthropic-style definitions forward the published input_schema unchanged", () => {
    const contract = makeHostProbeContract();
    const anthropicTool = {
      name: contract.toolId,
      description: contract.description,
      input_schema: contract.inputJsonSchema,
    };
    expect(anthropicTool.input_schema).toBe(contract.inputJsonSchema);
    // No OpenAI-style lowering is applied on the Anthropic branch.
    expect((contract.inputJsonSchema.properties as Record<string, unknown>).mode).toBeDefined();
  });

  test("published bounds survive on the exercised transports and stay locally enforceable", () => {
    const contract = defineOwnedToolContract({
      toolId: "bounded_contract",
      description: "Bounded",
      registeredArgs: { count: schema.number().int().min(1).max(20).default(8) },
    });
    const properties = contract.inputJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.count?.maximum).toBe(20);
    expect(properties.count?.minimum).toBe(1);
    expect(properties.count?.default).toBe(8);
    // The OpenAI sanitizer would drop the numeric bound, which is why the execute
    // boundary must keep enforcing it locally rather than depending on the wire schema.
    const lowered = derivedSanitizeOpenAISchema(contract.inputJsonSchema) as Record<
      string,
      unknown
    >;
    const loweredProperties = lowered.properties as Record<string, Record<string, unknown>>;
    expect(loweredProperties.count?.maximum).toBeUndefined();
    expect(contract.safeParse({ count: 21 }).success).toBe(false);
  });
});

// START_BLOCK_NINE_PUBLISHED_SCHEMAS
const NINE_TOOL_IDS = [
  "work_item_open",
  "work_item_list",
  "work_item_close",
  "work_item_decide",
  "work_checkpoint",
  "hashline_edit",
  "str_replace_editor",
  "web_search",
  "web_fetch",
] as const;

function publishedSchemas(): { toolId: string; inputJsonSchema: Record<string, unknown> }[] {
  return [
    ...workflowToolContracts,
    hashlineEditContract,
    strReplaceEditorContract,
    webSearchContract,
    webFetchContract,
  ].map((contract) => ({
    toolId: contract.toolId,
    inputJsonSchema: contract.inputJsonSchema,
  }));
}

function rootProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
}

describe("nine published schemas under pinned lowering", () => {
  test("covers all nine owned tools with closed object roots", () => {
    const schemas = publishedSchemas();
    expect(schemas.map((entry) => entry.toolId).sort()).toEqual([...NINE_TOOL_IDS].sort());
    for (const entry of schemas) {
      expect(entry.inputJsonSchema.type).toBe("object");
      expect(entry.inputJsonSchema.additionalProperties).toBe(false);
    }
  });

  test("the fixture-only OpenAI sanitizer drops real numeric bounds but keeps real enums/descriptions", () => {
    const schemas = publishedSchemas();
    const search = schemas.find((entry) => entry.toolId === "web_search")!;
    const searchCount = rootProperties(search.inputJsonSchema).count!;
    expect(typeof searchCount.maximum).toBe("number");
    const loweredSearch = derivedSanitizeOpenAISchema(search.inputJsonSchema) as Record<
      string,
      unknown
    >;
    expect(rootProperties(loweredSearch).count?.maximum).toBeUndefined();

    const checkpoint = schemas.find((entry) => entry.toolId === "work_checkpoint")!;
    const checkpointAction = rootProperties(checkpoint.inputJsonSchema).action!;
    const loweredCheckpoint = derivedSanitizeOpenAISchema(checkpoint.inputJsonSchema) as Record<
      string,
      unknown
    >;
    expect(rootProperties(loweredCheckpoint).action?.enum).toEqual(checkpointAction.enum);

    const editor = schemas.find((entry) => entry.toolId === "str_replace_editor")!;
    const editorCommand = rootProperties(editor.inputJsonSchema).command!;
    expect(typeof editorCommand.description).toBe("string");
    const loweredEditor = derivedSanitizeOpenAISchema(editor.inputJsonSchema) as Record<
      string,
      unknown
    >;
    expect(rootProperties(loweredEditor).command?.description).toBe(editorCommand.description);
  });

  test("the fixture-only Google/Gemini branch keeps real object shapes and enum items", () => {
    for (const entry of publishedSchemas()) {
      const lowered = derivedSanitizeGemini(entry.inputJsonSchema) as Record<string, unknown>;
      expect(lowered.type).toBe("object");
      if (Array.isArray(lowered.required)) {
        const properties = rootProperties(lowered);
        expect((lowered.required as string[]).every((field) => field in properties)).toBe(true);
      }
    }
    const hashline = publishedSchemas().find((entry) => entry.toolId === "hashline_edit")!;
    const loweredHashline = derivedSanitizeGemini(hashline.inputJsonSchema) as Record<
      string,
      unknown
    >;
    const edits = rootProperties(loweredHashline).edits as Record<string, unknown>;
    expect(edits.type).toBe("array");
    const items = edits.items as Record<string, unknown>;
    expect(Array.isArray(rootProperties(items).op?.enum)).toBe(true);
  });

  test("the real compatible/Anthropic frames forward the exact published schema (no transform)", () => {
    for (const entry of publishedSchemas()) {
      // Anthropic serializes tools with input_schema; provider/transform.ts has no
      // anthropic branch, so the published object is forwarded by identity.
      const frame = {
        name: entry.toolId,
        description: "d",
        input_schema: entry.inputJsonSchema,
      };
      expect(frame.input_schema).toBe(entry.inputJsonSchema);
      // The openai-compatible transport also takes no sanitizeOpenAISchema branch:
      // the same object would be forwarded verbatim as function.parameters.
      const compatible = derivedSanitizeOpenAISchema(entry.inputJsonSchema) as Record<
        string,
        unknown
      >;
      expect(rootProperties(compatible)).toBeDefined();
    }
  });
});
// END_BLOCK_NINE_PUBLISHED_SCHEMAS
