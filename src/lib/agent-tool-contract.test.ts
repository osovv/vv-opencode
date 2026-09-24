// FILE: src/lib/agent-tool-contract.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify shared agent-tool contract primitives: strict unknown-key rejection, bounded/escaped diagnostics, non-coercion, typed output inference, identity, fail-closed definition/pre-execute adapters, and SDK-compatible result envelopes.
//   SCOPE: Pure unit tests over src/lib/agent-tool-contract.ts with synthetic descriptors only.
//   DEPENDS: [bun:test, src/lib/agent-tool-contract]
//   LINKS: [M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   schema - The pinned host tool.schema helper shared by the contract fixtures.
//   makeProbeContract - Builds a representative closed probe contract used across cases.
//   typedDefaultsContract - Contract with required defaults and literal enums for inference tests.
//   resultEnvelopeFixture - tool() registration whose execute returns ownedToolResult with attachments.
//   bareToolContext - Minimal pinned SDK ToolContext fixture for direct-execute cases.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS - Correction cycle: fail-closed definition rejection evidence, typed inference without casts, SDK ToolResult assignment fixture, escaped paths, and union path counterexamples.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  ContractHostCompatibilityError,
  ContractInputError,
  MAX_CONTRACT_ISSUES,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  createPreExecuteGuard,
  createToolDefinitionAdapter,
  defineOwnedToolContract,
  escapePathSegment,
  formatContractIssues,
  formatIssuePath,
  ownedToolResult,
  ownedToolResultSchema,
  parseOwnedToolArgs,
  resolveToolContractReferencePath,
  strictObject,
  summarizeReceivedValue,
  toContractIssues,
  validateOwnedToolResult,
} from "./agent-tool-contract.js";

const schema = tool.schema;

function makeProbeContract() {
  return defineOwnedToolContract({
    toolId: "probe_contract",
    description: "Probe contract for unit tests.",
    registeredArgs: {
      label: schema.string().describe("Echo label"),
      mode: schema.enum(["quiet", "loud"]).optional().describe("Echo mode"),
      nested: strictObject({
        depth: schema.number().int().min(0).optional().describe("Nested depth"),
      })
        .optional()
        .describe("Nested options"),
    },
    examples: [
      {
        operation: "echo",
        label: "accept without default",
        expect: "accept",
        input: { label: "alpha" },
      },
    ],
  });
}

function typedDefaultsContract() {
  return defineOwnedToolContract({
    toolId: "typed_defaults",
    description: "Typed defaults contract",
    registeredArgs: {
      label: schema.string(),
      mode: schema.enum(["quiet", "loud"]).default("quiet"),
      count: schema.number().int().min(1).default(8),
    },
  });
}

/** Compile-time fixture: execute return must be assignable to the pinned SDK ToolResult. */
const resultEnvelopeFixture = tool({
  description: "Result envelope assignment fixture",
  args: { label: schema.string() },
  execute: async (_args, _context: ToolContext) => {
    return ownedToolResult("fixture-output", {
      title: "fixture",
      metadata: { opaqueRegion: { anything: true } },
      attachments: [{ type: "file", mime: "text/plain", url: "file:///tmp/a.txt" }],
    });
  },
});

