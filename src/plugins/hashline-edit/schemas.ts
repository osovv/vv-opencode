// FILE: src/plugins/hashline-edit/schemas.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Single source of the two vvoc-owned edit tool contracts: registered raw argument maps, closed nested edit/command structures, strict runtime schemas with args-only branch validation, model-facing descriptions, operation examples, and concrete metadata/result producer schemas.
//   SCOPE: Pure contract declarations and args-only validation for hashline_edit and str_replace_editor: structural parsing (unknown keys, enums, types), operation/command allowed/required field matrices, delete/rename/edits branch rules, anchor-conflict detection, and view_range exact-shape rules. No filesystem, session cache, editor execution, plugin registration, or anchor-versus-current-file validation; the normalizer and editor keep literal-content, three-part-anchor, and current-file authority.
//   DEPENDS: [@opencode-ai/plugin, zod (types), src/lib/agent-tool-contract.ts, src/plugins/hashline-edit/routing.ts, src/plugins/hashline-edit/tool-description.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HASHLINE_EDIT_TOOL_ID - Registered tool id for the hash-anchored editor.
//   STR_REPLACE_EDITOR_TOOL_ID - Registered tool id for the dsh str_replace_editor.
//   HASHLINE_EDIT_OPS - Canonical hash-anchored operation vocabulary.
//   HashlineToolOp - Union of hash-anchored operation identifiers.
//   RawHashlineEdit - Loose tool-facing edit input accepted by the normalizer.
//   STR_REPLACE_EDITOR_COMMANDS - Canonical str_replace_editor command vocabulary.
//   StrReplaceEditorCommand - Union of str_replace_editor command identifiers.
//   HashlineEditToolArgs - Schema-derived hashline_edit argument shape.
//   RawHashlineEditEntry - Schema-derived shape of one raw hash-anchored edit entry.
//   StrReplaceEditorToolArgs - Schema-derived str_replace_editor argument shape.
//   StrReplaceEditorResult - Str editor ok/error result shape (producer/test contract).
//   hashlineEditEntrySchema - Closed single-edit shape shared with the normalizer.
//   hashlineEditArgs - Registered raw argument map for hashline_edit.
//   strReplaceEditorArgs - Registered raw argument map for str_replace_editor.
//   hashlineEditContract - Owned contract for hashline_edit.
//   strReplaceEditorContract - Owned contract for str_replace_editor.
//   editToolContracts - Owned contracts for both edit tools (definition adapter input).
//   HashlineEditValidation - Successful parsed hashline args or bounded issues.
//   StrReplaceEditorValidation - Successful parsed str editor args or bounded issues.
//   validateRawHashlineEditEntry - Closed single-edit shape validation reused by the direct normalizer.
//   validateHashlineEditToolInput - Structural plus branch validation for hashline_edit.
//   validateStrReplaceEditorToolInput - Structural plus command validation for str_replace_editor.
//   hashlineEditFilediffSchema - Concrete filediff metadata envelope schema.
//   hashlineEditMetadataSchema - Concrete hashline success metadata schema (no blanket records).
//   strReplaceEditorMetadataSchema - Concrete str editor success metadata schema.
//   strReplaceEditorResultSchema - Closed ok/error result schema for producer checks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Initial single-source edit-tool contracts plus a correction cycle: non-empty path checks for filePath/rename/path, representable insert_line min(0) and view_range length(2) bounds, and a shared closed single-edit shape validation for the direct normalizer.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { z, ZodRawShape } from "zod";
import {
  MAX_CONTRACT_ISSUES,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_CHARS,
  MAX_ISSUE_VALUE_CHARS,
  defineOwnedToolContract,
  formatIssuePath,
  strictObject,
  toContractIssues,
  type ContractIssue,
  type OperationExample,
  type OwnedToolContract,
} from "../../lib/agent-tool-contract.js";
import { EDIT_MODES } from "./routing.js";
import { HASHLINE_EDIT_DESCRIPTION, STR_REPLACE_EDITOR_DESCRIPTION } from "./tool-description.js";

