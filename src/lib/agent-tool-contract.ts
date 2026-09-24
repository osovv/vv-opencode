// FILE: src/lib/agent-tool-contract.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide reusable cross-plugin agent-tool contract primitives: registered raw argument maps, strict full-object runtime schemas with output inference, bounded diagnostics, fail-closed definition/pre-execute/direct-execute guards, SDK-compatible result-envelope helpers, and loaded contract identity.
//   SCOPE: Generic owned-tool contract descriptors and host-boundary adapters only. No catalog aggregation, no workflow/plugin runtime imports, no permission or state-eligibility decisions. Uses the pinned SDK tool.schema Zod instance; zod imports are type-only. Result-envelope validation is producer/test-only and never wraps post-side-effect execution.
//   DEPENDS: [@opencode-ai/plugin, zod (types), src/lib/package.ts]
//   LINKS: [M-AGENT-TOOL-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AGENT_TOOL_CONTRACT_REVISION - Public tool-contract revision string for loaded identity.
//   PACKAGE_NAME - Re-exported canonical package name from package.ts.
//   PACKAGE_VERSION - Re-exported cached package version from package.ts.
//   resolveToolContractReferencePath - Package-relative path to the tool-contracts reference document.
//   MAX_CONTRACT_ISSUES - Maximum structural issues retained per diagnostic.
//   MAX_ISSUE_PATH_CHARS - Maximum rendered issue path length.
//   MAX_ISSUE_MESSAGE_CHARS - Maximum rendered issue message length.
//   MAX_ISSUE_VALUE_CHARS - Maximum safe scalar preview length.
//   ContractIssueCode - Stable machine-readable structural issue codes.
//   ContractIssue - Bounded, tokenized structural issue with safe value/type summary.
//   escapePathSegment - Escape one issue path segment for safe tokenized rendering.
//   formatIssuePath - Render a Zod path tuple as a bounded, control-safe token path.
//   summarizeReceivedValue - Safe bounded scalar/container value summary.
//   toContractIssues - Convert a ZodError into bounded tokenized contract issues (preserves union branch paths).
//   formatContractIssues - Render issues as a bounded single-line explanation.
//   ContractInputError - Pre-execution structural rejection with code, category, and issues.
//   ContractHostCompatibilityError - Fail-closed host-context rejection for unsupported definition publication.
//   OperationExample - Named accept/reject operation example metadata for a contract.
//   OwnedToolResult - Object branch of the pinned SDK ToolResult (assignable through tool execute).
//   OwnedToolAttachment - Pinned SDK ToolAttachment shape.
//   ownedToolResult - Build an SDK-compatible structured tool result envelope.
//   ownedToolAttachmentSchema - Strict attachment envelope schema for producer/test validation.
//   ownedToolResultSchema - Strict result envelope schema; metadata/document content remain opaque.
//   validateOwnedToolResult - Producer/test-only result envelope validation (no post-side-effect wrapper).
//   strictObject - Build a closed object schema on the SDK tool.schema instance.
//   contractInputJsonSchema - Input-mode JSON Schema projection for a contract schema.
//   OwnedToolArgs - Schema-inferred argument type for an owned-tool registered map.
//   OwnedToolContract - Registered raw map plus strict runtime schema and typed parse helpers.
//   defineOwnedToolContract - Define a closed owned-tool contract from a raw argument map.
//   parseOwnedToolArgs - Direct-execute parse returning schema-inferred output (defaults applied).
//   ToolDefinitionHookOutput - Narrow structural view of the SDK tool.definition hook output.
//   createToolDefinitionAdapter - Owned-only fail-closed tool.definition adapter publishing strict jsonSchema while preserving parameters identity.
//   createPreExecuteGuard - Owned-only tool.execute.before structural guard that never mutates raw args.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS - Correction cycle: fail-closed definition publication, Zod output inference end-to-end, SDK-compatible result envelope + producer validation schema, escaped diagnostic paths, and preserved nested union issue paths.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { ToolAttachment, ToolResult } from "@opencode-ai/plugin";
import type { ZodError, ZodObject, ZodRawShape, ZodType, z } from "zod";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package.js";

export { PACKAGE_NAME, PACKAGE_VERSION };

// START_BLOCK_CONTRACT_IDENTITY
/** Public tool-contract revision; independent of persistence and workflow contract versions. */
export const AGENT_TOOL_CONTRACT_REVISION = "1";

