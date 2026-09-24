// FILE: src/plugins/hashline-edit/contracts.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Contract coverage of the two registered edit tool definitions: model-facing JSON Schema projection (closed roots, closed nested edits, canonical enums, field descriptions), SDK-shaped schema acceptance/rejection, operation/command branch accept/reject fixtures, and concrete metadata/result producer schemas.
//   SCOPE: Pure contract schemas and validators only; no filesystem, session cache, plugin lifecycle, or host process.
//   DEPENDS: [bun:test, @opencode-ai/plugin (tool.schema), src/plugins/hashline-edit/schemas.ts, src/plugins/hashline-edit/tool-description.ts, src/plugins/hashline-edit/routing.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   projectionOf - Input-mode JSON Schema projection for one edit contract.
//   propertiesOf - Narrow a projection to its properties record.
//   hashlineAccepts - Representative accepted hashline fixtures per operation.
//   hashlineRejects - Representative rejected hashline fixtures per branch.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Correction cycle: added the owned insert_line/view_range bound projection checks, non-empty path/blank-anchor reject fixtures, and direct-normalizer/shared-shape agreement coverage on top of the initial contract-projection and producer tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import {
  HASHLINE_EDIT_OPS,
  editToolContracts,
  hashlineEditArgs,
  hashlineEditContract,
  hashlineEditMetadataSchema,
  strReplaceEditorArgs,
  strReplaceEditorContract,
  strReplaceEditorMetadataSchema,
  strReplaceEditorResultSchema,
  validateHashlineEditToolInput,
  validateStrReplaceEditorToolInput,
} from "./schemas.js";
import { normalizeHashlineEdits } from "./normalize-edits.js";
import { EDIT_MODES } from "./routing.js";

function projectionOf(contract: {
  inputJsonSchema: Record<string, unknown>;
}): Record<string, unknown> {
  return contract.inputJsonSchema;
}

function propertiesOf(projection: Record<string, unknown>): Record<string, unknown> {
  const properties = projection.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error("projection has no properties");
  }
  return properties as Record<string, unknown>;
}