const schema = tool.schema;

// START_BLOCK_TOOL_IDS
/** Registered tool id for the hash-anchored editor. */
export const HASHLINE_EDIT_TOOL_ID = "hashline_edit";
/** Registered tool id for the dsh str_replace_editor. */
export const STR_REPLACE_EDITOR_TOOL_ID = "str_replace_editor";

/** Canonical hash-anchored operation vocabulary. */
export const HASHLINE_EDIT_OPS = ["replace", "replace_range", "append", "prepend"] as const;
/** Union of hash-anchored operation identifiers. */
export type HashlineToolOp = (typeof HASHLINE_EDIT_OPS)[number];

/**
 * Loose tool-facing edit input accepted by the normalizer. The registered schema
 * below is stricter (required op/lines), but the normalizer must describe and
 * reject malformed raw input deterministically for direct calls and tests.
 */
export interface RawHashlineEdit {
  op?: HashlineToolOp;
  pos?: string;
  end?: string;
  lines?: string | string[] | null;
}

/** Canonical str_replace_editor command vocabulary. */
export const STR_REPLACE_EDITOR_COMMANDS = ["view", "create", "str_replace", "insert"] as const;
/** Union of str_replace_editor command identifiers. */
export type StrReplaceEditorCommand = (typeof STR_REPLACE_EDITOR_COMMANDS)[number];
// END_BLOCK_TOOL_IDS

// START_BLOCK_ARG_MAPS
const hashlineEditEntryShape = {
  op: schema
    .enum(HASHLINE_EDIT_OPS)
    .describe("Operation: replace one line, replace a pos..end range, append, or prepend."),
  pos: schema
    .string()
    .optional()
    .describe(
      "Primary anchor in LINE#HASH#ANCHOR three-part format. Required for replace/replace_range; optional for append/prepend (no anchor inserts at the file boundary).",
    ),
  end: schema
    .string()
    .optional()
    .describe(
      "Optional inclusive range end anchor. With end, replace covers pos..end; required for replace_range. For append/prepend it is only a fallback when pos is omitted.",
    ),
  lines: schema
    .union([schema.array(schema.string()), schema.string(), schema.null()])
    .describe(
      'Replacement or inserted lines as plain text content. null or [] deletes for replace/replace_range; [""] is rejected as ambiguous.',
    ),
};

/** Closed single-edit shape shared by registration, args validation, and the direct normalizer. */
export const hashlineEditEntrySchema = strictObject(hashlineEditEntryShape);
/** Schema-derived shape of one raw hash-anchored edit entry. */
export type RawHashlineEditEntry = z.infer<typeof hashlineEditEntrySchema>;

/** Registered raw argument map for hashline_edit (single source of the tool surface). */
export const hashlineEditArgs = {
  filePath: schema
    .string()
    .describe(
      "Absolute path to the file to edit (non-empty; spaces inside the name are preserved)",
    ),
  delete: schema.boolean().optional().describe("Delete the file instead of editing it"),
  rename: schema
    .string()
    .optional()
    .describe("Rename the file after edits are applied (non-empty when provided)"),
  edits: schema
    .array(hashlineEditEntrySchema)
    .describe("Hash-anchored edit operations to apply to the file"),
};

const hashlineEditArgsObject = strictObject(hashlineEditArgs);

/** hashline_edit argument shape, single-sourced from the registered schema. */
export type HashlineEditToolArgs = z.infer<typeof hashlineEditArgsObject>;