const TOOL_CONTRACT_REFERENCE_PACKAGE_PATH =
  "templates/skills/vv-execute/references/tool-contracts.md";

/**
 * Resolve the package-relative path to the shipped tool-contracts reference document.
 * Uses the loaded module location, not global installs or user config.
 */
export function resolveToolContractReferencePath(): string {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  return join(packageRoot, TOOL_CONTRACT_REFERENCE_PACKAGE_PATH);
}
// END_BLOCK_CONTRACT_IDENTITY

// START_BLOCK_ISSUES
/** Maximum number of structural issues retained in one diagnostic. */
export const MAX_CONTRACT_ISSUES = 8;
/** Maximum rendered path length in characters. */
export const MAX_ISSUE_PATH_CHARS = 120;
/** Maximum rendered message length in characters. */
export const MAX_ISSUE_MESSAGE_CHARS = 200;
/** Maximum safe scalar preview length in characters. */
export const MAX_ISSUE_VALUE_CHARS = 48;

/** Stable machine-readable structural issue codes. */
export type ContractIssueCode =
  | "unrecognized_keys"
  | "invalid_value"
  | "invalid_type"
  | "invalid_format"
  | "too_small"
  | "too_big"
  | "missing_value"
  | "invalid_union"
  | "custom";

/** Bounded structural issue with a tokenized path and safe value/type summary. */
export interface ContractIssue {
  readonly code: ContractIssueCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Escape one path segment so user-controlled keys cannot inject control characters
 * or forge ambiguous dotted/bracketed paths.
 */
export function escapePathSegment(segment: string): string {
  let escaped = "";
  for (const character of segment) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (character === "\\" || character === "." || character === "[" || character === "]") {
      escaped += `\\${character}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

/** Render a Zod path tuple as a bounded dotted/bracketed token path with escaped segments. */
export function formatIssuePath(path: readonly (string | number | symbol)[]): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
    } else {
      const token = escapePathSegment(typeof segment === "symbol" ? segment.toString() : segment);
      rendered = rendered ? `${rendered}.${token}` : token;
    }
    if (rendered.length >= MAX_ISSUE_PATH_CHARS) {
      return truncateChars(rendered, MAX_ISSUE_PATH_CHARS);
    }
  }
  return rendered || "(root)";
}

/**
 * Build a safe, bounded received-value summary.
 * Scalars get a short preview; containers get a type name only — never a payload echo.
 */
export function summarizeReceivedValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return truncateChars(JSON.stringify(value), MAX_ISSUE_VALUE_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return truncateChars(String(value), MAX_ISSUE_VALUE_CHARS);
  }
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return truncateChars(String(value), MAX_ISSUE_VALUE_CHARS);
}

type RawZodIssue = {
  code?: string;
  path?: readonly (string | number | symbol)[];
  message?: string;
  keys?: readonly string[];
  values?: readonly unknown[];
  expected?: unknown;
  received?: unknown;
  errors?: readonly (readonly RawZodIssue[])[];
};

function issueCodeOf(code: string | undefined): ContractIssueCode {
  switch (code) {
    case "unrecognized_keys":
    case "invalid_value":
    case "invalid_type":
    case "invalid_format":
    case "too_small":
    case "too_big":
    case "missing_value":
    case "invalid_union":
    case "custom":
      return code;
    default:
      return "custom";
  }
}

function pushConcreteIssue(
  issues: ContractIssue[],
  raw: RawZodIssue,
  basePath: readonly (string | number | symbol)[],
): void {
  if (issues.length >= MAX_CONTRACT_ISSUES) return;
  const code = issueCodeOf(raw.code);
  if (raw.code === "unrecognized_keys" && Array.isArray(raw.keys)) {
    for (const key of raw.keys) {
      if (issues.length >= MAX_CONTRACT_ISSUES) break;
      issues.push({
        code: "unrecognized_keys",
        path: formatIssuePath([...basePath, String(key)]),
        message: truncateChars(
          `unrecognized key ${JSON.stringify(truncateChars(String(key), MAX_ISSUE_VALUE_CHARS))}`,
          MAX_ISSUE_MESSAGE_CHARS,
        ),
        expected: "a known property of this request object",
      });
    }
    return;
  }
  const expected =
    Array.isArray(raw.values) && raw.values.length > 0
      ? truncateChars(
          raw.values.map((value) => summarizeReceivedValue(value)).join(" | "),
          MAX_ISSUE_MESSAGE_CHARS,
        )
      : raw.code === "invalid_type" && raw.expected !== undefined
        ? truncateChars(String(raw.expected), MAX_ISSUE_MESSAGE_CHARS)
        : undefined;
  const received =
    raw.code === "invalid_type" && raw.received !== undefined
      ? truncateChars(String(raw.received), MAX_ISSUE_VALUE_CHARS)
      : undefined;
  issues.push({
    code,
    path: formatIssuePath(basePath),
    message: truncateChars(raw.message ?? "invalid value", MAX_ISSUE_MESSAGE_CHARS),
    ...(expected !== undefined ? { expected } : {}),
    ...(received !== undefined ? { received } : {}),
  });
}

function pushIssueTree(
  issues: ContractIssue[],
  rawList: readonly RawZodIssue[],
  prefix: readonly (string | number | symbol)[],
): void {
  for (const raw of rawList) {
    if (issues.length >= MAX_CONTRACT_ISSUES) return;
    const basePath = [...prefix, ...(raw.path ?? [])];
    if (raw.code === "invalid_union" && Array.isArray(raw.errors) && raw.errors.length > 0) {
      // Preserve nested union/discriminator branch paths (e.g. source.reference, source.kind).
      for (const branch of raw.errors) {
        pushIssueTree(issues, branch, basePath);
        if (issues.length >= MAX_CONTRACT_ISSUES) return;
      }
      continue;
    }
    pushConcreteIssue(issues, raw, basePath);
  }
}

/**
 * Convert a ZodError into bounded tokenized contract issues.
 * Unknown keys become precise leaf paths; union branch paths are preserved;
 * values are summarized, not echoed wholesale.
 */
export function toContractIssues(error: ZodError): ContractIssue[] {
  const issues: ContractIssue[] = [];
  pushIssueTree(issues, error.issues as readonly RawZodIssue[], []);
  return issues;
}

/** Render issues as one bounded single-line explanation suitable for host tool errors. */
export function formatContractIssues(issues: readonly ContractIssue[]): string {
  if (issues.length === 0) return "INVALID_INPUT: structural validation failed";
  const parts = issues.map((issue) => {
    const path = issue.path || "(root)";
    const expected = issue.expected ? `; expected ${issue.expected}` : "";
    const received = issue.received ? `; received ${issue.received}` : "";
    return truncateChars(
      `${path}: ${issue.message}${expected}${received}`,
      MAX_ISSUE_MESSAGE_CHARS,
    );
  });
  return truncateChars(
    `INVALID_INPUT: ${parts.join(" | ")}`,
    MAX_ISSUE_MESSAGE_CHARS * (MAX_CONTRACT_ISSUES + 1),
  );
}

/** Pre-execution structural rejection for owned tools. Not a permission or state decision. */
export class ContractInputError extends Error {
  readonly code = "INVALID_INPUT";
  readonly category = "input";
  readonly toolId: string;
  readonly issues: readonly ContractIssue[];

  constructor(toolId: string, issues: readonly ContractIssue[]) {
    super(formatContractIssues(issues));
    this.name = "ContractInputError";
    this.toolId = toolId;
    this.issues = issues;
  }
}

/**
 * Fail-closed host-context rejection when an owned tool cannot publish its contract
 * through the host tool.definition seam. Never mutates the hook output before throwing.
 */
export class ContractHostCompatibilityError extends Error {
  readonly code = "HOST_CONTRACT_UNSUPPORTED";
  readonly category = "host_context";
  readonly toolId: string;
  readonly reason: string;

  constructor(toolId: string, reason: string) {
    super(
      truncateChars(
        `HOST_CONTRACT_UNSUPPORTED: tool=${escapePathSegment(toolId)}; ${reason}`,
        MAX_ISSUE_MESSAGE_CHARS,
      ),
    );
    this.name = "ContractHostCompatibilityError";
    this.toolId = toolId;
    this.reason = truncateChars(reason, MAX_ISSUE_MESSAGE_CHARS);
  }
}
// END_BLOCK_ISSUES

// START_BLOCK_DESCRIPTORS
/** Named accept/reject example for a supported operation branch. */
export interface OperationExample {
  readonly operation: string;
  readonly label: string;
  readonly expect: "accept" | "reject";
  readonly input: Record<string, unknown>;
  readonly notes?: string;
}

/** Attachment envelope matching the pinned SDK ToolAttachment (assignable to ToolResult). */
export type OwnedToolAttachment = ToolAttachment;

/**
 * Object branch of the pinned SDK ToolResult.
 * Assignable directly through tool({ execute }) return positions.
 */
export type OwnedToolResult = Extract<ToolResult, { output: string }>;

/**
 * Build a structured tool result envelope compatible with the pinned SDK ToolResult.
 * Empty output and empty metadata remain valid for consumers that need them.
 */
export function ownedToolResult(
  output: string,
  init?: {
    title?: string;
    metadata?: Record<string, unknown>;
    attachments?: OwnedToolAttachment[];
  },
): OwnedToolResult {
  return {
    ...(init?.title !== undefined ? { title: init.title } : {}),
    output,
    ...(init?.metadata !== undefined ? { metadata: init.metadata } : {}),
    ...(init?.attachments !== undefined ? { attachments: init.attachments } : {}),
  };
}

/** Closed object schema on the SDK tool.schema instance (rejects unknown keys). */
export function strictObject<TShape extends ZodRawShape>(shape: TShape): ZodObject<TShape> {
  return tool.schema.strictObject(shape);
}

/** Attachment envelope schema for producer/test validation of owned tool results. */
export const ownedToolAttachmentSchema = strictObject({
  type: tool.schema.literal("file"),
  mime: tool.schema.string(),
  url: tool.schema.string(),
  filename: tool.schema.string().optional(),
});

/**
 * Strict result-envelope schema for producer/test checks.
 * `metadata` and nested document/binary content are declared opaque extension regions
 * (record/unknown or declared opaque fields), not re-validated payload shapes.
 * This is never applied as a throw-after-side-effect execute wrapper.
 */
export const ownedToolResultSchema = strictObject({
  title: tool.schema.string().optional(),
  output: tool.schema.string(),
  metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
  attachments: tool.schema.array(ownedToolAttachmentSchema).optional(),
});

/**
 * Producer/test-only validation of a structured result envelope.
 * Returns typed output on success; structural issues on failure.
 * Do not call this after irreversible side effects as a gate that invites replay.
 */
export function validateOwnedToolResult(
  value: unknown,
): { success: true; data: OwnedToolResult } | { success: false; issues: readonly ContractIssue[] } {
  const result = ownedToolResultSchema.safeParse(value);
  if (result.success) {
    return { success: true, data: result.data as OwnedToolResult };
  }
  return { success: false, issues: toContractIssues(result.error) };
}

/**
 * Project a contract schema to its input-mode JSON Schema.
 * Consistent with the host registry projection (io: "input", $defs → definitions).
 */
export function contractInputJsonSchema(schema: ZodType): Record<string, unknown> {
  const projected = tool.schema.toJSONSchema(schema, { io: "input" }) as unknown;
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    throw new Error("contract schema produced a non-object JSON Schema");
  }
  const record = projected as Record<string, unknown>;
  const { $defs, ...rest } = record;
  if (typeof $defs === "object" && $defs !== null && !Array.isArray($defs)) {
    return { ...rest, definitions: $defs };
  }
  return rest;
}

/** Schema-inferred output type for a contract raw argument map (defaults applied). */
export type OwnedToolArgs<TShape extends ZodRawShape> = z.infer<ZodObject<TShape>>;

/** Owned-tool contract: registered raw map + strict full-object runtime schema + metadata. */
export interface OwnedToolContract<TShape extends ZodRawShape> {
  readonly toolId: string;
  readonly description: string;
  readonly registeredArgs: TShape;
  readonly runtimeSchema: ZodObject<TShape>;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly examples: readonly OperationExample[];
  safeParse(
    raw: unknown,
  ):
    | { success: true; data: OwnedToolArgs<TShape> }
    | { success: false; issues: readonly ContractIssue[] };
  parse(raw: unknown): OwnedToolArgs<TShape>;
}

/**
 * Define an owned-tool contract from the same raw argument map used for SDK registration.
 * The runtime schema is a strict full-object validator over that map; nested closedness
 * comes from composing nested shapes with strictObject. Unknown keys are never coerced or filtered.
 */
export function defineOwnedToolContract<const TShape extends ZodRawShape>(init: {
  toolId: string;
  description: string;
  registeredArgs: TShape;
  examples?: readonly OperationExample[];
}): OwnedToolContract<TShape> {
  const runtimeSchema = strictObject(init.registeredArgs);
  const inputJsonSchema = contractInputJsonSchema(runtimeSchema);
  const examples = init.examples ?? [];
  return {
    toolId: init.toolId,
    description: init.description,
    registeredArgs: init.registeredArgs,
    runtimeSchema,
    inputJsonSchema,
    examples,
    safeParse(raw: unknown) {
      const result = runtimeSchema.safeParse(raw);
      if (result.success) {
        return { success: true, data: result.data as OwnedToolArgs<TShape> };
      }
      return { success: false, issues: toContractIssues(result.error) };
    },
    parse(raw: unknown) {
      const result = runtimeSchema.safeParse(raw);
      if (result.success) return result.data as OwnedToolArgs<TShape>;
      throw new ContractInputError(init.toolId, toContractIssues(result.error));
    },
  };
}

/**
 * Direct-execute validation: parse raw (host-forwarded) args through the contract schema,
 * applying schema defaults/canonicalization for execute to consume.
 * Returns the schema-inferred output type (defaults and enum literals preserved).
 */
export function parseOwnedToolArgs<TShape extends ZodRawShape>(
  contract: OwnedToolContract<TShape>,
  rawArgs: unknown,
): OwnedToolArgs<TShape> {
  return contract.parse(rawArgs);
}
// END_BLOCK_DESCRIPTORS

// START_BLOCK_HOST_ADAPTERS
/** Narrow structural view of the SDK tool.definition hook output. */
export type ToolDefinitionHookOutput = {
  description: string;
  parameters: unknown;
  jsonSchema?: unknown;
};

function isDefinitionHookOutput(value: unknown): value is ToolDefinitionHookOutput {
  return (
    typeof value === "object" && value !== null && "parameters" in value && "description" in value
  );
}

function hasJsonSchemaMember(value: object): boolean {
  return "jsonSchema" in value;
}

/**
 * Owned-only tool.definition adapter (fail-closed).
 * Publishes the strict input-mode jsonSchema through the host's observable jsonSchema member
 * while preserving parameters identity (the host decoder is never replaced).
 * For owned tool IDs, an unsupported host shape (malformed output or missing jsonSchema member)
 * throws ContractHostCompatibilityError without mutating the output.
 * Unowned tool IDs are left untouched.
 */
export function createToolDefinitionAdapter(
  contracts: readonly OwnedToolContract<ZodRawShape>[],
): (input: { toolID: string }, output: ToolDefinitionHookOutput) => Promise<void> {
  const byId = new Map(contracts.map((contract) => [contract.toolId, contract]));
  return async function toolDefinitionAdapter(input, output) {
    const contract = byId.get(input.toolID);
    if (!contract) return;
    if (!isDefinitionHookOutput(output)) {
      throw new ContractHostCompatibilityError(
        contract.toolId,
        "malformed tool.definition output: missing required description/parameters members",
      );
    }
    if (!hasJsonSchemaMember(output)) {
      throw new ContractHostCompatibilityError(
        contract.toolId,
        "unsupported host tool.definition shape: missing jsonSchema member required for strict publication",
      );
    }
    output.jsonSchema = contract.inputJsonSchema;
  };
}

/**
 * Owned-only pre-execute structural guard for tool.execute.before.
 * Inspects raw args and throws ContractInputError on structural failure.
 * Never mutates output.args and never confers state/permission eligibility.
 */
export function createPreExecuteGuard(
  contracts: readonly OwnedToolContract<ZodRawShape>[],
): (input: { tool: string }, output: { args: unknown }) => Promise<void> {
  const byId = new Map(contracts.map((contract) => [contract.toolId, contract]));
  return async function preExecuteGuard(input, output) {
    const contract = byId.get(input.tool);
    if (!contract) return;
    const result = contract.runtimeSchema.safeParse(output.args);
    if (!result.success) {
      throw new ContractInputError(contract.toolId, toContractIssues(result.error));
    }
  };
}
// END_BLOCK_HOST_ADAPTERS