const hashlineAccepts: Array<Record<string, unknown>> = [
  { filePath: "/tmp/a.ts", edits: [{ op: "replace", pos: "2#VK#ZZ", lines: ["x"] }] },
  {
    filePath: "/tmp/a.ts",
    edits: [{ op: "replace", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
  },
  {
    filePath: "/tmp/a.ts",
    edits: [{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
  },
  {
    filePath: "/tmp/a.ts",
    edits: [{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: null }],
  },
  { filePath: "/tmp/a.ts", edits: [{ op: "append", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", edits: [{ op: "prepend", end: "3#MB#ZZ", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", delete: true, edits: [] },
  { filePath: "/tmp/a.ts", rename: "/tmp/b.ts", edits: [{ op: "append", lines: ["x"] }] },
];

const hashlineRejects: Array<Record<string, unknown>> = [
  { filePath: "/tmp/a.ts", delete: true, rename: "/tmp/b.ts", edits: [] },
  { filePath: "/tmp/a.ts", delete: true, edits: [{ op: "replace", pos: "2#VK#ZZ", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", edits: [] },
  {
    filePath: "/tmp/a.ts",
    edits: [{ op: "append", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: ["x"] }],
  },
  { filePath: "/tmp/a.ts", edits: [{ op: "replace", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", edits: [{ op: "replace_range", pos: "2#VK#ZZ", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", edits: [{ op: "set_line", pos: "2#VK#ZZ", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", edits: [{ op: "append", pos: "   ", lines: ["x"] }] },
  { filePath: "   ", edits: [{ op: "append", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", rename: "  ", edits: [{ op: "append", lines: ["x"] }] },
  { filePath: "/tmp/a.ts", edits: [{ op: "append", lines: ["x"] }], extra: true },
];

describe("registered argument maps match the pinned SDK shape", () => {
  test("each registered shape parses a valid fixture through the SDK schema instance", () => {
    const hashline = tool.schema.object(hashlineEditArgs as never);
    expect(
      hashline.safeParse({
        filePath: "/tmp/a.ts",
        edits: [{ op: "replace", pos: "2#VK#ZZ", lines: ["x"] }],
      }).success,
    ).toBe(true);

    const str = tool.schema.object(strReplaceEditorArgs as never);
    expect(str.safeParse({ command: "view", path: "/tmp/a.ts", view_range: [1, -1] }).success).toBe(
      true,
    );
  });
});

describe("model-facing JSON Schema projection", () => {
  test("hashline_edit projects a closed root and closed nested edits", () => {
    const projection = projectionOf(hashlineEditContract);
    expect(projection.type).toBe("object");
    expect(projection.additionalProperties).toBe(false);
    const properties = propertiesOf(projection);
    expect(Object.keys(properties).sort()).toEqual(["delete", "edits", "filePath", "rename"]);

    const edits = properties.edits as {
      type: string;
      maxItems?: number;
      items: { additionalProperties?: boolean; properties: Record<string, unknown> };
    };
    expect(edits.type).toBe("array");
    expect(edits.maxItems).toBeUndefined();
    expect(edits.items.additionalProperties).toBe(false);
    const editProps = edits.items.properties;
    expect((editProps.op as { enum?: string[] }).enum).toEqual([...HASHLINE_EDIT_OPS]);
    expect(JSON.stringify(editProps.lines)).not.toContain("unknown");
    expect(typeof (editProps.pos as { description?: string }).description).toBe("string");
    expect(typeof (properties.filePath as { description?: string }).description).toBe("string");
  });

  test("str_replace_editor projects its closed command vocabulary and fields", () => {
    const projection = projectionOf(strReplaceEditorContract);
    expect(projection.type).toBe("object");
    expect(projection.additionalProperties).toBe(false);
    const properties = propertiesOf(projection);
    expect((properties.command as { enum?: string[] }).enum).toEqual([
      "view",
      "create",
      "str_replace",
      "insert",
    ]);
    expect(typeof (properties.view_range as { description?: string }).description).toBe("string");
    expect(JSON.stringify(properties)).not.toContain("unknown");
  });

  test("editMode metadata enum reuses the canonical routing vocabulary", () => {
    expect(EDIT_MODES).toEqual(["apply_patch", "edit", "str_replace_editor", "hashline_edit"]);
  });

  test("unbounded content and path fields publish no invented caps", () => {
    type Bound = { maxLength?: number; maxItems?: number; items?: Bound };
    const hashlineProps = propertiesOf(projectionOf(hashlineEditContract)) as Record<string, Bound>;
    expect(hashlineProps.filePath.maxLength).toBeUndefined();
    const edits = hashlineProps.edits as unknown as {
      items: { properties: Record<string, Bound> };
    };
    expect(edits.items.properties.pos.maxLength).toBeUndefined();
    expect(edits.items.properties.end.maxLength).toBeUndefined();
    expect(edits.items.properties.lines.maxLength).toBeUndefined();

    const strProps = propertiesOf(projectionOf(strReplaceEditorContract)) as Record<string, Bound>;
    expect(strProps.path.maxLength).toBeUndefined();
    expect(strProps.old_str.maxLength).toBeUndefined();
    expect(strProps.new_str.maxLength).toBeUndefined();
    expect(strProps.file_text.maxLength).toBeUndefined();
    expect(strProps.insert_line.maxLength).toBeUndefined();
  });

  test("owned str constraints publish exactly the representable bounds", () => {
    const strProps = propertiesOf(projectionOf(strReplaceEditorContract)) as Record<
      string,
      Record<string, unknown>
    >;
    // insert_line >= 0 is representable and published.
    expect(strProps.insert_line).toMatchObject({ type: "integer", minimum: 0 });
    // view_range exact length is representable and published as minItems/maxItems 2.
    expect(strProps.view_range).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
    // No content/path caps are invented alongside those owned bounds.
    expect(strProps.path).not.toHaveProperty("maxLength");
    expect(strProps.view_range).not.toHaveProperty("maxLength");
    expect(strProps.path).not.toHaveProperty("minLength");
  });

  test("editToolContracts covers exactly the two registered edit tools", () => {
    expect(editToolContracts.map((contract) => contract.toolId)).toEqual([
      "hashline_edit",
      "str_replace_editor",
    ]);
    for (const contract of editToolContracts) {
      expect(contract.description.length).toBeGreaterThan(0);
      expect(contract.registeredArgs).toBeTypeOf("object");
    }
  });
});

describe("operation/command branch fixtures through the actual contracts", () => {
  test("positive and negative hashline fixtures per branch", () => {
    for (const fixture of hashlineAccepts) {
      const result = validateHashlineEditToolInput(fixture);
      expect(result.ok).toBe(true);
    }
    for (const fixture of hashlineRejects) {
      const result = validateHashlineEditToolInput(fixture);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  test("positive and negative str_replace_editor fixtures per command", () => {
    const accepts: Array<Record<string, unknown>> = [
      { command: "view", path: "/tmp/a.ts" },
      { command: "view", path: "/tmp/a.ts", view_range: [2, -1] },
      { command: "create", path: "/tmp/a.ts", file_text: "" },
      { command: "str_replace", path: "/tmp/a.ts", old_str: "x", new_str: "" },
      { command: "str_replace", path: "/tmp/a.ts", old_str: "x" },
      { command: "insert", path: "/tmp/a.ts", insert_line: 0, new_str: "" },
    ];
    for (const fixture of accepts) {
      expect(validateStrReplaceEditorToolInput(fixture).ok).toBe(true);
    }

    const rejects: Array<Record<string, unknown>> = [
      { command: "view", path: "/tmp/a.ts", old_str: "x" },
      { command: "create", path: "/tmp/a.ts" },
      { command: "create", path: "/tmp/a.ts", file_text: "x", old_str: "y" },
      { command: "str_replace", path: "/tmp/a.ts", old_str: "", new_str: "x" },
      { command: "str_replace", path: "/tmp/a.ts", new_str: "x" },
      { command: "insert", path: "/tmp/a.ts", new_str: "x" },
      { command: "insert", path: "/tmp/a.ts", insert_line: 0 },
      { command: "insert", path: "/tmp/a.ts", insert_line: -1, new_str: "x" },
      { command: "view", path: "/tmp/a.ts", view_range: [1] },
      { command: "view", path: "/tmp/a.ts", view_range: [3, 2] },
      { command: "view", path: "/tmp/a.ts", view_range: [0, 5] },
      { command: "view", path: "/tmp/a.ts", view_range: [1.5, 2] },
      { command: "view", path: "/tmp/a.ts", unknown: true },
      { command: "delete", path: "/tmp/a.ts" },
    ];
    for (const fixture of rejects) {
      const result = validateStrReplaceEditorToolInput(fixture);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  test("checked operation examples agree with the validators", () => {
    for (const example of hashlineEditContract.examples) {
      expect(validateHashlineEditToolInput(example.input).ok).toBe(example.expect === "accept");
    }
    for (const example of strReplaceEditorContract.examples) {
      expect(validateStrReplaceEditorToolInput(example.input).ok).toBe(example.expect === "accept");
    }
  });

  test("accepted hashline examples also normalize without a structural mismatch", () => {
    for (const example of hashlineEditContract.examples) {
      if (example.expect !== "accept") continue;
      const edits = example.input.edits;
      if (!Array.isArray(edits) || edits.length === 0) continue;
      expect(() => normalizeHashlineEdits(edits as never)).not.toThrow();
    }
  });

  test("the direct normalizer shares the closed edit shape: unknown keys and bad types reject", () => {
    expect(() =>
      normalizeHashlineEdits([{ op: "append", lines: ["x"], typo: 1 }] as never),
    ).toThrow(/typo/);
    expect(() => normalizeHashlineEdits([{ op: "append", lines: 5 }] as never)).toThrow(/lines/);
    expect(() =>
      normalizeHashlineEdits([{ op: "append", pos: "   ", lines: ["x"] }] as never),
    ).toThrow(/pos was provided but is blank/);
  });

  test("contracts reject unknown nested keys without filtering them", () => {
    const hashline = hashlineEditContract.safeParse({
      filePath: "/tmp/a.ts",
      edits: [{ op: "append", lines: ["x"], typo: true }],
    });
    expect(hashline.success).toBe(false);
    if (!hashline.success) {
      expect(hashline.issues.some((issue) => issue.path === "edits[0].typo")).toBe(true);
    }

    const str = strReplaceEditorContract.safeParse({
      command: "view",
      path: "/tmp/a.ts",
      nested: { deep: 1 },
    });
    expect(str.success).toBe(false);
    if (!str.success) {
      expect(str.issues.some((issue) => issue.path === "nested")).toBe(true);
    }
  });
});

describe("concrete metadata and result producer schemas", () => {
  test("hashline success metadata validates known fields and rejects blanket records", () => {
    const metadata = {
      filePath: "/tmp/a.ts",
      path: "/tmp/a.ts",
      file: "/tmp/a.ts",
      noopEdits: 0,
      deduplicatedEdits: 0,
      firstChangedLine: 2,
      editMode: "hashline_edit",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      filediff: {
        file: "/tmp/a.ts",
        path: "/tmp/a.ts",
        filePath: "/tmp/a.ts",
        before: "a\n",
        after: "b\n",
      },
    };
    expect(hashlineEditMetadataSchema.safeParse(metadata).success).toBe(true);
    // Undefined optional identifiers are still a valid envelope.
    expect(
      hashlineEditMetadataSchema.safeParse({
        ...metadata,
        firstChangedLine: undefined,
        providerID: undefined,
        modelID: undefined,
      }).success,
    ).toBe(true);
    expect(
      hashlineEditMetadataSchema.safeParse({ ...metadata, opaqueRegion: { anything: true } })
        .success,
    ).toBe(false);
    const missing: Record<string, unknown> = { ...metadata };
    delete missing.filediff;
    expect(hashlineEditMetadataSchema.safeParse(missing).success).toBe(false);
  });

  test("str editor metadata schema rejects unknown fields", () => {
    const metadata = {
      filePath: "/tmp/a.ts",
      path: "/tmp/a.ts",
      file: "/tmp/a.ts",
      editMode: "str_replace_editor",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
    };
    expect(strReplaceEditorMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(strReplaceEditorMetadataSchema.safeParse({ ...metadata, filediff: {} }).success).toBe(
      false,
    );
  });

  test("str editor result schema checks the ok/error envelope", () => {
    expect(strReplaceEditorResultSchema.safeParse({ ok: true, output: "done" }).success).toBe(true);
    expect(strReplaceEditorResultSchema.safeParse({ ok: false, error: "nope" }).success).toBe(true);
    expect(
      strReplaceEditorResultSchema.safeParse({ ok: true, output: "x", error: "y" }).success,
    ).toBe(false);
    expect(strReplaceEditorResultSchema.safeParse({ ok: "yes", output: "x" }).success).toBe(false);
  });
});