/** Registered raw argument map for str_replace_editor (single source of the tool surface). */
export const strReplaceEditorArgs = {
  command: schema
    .enum(STR_REPLACE_EDITOR_COMMANDS)
    .describe("The command to run: view, create, str_replace, or insert"),
  path: schema.string().describe("Absolute path to file or directory"),
  file_text: schema
    .string()
    .optional()
    .describe("create only: content of the new file; an explicitly empty string is allowed"),
  old_str: schema
    .string()
    .optional()
    .describe("str_replace only: the exact, non-empty text to replace (whitespace is significant)"),
  new_str: schema
    .string()
    .optional()
    .describe(
      "str_replace replacement text (omitted defaults to empty deletion; explicit empty is valid); required for insert",
    ),
  insert_line: schema
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "insert only: integer line index >= 0; new_str is inserted AFTER this line (the file-dependent upper bound is enforced by the editor)",
    ),
  view_range: schema
    .array(schema.number().int())
    .length(2)
    .optional()
    .describe(
      "view only: exact [start, end] line range. The length is fixed at 2; start >= 1 and end is -1 (end of file) or >= start are runtime-checked.",
    ),
};

const strReplaceEditorArgsObject = strictObject(strReplaceEditorArgs);

/** str_replace_editor argument shape, single-sourced from the registered schema. */
export type StrReplaceEditorToolArgs = z.infer<typeof strReplaceEditorArgsObject>;
// END_BLOCK_ARG_MAPS

// START_BLOCK_RESULT_SCHEMAS
/** Concrete filediff metadata envelope published after a successful hashline edit. */
export const hashlineEditFilediffSchema = strictObject({
  file: schema.string(),
  path: schema.string(),
  filePath: schema.string(),
  before: schema.string(),
  after: schema.string(),
});

/** Concrete success metadata envelope for hashline_edit (known fields, no blanket records). */
export const hashlineEditMetadataSchema = strictObject({
  filePath: schema.string(),
  path: schema.string(),
  file: schema.string(),
  noopEdits: schema.number().int(),
  deduplicatedEdits: schema.number().int(),
  firstChangedLine: schema.number().int().optional(),
  editMode: schema.enum(EDIT_MODES),
  providerID: schema.string().optional(),
  modelID: schema.string().optional(),
  filediff: hashlineEditFilediffSchema,
});

/** Concrete success metadata envelope for str_replace_editor. */
export const strReplaceEditorMetadataSchema = strictObject({
  filePath: schema.string(),
  path: schema.string(),
  file: schema.string(),
  editMode: schema.enum(EDIT_MODES),
  providerID: schema.string().optional(),
  modelID: schema.string().optional(),
});

/**
 * Closed ok/error result schema for str_replace_editor producer/test checks.
 * This is never applied as a throw-after-side-effect execute wrapper.
 */
export const strReplaceEditorResultSchema = schema.union([
  strictObject({ ok: schema.literal(true), output: schema.string() }),
  strictObject({ ok: schema.literal(false), error: schema.string() }),
]);

/** Str editor ok/error result shape (producer/test contract). */
export type StrReplaceEditorResult = z.infer<typeof strReplaceEditorResultSchema>;
// END_BLOCK_RESULT_SCHEMAS