function bareToolContext(): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe("agent-tool-contract identity", () => {
  test("exposes revision and cached package identity", () => {
    expect(AGENT_TOOL_CONTRACT_REVISION).toBe("1");
    expect(PACKAGE_NAME).toBe("@osovv/vv-opencode");
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("resolves a package-relative reference path under templates", () => {
    const path = resolveToolContractReferencePath();
    expect(path).toContain("templates/skills/vv-execute/references/tool-contracts.md");
    expect(path.endsWith("tool-contracts.md")).toBe(true);
  });
});

describe("typed reuse (schema-inferred output, no casts)", () => {
  test("parseOwnedToolArgs preserves required defaults and literal enum types", () => {
    const contract = typedDefaultsContract();
    const parsed = parseOwnedToolArgs(contract, { label: "x" });
    // Compile-time consumers (no assertion casts):
    const mode: "quiet" | "loud" = parsed.mode;
    const count: number = parsed.count;
    const label: string = parsed.label;
    expect(mode).toBe("quiet");
    expect(count).toBe(8);
    expect(label).toBe("x");
  });

  test("safeParse success branch is schema-inferred without casts", () => {
    const contract = typedDefaultsContract();
    const result = contract.safeParse({ label: "y", mode: "loud" });
    if (!result.success) throw new Error("expected success");
    const mode: "quiet" | "loud" = result.data.mode;
    const count: number = result.data.count;
    expect(mode).toBe("loud");
    expect(count).toBe(8);
  });

  test("optional fields remain optional on the inferred output type", () => {
    const contract = makeProbeContract();
    const parsed = parseOwnedToolArgs(contract, { label: "alpha" });
    const maybeMode: "quiet" | "loud" | undefined = parsed.mode;
    const maybeNested: { depth?: number } | undefined = parsed.nested;
    expect(maybeMode).toBeUndefined();
    expect(maybeNested).toBeUndefined();
    expect(parsed.label).toBe("alpha");
  });

  test("tool() execute accepts ownedToolResult with attachments without casts", async () => {
    const result = await resultEnvelopeFixture.execute({ label: "x" }, bareToolContext());
    expect(typeof result).toBe("object");
    if (typeof result === "string") throw new Error("expected structured result");
    expect(result.output).toBe("fixture-output");
    expect(result.attachments?.[0]).toMatchObject({ type: "file", mime: "text/plain" });
  });
});

describe("strict structural validation", () => {
  test("rejects unknown top-level field with an actionable bounded path", () => {
    const contract = makeProbeContract();
    const result = contract.safeParse({ label: "alpha", unexpected: "nope" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(result.issues.some((issue) => issue.path === "unexpected")).toBe(true);
    const message = formatContractIssues(result.issues);
    expect(message).toContain("INVALID_INPUT");
    expect(message).toContain("unexpected");
  });

  test("rejects nested unknown key without filtering it into a valid request", () => {
    const contract = makeProbeContract();
    const result = contract.safeParse({ label: "alpha", nested: { tpyo: 1 } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.issues.some((issue) => issue.path === "nested.tpyo")).toBe(true);
  });

  test("rejects malformed nested known value with nested path", () => {
    const contract = makeProbeContract();
    const result = contract.safeParse({ label: "alpha", nested: { depth: "deep" } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.issues.some((issue) => issue.path === "nested.depth")).toBe(true);
    expect(result.issues[0]?.received === "string" || result.issues[0]?.message).toBeTruthy();
  });

  test("does not coerce invalid types or filter invalid enum values", () => {
    const contract = makeProbeContract();
    const wrongType = contract.safeParse({ label: 42 });
    expect(wrongType.success).toBe(false);
    const badEnum = contract.safeParse({ label: "alpha", mode: "silent" });
    expect(badEnum.success).toBe(false);
    if (badEnum.success) throw new Error("expected failure");
    expect(badEnum.issues.some((issue) => issue.path === "mode")).toBe(true);
  });

  test("preserves empty object and empty array contents", () => {
    const contract = defineOwnedToolContract({
      toolId: "empty_probe",
      description: "Empty contents probe",
      registeredArgs: {
        items: schema.array(schema.string()),
        meta: strictObject({ note: schema.string().optional() }),
      },
    });
    const parsed = parseOwnedToolArgs(contract, { items: [], meta: {} });
    expect(parsed.items).toEqual([]);
    expect(parsed.meta).toEqual({});
  });

  test("throws ContractInputError with code and category on direct parse failure", () => {
    const contract = makeProbeContract();
    try {
      contract.parse({ label: "alpha", unexpected: true });
      throw new Error("expected ContractInputError");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractInputError);
      const typed = error as ContractInputError;
      expect(typed.code).toBe("INVALID_INPUT");
      expect(typed.category).toBe("input");
      expect(typed.toolId).toBe("probe_contract");
      expect(typed.issues.length).toBeGreaterThan(0);
      expect(typed.message).toContain("INVALID_INPUT");
    }
  });
});

describe("bounded diagnostics", () => {
  test("tokenizes array indices into paths", () => {
    expect(formatIssuePath(["tasks", 0, "mode"])).toBe("tasks[0].mode");
    expect(formatIssuePath([])).toBe("(root)");
  });

  test("escapes control characters and ambiguous dots in user-controlled keys", () => {
    expect(escapePathSegment("a\nb")).toBe("a\\u000ab");
    expect(formatIssuePath(["meta", "a.b"])).toBe("meta.a\\.b");
    expect(formatIssuePath(["x", "evil\u0000key"])).toBe("x.evil\\u0000key");
    expect(formatIssuePath(["path", "a[0]"])).toBe("path.a\\[0\\]");
    // Counterexample: without escaping, "a.b" would forge a nested path.
    expect(formatIssuePath(["root", "a.b"])).not.toBe("root.a.b");
  });

  test("preserves nested union branch paths for future source discriminators", () => {
    const contract = defineOwnedToolContract({
      toolId: "union_probe",
      description: "Union path probe",
      registeredArgs: {
        source: schema.union([
          strictObject({ kind: schema.literal("conversation") }),
          strictObject({
            kind: schema.literal("provided-plan"),
            reference: schema.string(),
          }),
        ]),
      },
    });
    const missingRef = contract.safeParse({ source: { kind: "provided-plan" } });
    expect(missingRef.success).toBe(false);
    if (missingRef.success) throw new Error("expected failure");
    expect(missingRef.issues.some((issue) => issue.path === "source.reference")).toBe(true);

    const badKind = contract.safeParse({ source: { kind: "nope" } });
    expect(badKind.success).toBe(false);
    if (badKind.success) throw new Error("expected failure");
    expect(badKind.issues.some((issue) => issue.path.includes("kind"))).toBe(true);
  });

  test("expands non-discriminated union branch issues with parent path prefix", () => {
    const contract = defineOwnedToolContract({
      toolId: "union_expand",
      description: "Union expand probe",
      registeredArgs: {
        source: schema.union([
          strictObject({ kind: schema.literal("a"), x: schema.string() }),
          strictObject({ kind: schema.literal("b"), y: schema.number() }),
        ]),
      },
    });
    const result = contract.safeParse({ source: { kind: "a", x: 1 } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.issues.some((issue) => issue.path === "source.x")).toBe(true);
  });

  test("summarizes scalars safely and containers by type only", () => {
    expect(summarizeReceivedValue("abc")).toBe('"abc"');
    expect(summarizeReceivedValue({ secret: "value" })).toBe("object");
    expect(summarizeReceivedValue([1, 2, 3])).toBe("array");
    expect(summarizeReceivedValue("x".repeat(500)).length).toBeLessThanOrEqual(49);
  });

  test("caps issue count and never echoes large payloads", () => {
    const shape: Record<string, ReturnType<typeof schema.string>> = {};
    for (let index = 0; index < 20; index += 1) {
      shape[`field_${index}`] = schema.string();
    }
    const contract = defineOwnedToolContract({
      toolId: "many_fields",
      description: "Many fields",
      registeredArgs: shape,
    });
    const payload: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) {
      payload[`field_${index}`] = { nested: "x".repeat(1000) };
    }
    const result = contract.safeParse(payload);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.issues.length).toBeLessThanOrEqual(MAX_CONTRACT_ISSUES);
    const message = formatContractIssues(result.issues);
    expect(message).not.toContain("x".repeat(200));
  });

  test("toContractIssues maps unrecognized keys to leaf paths", () => {
    const issues = toContractIssues({
      issues: [
        {
          code: "unrecognized_keys",
          path: ["nested"],
          keys: ["tpyo"],
          message: "Unrecognized key",
        },
      ],
    } as never);
    expect(issues[0]?.path).toBe("nested.tpyo");
  });
});

describe("definition adapter (fail-closed)", () => {
  test("publishes strict input jsonSchema and preserves parameters identity for owned tools", async () => {
    const contract = makeProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const parameters = { decoder: "host-parameters" };
    const output = {
      description: contract.description,
      parameters,
      jsonSchema: { type: "object", properties: {} },
    };
    await adapter({ toolID: contract.toolId }, output);
    expect(output.parameters).toBe(parameters);
    expect(output.jsonSchema).not.toEqual({ type: "object", properties: {} });
    const published = output.jsonSchema as Record<string, unknown>;
    expect(published.additionalProperties).toBe(false);
    expect(published).toMatchObject({
      type: "object",
      properties: {
        label: { type: "string", description: "Echo label" },
        mode: { type: "string", enum: ["quiet", "loud"] },
        nested: {
          type: "object",
          additionalProperties: false,
          properties: { depth: { type: "integer" } },
        },
      },
      required: ["label"],
    });
  });

  test("ignores unowned tool ids without mutation", async () => {
    const contract = makeProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const original = { type: "string" };
    const output = { description: "d", parameters: { p: 1 }, jsonSchema: original };
    await adapter({ toolID: "not_owned" }, output);
    expect(output.jsonSchema).toBe(original);
  });

  test("rejects unsupported host shape missing jsonSchema member for owned tool", async () => {
    const contract = makeProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const parameters = { decoder: "host-parameters" };
    const output = { description: contract.description, parameters } as {
      description: string;
      parameters: unknown;
      jsonSchema?: unknown;
    };
    let caught: unknown;
    try {
      await adapter({ toolID: contract.toolId }, output);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractHostCompatibilityError);
    const typed = caught as ContractHostCompatibilityError;
    expect(typed.code).toBe("HOST_CONTRACT_UNSUPPORTED");
    expect(typed.category).toBe("host_context");
    expect(typed.toolId).toBe(contract.toolId);
    expect(typed.message).toContain("jsonSchema");
    // Refusal preserves original output and parameters identity.
    expect("jsonSchema" in output).toBe(false);
    expect(output.parameters).toBe(parameters);
  });

  test("rejects malformed structural output for owned tool without mutation", async () => {
    const contract = makeProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const malformed = { description: "d" } as unknown as Parameters<
      ReturnType<typeof createToolDefinitionAdapter>
    >[1];
    let caught: unknown;
    try {
      await adapter({ toolID: contract.toolId }, malformed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractHostCompatibilityError);
    expect(Object.keys(malformed)).toEqual(["description"]);
    expect(malformed).not.toHaveProperty("parameters");
  });

  test("controller repro: missingJsonSchema is rejected, not a silent no-op", async () => {
    const contract = makeProbeContract();
    const adapter = createToolDefinitionAdapter([contract]);
    const output = { description: contract.description, parameters: {} } as {
      description: string;
      parameters: unknown;
      jsonSchema?: unknown;
    };
    let rejected = false;
    try {
      await adapter({ toolID: contract.toolId }, output);
    } catch (error) {
      rejected = error instanceof ContractHostCompatibilityError;
    }
    expect(rejected).toBe(true);
    expect("jsonSchema" in output).toBe(false);
  });
});

describe("pre-execute guard", () => {
  test("rejects invalid raw args without mutating them", async () => {
    const contract = makeProbeContract();
    const guard = createPreExecuteGuard([contract]);
    const args = Object.freeze({ label: "alpha", unexpected: "nope" }) as {
      label: string;
      unexpected: string;
    };
    const snapshot = JSON.stringify(args);
    await expect(guard({ tool: contract.toolId }, { args })).rejects.toBeInstanceOf(
      ContractInputError,
    );
    expect(JSON.stringify(args)).toBe(snapshot);
    expect(args.unexpected).toBe("nope");
  });

  test("accepts valid raw args and leaves the same object reference untouched", async () => {
    const contract = makeProbeContract();
    const guard = createPreExecuteGuard([contract]);
    const args = { label: "alpha" };
    await guard({ tool: contract.toolId }, { args });
    expect(args).toEqual({ label: "alpha" });
  });

  test("does not throw for unowned tools", async () => {
    const contract = makeProbeContract();
    const guard = createPreExecuteGuard([contract]);
    await guard({ tool: "other_tool" }, { args: { anything: true } });
  });

  test("does not treat structural acceptance as defaults application", async () => {
    const contract = typedDefaultsContract();
    const guard = createPreExecuteGuard([contract]);
    const raw = { label: "x" };
    await guard({ tool: contract.toolId }, { args: raw });
    expect(raw).toEqual({ label: "x" });
    const parsed = parseOwnedToolArgs(contract, raw);
    expect(parsed.mode).toBe("quiet");
  });
});

describe("result envelopes", () => {
  test("preserves empty output and empty metadata when provided", () => {
    const empty = ownedToolResult("");
    expect(empty.output).toBe("");
    const withMeta = ownedToolResult("ok", { metadata: {} });
    expect(withMeta.metadata).toEqual({});
    expect(withMeta.output).toBe("ok");
  });

  test("validateOwnedToolResult accepts a valid envelope with opaque metadata", () => {
    const result = validateOwnedToolResult({
      output: "ok",
      metadata: { document: { raw: "opaque-content" } },
      attachments: [{ type: "file", mime: "text/plain", url: "file:///tmp/a" }],
    });
    expect(result.success).toBe(true);
  });

  test("validateOwnedToolResult rejects malformed envelopes with bounded issues", () => {
    const missingOutput = validateOwnedToolResult({ title: "t" });
    expect(missingOutput.success).toBe(false);
    if (missingOutput.success) throw new Error("expected failure");
    expect(missingOutput.issues.some((issue) => issue.path.includes("output"))).toBe(true);

    const badAttachment = validateOwnedToolResult({
      output: "x",
      attachments: [{ type: "image", mime: "text/plain", url: "file:///x" }],
    });
    expect(badAttachment.success).toBe(false);
  });

  test("ownedToolResultSchema rejects unknown top-level keys", () => {
    const result = ownedToolResultSchema.safeParse({ output: "x", unexpected: true });
    expect(result.success).toBe(false);
  });
});