// START_BLOCK_OPERATION_EXAMPLES
const hashlineEditExamples: readonly OperationExample[] = [
  {
    operation: "replace",
    label: "single-line replace at pos",
    expect: "accept",
    input: { filePath: "/tmp/a.ts", edits: [{ op: "replace", pos: "2#VK#ZZ", lines: ["x"] }] },
  },
  {
    operation: "replace",
    label: "replace with end is an inclusive range",
    expect: "accept",
    input: {
      filePath: "/tmp/a.ts",
      edits: [{ op: "replace", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
    },
  },
  {
    operation: "replace_range",
    label: "replace_range alias requires both anchors",
    expect: "accept",
    input: {
      filePath: "/tmp/a.ts",
      edits: [{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
    },
  },
  {
    operation: "replace_range",
    label: "deletion via lines null",
    expect: "accept",
    input: {
      filePath: "/tmp/a.ts",
      edits: [{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: null }],
    },
  },
  {
    operation: "append",
    label: "boundary append without an anchor creates a missing file",
    expect: "accept",
    input: { filePath: "/tmp/a.ts", edits: [{ op: "append", lines: ["x"] }] },
  },
  {
    operation: "prepend",
    label: "end-anchor fallback when pos is omitted",
    expect: "accept",
    input: { filePath: "/tmp/a.ts", edits: [{ op: "prepend", end: "3#MB#ZZ", lines: ["x"] }] },
  },
  {
    operation: "delete",
    label: "delete mode with empty edits",
    expect: "accept",
    input: { filePath: "/tmp/a.ts", delete: true, edits: [] },
  },
  {
    operation: "delete",
    label: "delete and rename conflict",
    expect: "reject",
    input: { filePath: "/tmp/a.ts", delete: true, rename: "/tmp/b.ts", edits: [] },
  },
  {
    operation: "delete",
    label: "delete with non-empty edits",
    expect: "reject",
    input: {
      filePath: "/tmp/a.ts",
      delete: true,
      edits: [{ op: "replace", pos: "2#VK#ZZ", lines: ["x"] }],
    },
  },
  {
    operation: "append",
    label: "conflicting insert anchors",
    expect: "reject",
    input: {
      filePath: "/tmp/a.ts",
      edits: [{ op: "append", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
    },
  },
  {
    operation: "replace_range",
    label: "replace_range missing end",
    expect: "reject",
    input: {
      filePath: "/tmp/a.ts",
      edits: [{ op: "replace_range", pos: "2#VK#ZZ", lines: ["x"] }],
    },
  },
  {
    operation: "replace",
    label: "non-empty edits required when not deleting",
    expect: "reject",
    input: { filePath: "/tmp/a.ts", edits: [] },
  },
];

const strReplaceEditorExamples: readonly OperationExample[] = [
  {
    operation: "view",
    label: "view with an end-of-file range",
    expect: "accept",
    input: { command: "view", path: "/tmp/a.ts", view_range: [2, -1] },
  },
  {
    operation: "create",
    label: "create with empty file_text",
    expect: "accept",
    input: { command: "create", path: "/tmp/a.ts", file_text: "" },
  },
  {
    operation: "str_replace",
    label: "str_replace with explicit empty new_str (deletion)",
    expect: "accept",
    input: { command: "str_replace", path: "/tmp/a.ts", old_str: "x", new_str: "" },
  },
  {
    operation: "str_replace",
    label: "str_replace with omitted new_str defaults to deletion",
    expect: "accept",
    input: { command: "str_replace", path: "/tmp/a.ts", old_str: "x" },
  },
  {
    operation: "insert",
    label: "insert requires an integer insert_line and new_str",
    expect: "accept",
    input: { command: "insert", path: "/tmp/a.ts", insert_line: 0, new_str: "" },
  },
  {
    operation: "view",
    label: "unsupported field for the selected command",
    expect: "reject",
    input: { command: "view", path: "/tmp/a.ts", old_str: "x" },
  },
  {
    operation: "str_replace",
    label: "old_str must be non-empty",
    expect: "reject",
    input: { command: "str_replace", path: "/tmp/a.ts", old_str: "", new_str: "x" },
  },
  {
    operation: "insert",
    label: "insert requires insert_line",
    expect: "reject",
    input: { command: "insert", path: "/tmp/a.ts", new_str: "x" },
  },
  {
    operation: "view",
    label: "view_range must be exactly two integers",
    expect: "reject",
    input: { command: "view", path: "/tmp/a.ts", view_range: [1] },
  },
  {
    operation: "view",
    label: "view_range end must be -1 or >= start",
    expect: "reject",
    input: { command: "view", path: "/tmp/a.ts", view_range: [3, 2] },
  },
];
// END_BLOCK_OPERATION_EXAMPLES

// START_BLOCK_CONTRACTS
/** Owned contract for hashline_edit. */
export const hashlineEditContract = defineOwnedToolContract({
  toolId: HASHLINE_EDIT_TOOL_ID,
  description: HASHLINE_EDIT_DESCRIPTION,
  registeredArgs: hashlineEditArgs,
  examples: hashlineEditExamples,
});

/** Owned contract for str_replace_editor. */
export const strReplaceEditorContract = defineOwnedToolContract({
  toolId: STR_REPLACE_EDITOR_TOOL_ID,
  description: STR_REPLACE_EDITOR_DESCRIPTION,
  registeredArgs: strReplaceEditorArgs,
  examples: strReplaceEditorExamples,
});

/** Owned contracts for both edit tools (input to the owned definition/pre-execute adapters). */
export const editToolContracts: readonly OwnedToolContract<ZodRawShape>[] = [
  hashlineEditContract,
  strReplaceEditorContract,
];
// END_BLOCK_CONTRACTS

// START_BLOCK_ISSUE_HELPERS
function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function boundedIssue(issue: ContractIssue): ContractIssue {
  return {
    code: issue.code,
    path: truncateChars(issue.path, MAX_ISSUE_PATH_CHARS),
    message: truncateChars(issue.message, MAX_ISSUE_MESSAGE_CHARS),
    ...(issue.expected !== undefined
      ? { expected: truncateChars(issue.expected, MAX_ISSUE_MESSAGE_CHARS) }
      : {}),
    ...(issue.received !== undefined
      ? { received: truncateChars(issue.received, MAX_ISSUE_VALUE_CHARS) }
      : {}),
  };
}

function pushIssue(issues: ContractIssue[], issue: ContractIssue): void {
  if (issues.length >= MAX_CONTRACT_ISSUES) return;
  issues.push(boundedIssue(issue));
}

/** Trim an anchor exactly like the normalizer does before comparing references. */
function normalizeAnchor(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
// END_BLOCK_ISSUE_HELPERS

// START_BLOCK_HASHLINE_VALIDATION
/** Successful parsed hashline args or bounded structural/branch issues. */
export type HashlineEditValidation =
  | { ok: true; data: HashlineEditToolArgs }
  | { ok: false; issues: readonly ContractIssue[] };

function validateHashlineEditBranches(issues: ContractIssue[], data: HashlineEditToolArgs): void {
  if (data.filePath.trim().length === 0) {
    pushIssue(issues, {
      code: "missing_value",
      path: "filePath",
      message: "filePath must be a non-empty path",
      expected: "a non-empty file path (spaces inside the name are preserved)",
    });
  }
  if (data.rename !== undefined && data.rename.trim().length === 0) {
    pushIssue(issues, {
      code: "missing_value",
      path: "rename",
      message: "rename must be a non-empty path when provided",
      expected: "a non-empty destination path, or omit rename",
    });
  }
  if (data.delete === true && data.rename !== undefined) {
    pushIssue(issues, {
      code: "invalid_value",
      path: "rename",
      message: "delete and rename cannot be used together",
      expected: "either delete:true or rename, not both",
    });
  }
  if (data.delete === true && data.edits.length > 0) {
    pushIssue(issues, {
      code: "invalid_value",
      path: "edits",
      message: "delete mode requires edits to be an empty array",
      expected: "[]",
    });
  }
  if (data.delete !== true && data.edits.length === 0) {
    pushIssue(issues, {
      code: "missing_value",
      path: "edits",
      message: "edits parameter must be a non-empty array",
      expected: "at least one edit operation",
    });
  }

  data.edits.forEach((edit, index) => {
    if (edit.pos !== undefined && edit.pos.trim() === "") {
      pushIssue(issues, {
        code: "invalid_value",
        path: formatIssuePath(["edits", index, "pos"]),
        message: "pos was provided but is blank",
        expected: "a full three-part anchor, or omit pos",
      });
    }
    if (edit.end !== undefined && edit.end.trim() === "") {
      pushIssue(issues, {
        code: "invalid_value",
        path: formatIssuePath(["edits", index, "end"]),
        message: "end was provided but is blank",
        expected: "a full three-part anchor, or omit end",
      });
    }
    const pos = normalizeAnchor(edit.pos);
    const end = normalizeAnchor(edit.end);
    if (edit.op === "replace" && pos === undefined) {
      pushIssue(issues, {
        code: "missing_value",
        path: formatIssuePath(["edits", index, "pos"]),
        message: "replace requires a pos anchor",
        expected: "a three-part LINE#HASH#ANCHOR reference",
      });
      return;
    }
    if (edit.op === "replace_range") {
      if (pos === undefined) {
        pushIssue(issues, {
          code: "missing_value",
          path: formatIssuePath(["edits", index, "pos"]),
          message: "replace_range requires both pos and end anchors",
          expected: "a three-part pos anchor",
        });
      }
      if (end === undefined) {
        pushIssue(issues, {
          code: "missing_value",
          path: formatIssuePath(["edits", index, "end"]),
          message: "replace_range requires both pos and end anchors",
          expected: "a three-part end anchor",
        });
      }
      return;
    }
    if (
      (edit.op === "append" || edit.op === "prepend") &&
      pos !== undefined &&
      end !== undefined &&
      pos !== end
    ) {
      pushIssue(issues, {
        code: "invalid_value",
        path: formatIssuePath(["edits", index, "end"]),
        message: "pos and end anchors reference different lines for an insert operation",
        expected: "one anchor, or identical pos and end",
      });
    }
  });
}

/**
 * Closed single-edit shape validation reused by the direct normalizer.
 * Rejects unknown properties, malformed provided optional types, a provided
 * non-canonical operation name, and (through the shared schema) missing
 * op/lines. Blank `pos`/`end` are valid strings here and are rejected by the
 * normalizer's anchor step so blank-versus-absent stays distinguishable.
 */
export function validateRawHashlineEditEntry(
  raw: unknown,
  index: number,
): { ok: true; data: RawHashlineEditEntry } | { ok: false; issues: readonly ContractIssue[] } {
  const issues: ContractIssue[] = [];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const op = (raw as Record<string, unknown>).op;
    if (typeof op === "string" && !(HASHLINE_EDIT_OPS as readonly string[]).includes(op)) {
      pushIssue(issues, {
        code: "invalid_value",
        path: formatIssuePath(["edits", index, "op"]),
        message: `unsupported op "${op}". Use replace, replace_range, append, or prepend.`,
        expected: HASHLINE_EDIT_OPS.join(" | "),
      });
      return { ok: false, issues };
    }
  }

  const parsed = hashlineEditEntrySchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const prefix = formatIssuePath(["edits", index]);
  for (const issue of toContractIssues(parsed.error)) {
    pushIssue(issues, {
      ...issue,
      path: issue.path === "(root)" ? prefix : `${prefix}.${issue.path}`,
    });
  }
  return { ok: false, issues };
}

/**
 * Strict structural plus args-only branch validation for hashline_edit.
 * Unknown keys, enums, and nested shapes fail first; then non-empty paths,
 * delete/rename/edits combinations, and per-operation anchor requirements are
 * enforced. Current-file anchor validation, literal payload rejection, and
 * creation remain in the normalizer/executor and stay authoritative.
 */
export function validateHashlineEditToolInput(raw: unknown): HashlineEditValidation {
  const parsed = hashlineEditContract.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.issues };
  }
  const issues: ContractIssue[] = [];
  validateHashlineEditBranches(issues, parsed.data);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, data: parsed.data };
}
// END_BLOCK_HASHLINE_VALIDATION

// START_BLOCK_STR_REPLACE_VALIDATION
/** Successful parsed str editor args or bounded structural/command issues. */
export type StrReplaceEditorValidation =
  | { ok: true; data: StrReplaceEditorToolArgs }
  | { ok: false; issues: readonly ContractIssue[] };

const STR_REPLACE_EDITOR_COMMAND_FIELDS: Record<StrReplaceEditorCommand, readonly string[]> = {
  view: ["command", "path", "view_range"],
  create: ["command", "path", "file_text"],
  str_replace: ["command", "path", "old_str", "new_str"],
  insert: ["command", "path", "new_str", "insert_line"],
};

function validateViewRangeShape(issues: ContractIssue[], viewRange: readonly number[]): void {
  if (viewRange.length !== 2 || !viewRange.every((value) => Number.isInteger(value))) {
    pushIssue(issues, {
      code: "invalid_value",
      path: "view_range",
      message: "view_range must be a list of exactly two integers",
      expected: "[start, end] with integer start and end",
    });
    return;
  }
  const start = viewRange[0]!;
  const end = viewRange[1]!;
  if (start < 1) {
    pushIssue(issues, {
      code: "too_small",
      path: "view_range",
      message: `view_range start ${start} must be >= 1`,
      expected: "start >= 1",
    });
  }
  if (end !== -1 && end < start) {
    pushIssue(issues, {
      code: "invalid_value",
      path: "view_range",
      message: `view_range end ${end} must be -1 or >= start ${start}`,
      expected: "end = -1 or end >= start",
    });
  }
}

/**
 * Strict structural plus command-specific validation for str_replace_editor.
 * Unknown keys, enums, and types fail first; then recognized fields that the
 * selected command does not consume are rejected rather than dropped, the
 * command's required fields are enforced, and view_range is required to be an
 * exact two-integer range. Path existence, directory checks, the file-length
 * insert bound, exact-match behavior, and freshness checks remain in the editor.
 */
export function validateStrReplaceEditorToolInput(raw: unknown): StrReplaceEditorValidation {
  const parsed = strReplaceEditorContract.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.issues };
  }
  const data = parsed.data;
  const issues: ContractIssue[] = [];

  const allowed = new Set(STR_REPLACE_EDITOR_COMMAND_FIELDS[data.command]);
  for (const key of Object.keys(data)) {
    const value = (data as Record<string, unknown>)[key];
    if (value === undefined || allowed.has(key)) continue;
    pushIssue(issues, {
      code: "invalid_value",
      path: key,
      message: `${key} is not consumed by command ${data.command}`,
      expected: `only ${[...allowed].join(", ")}`,
    });
  }

  if (data.path.trim().length === 0) {
    pushIssue(issues, {
      code: "missing_value",
      path: "path",
      message: "path must be a non-empty path",
      expected: "a non-empty file or directory path (spaces inside the name are preserved)",
    });
  }
  if (data.command === "create" && data.file_text === undefined) {
    pushIssue(issues, {
      code: "missing_value",
      path: "file_text",
      message: "create requires file_text (an explicitly empty string is allowed)",
      expected: 'a string, including ""',
    });
  }
  if (data.command === "str_replace") {
    if (data.old_str === undefined) {
      pushIssue(issues, {
        code: "missing_value",
        path: "old_str",
        message: "str_replace requires old_str",
        expected: "the exact non-empty text to replace",
      });
    } else if (data.old_str.length === 0) {
      pushIssue(issues, {
        code: "invalid_value",
        path: "old_str",
        message: "old_str must be a non-empty exact string",
        expected: "a non-empty literal string",
      });
    }
  }
  if (data.command === "insert") {
    if (data.new_str === undefined) {
      pushIssue(issues, {
        code: "missing_value",
        path: "new_str",
        message: "insert requires new_str (an explicitly empty string is allowed)",
        expected: 'a string, including ""',
      });
    }
    if (data.insert_line === undefined) {
      pushIssue(issues, {
        code: "missing_value",
        path: "insert_line",
        message: "insert requires an integer insert_line >= 0",
        expected: "an integer >= 0",
      });
    } else if (!Number.isInteger(data.insert_line) || data.insert_line < 0) {
      pushIssue(issues, {
        code: "too_small",
        path: "insert_line",
        message: "insert_line must be an integer >= 0",
        expected: "an integer >= 0",
      });
    }
  }
  if (data.view_range !== undefined) {
    validateViewRangeShape(issues, data.view_range);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, data };
}
// END_BLOCK_STR_REPLACE_VALIDATION
