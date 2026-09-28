// FILE: src/plugins/hashline-edit.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native hashline-edit boundary: native read-output anchoring, hash-anchored and dsh edit execution against real temporary files, routing visibility per actual session model, awaited permission-before-write, stale-anchor rejection, and truthful reporting when metadata publication fails.
//   SCOPE: Native handler seam tests using real temporary files and pinned native tool context/result shapes, plus unchanged pure edit-primitive coverage.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/index.ts, src/plugins/hashline-edit/schemas.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   METADATA_FAILURE_SECRET - Sentinel secret that must never leak through a metadata failure.
//   METADATA_FAILURE_MESSAGE - Oversized metadata failure message embedding the sentinel secret.
//   createHarness - Build native handlers with an injected settings resolver and recording permission.
//   createToolContext - Build a pinned native tool context fixture (optionally with a throwing progress).
//   anchorFor - Build a visible hashline anchor for fixture content.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 - Rewrote V1 plugin-input/chat.message/tool.execute hook tests as native handler tests with pinned native tool context/result shapes and real temporary-file edits.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { z } from "zod";
import {
  applyInsertAfter,
  applyInsertBefore,
  applyReplaceLines,
} from "./hashline-edit/edit-operation-primitives.js";
import { computeAnchorHash, computeLineHash } from "./hashline-edit/hash-computation.js";
import {
  createHashlineEditHandlers,
  createHashlineEditPlugin,
  type HashlineEditHandlers,
  type HashlinePermissionGuard,
} from "./hashline-edit/index.js";
import {
  DEFAULT_ROUTING_CONFIG,
  type HashlineEditPluginSettings,
} from "./hashline-edit/routing.js";
import {
  hashlineEditContract,
  hashlineEditMetadataSchema,
  strReplaceEditorContract,
  strReplaceEditorMetadataSchema,
} from "./hashline-edit/schemas.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const METADATA_FAILURE_SECRET = "SECRET_TOKEN_must_not_leak";
const METADATA_FAILURE_MESSAGE = `${METADATA_FAILURE_SECRET} ${"x".repeat(4096)}`;

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = join(tmpdir(), `vvoc-hashline-empty-config-${process.pid}`);
});

afterEach(() => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});

interface Harness {
  handlers: HashlineEditHandlers;
  readonly permissionCalls: Array<{
    action: string;
    resources: ReadonlyArray<string>;
    sessionID: string;
  }>;
  readonly permissionFailures: Error[];
}

function createHarness(
  settings: HashlineEditPluginSettings | null = {
    enabled: true,
    routing: DEFAULT_ROUTING_CONFIG,
  },
  options: { denyPermission?: boolean } = {},
): Harness {
  const resolvedSettings = settings === null ? undefined : settings;
  const permissionCalls: Harness["permissionCalls"] = [];
  const permission: HashlinePermissionGuard = {
    async guard(input, effect, guardOptions) {
      permissionCalls.push({
        action: input.action,
        resources: input.resources,
        sessionID: input.sessionID,
      });
      if (options.denyPermission) throw new Error("PERMISSION_DENIED");
      if (guardOptions?.signal?.aborted) throw new Error("PERMISSION_ABORTED");
      return effect();
    },
  };
  const registration = createHashlineEditHandlers({
    settingsFor: async () => resolvedSettings,
    permission,
    log: () => undefined,
  });
  return { handlers: registration.handlers, permissionCalls, permissionFailures: [] };
}

function recordModel(handlers: HashlineEditHandlers, sessionID: string, modelID: string): void {
  handlers.recordModel({ sessionID, model: { providerID: "test-provider", id: modelID } });
}

function createToolContext(
  options: { sessionID?: string; metadataThrows?: boolean; aborted?: boolean } = {},
): {
  context: ToolContext;
  metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }>;
} {
  const metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }> = [];
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  return {
    context: {
      sessionID: options.sessionID ?? "session-1",
      agent: "build",
      messageID: "message-1",
      id: "call-1",
      signal: controller.signal,
      progress: async (update: { title?: string; metadata?: Record<string, unknown> }) => {
        if (options.metadataThrows) {
          throw new Error(METADATA_FAILURE_MESSAGE);
        }
        metadataCalls.push(update);
      },
    } as unknown as ToolContext,
    metadataCalls,
  };
}

function anchorFor(lines: string[], line: number): string {
  const content = lines[line - 1] ?? "";
  const hash = computeLineHash(line, content);
  const anchor = computeAnchorHash(line, lines[line - 2], content, lines[line]);
  return `${line}#${hash}#${anchor}`;
}

describe("HashlineEditPlugin read anchoring", () => {
  test("registers both native tools and hashes read output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-"));
    try {
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      expect(handlers.tools.hashline_edit.name).toBe("hashline_edit");
      expect(handlers.tools.str_replace_editor.name).toBe("str_replace_editor");

      const result = { content: "1: const first = 1;\n2: const second = 2;" };
      await handlers.after({
        tool: "read",
        sessionID: "session-1",
        input: {},
        status: "completed",
        result,
      });

      const lh1 = computeLineHash(1, "const first = 1;");
      const lh2 = computeLineHash(2, "const second = 2;");
      const ah1 = computeAnchorHash(1, undefined, "const first = 1;", "const second = 2;");
      const ah2 = computeAnchorHash(2, "const first = 1;", "const second = 2;", undefined);
      expect(result.content).toBe(
        `1#${lh1}#${ah1}|const first = 1;\n2#${lh2}#${ah2}|const second = 2;`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("hashes wrapped <content> read output", async () => {
    const { handlers } = createHarness();
    recordModel(handlers, "session-1", "minimax-m2");
    const result = { content: "<content>1: const first = 1;\n2: const second = 2;\n</content>" };
    await handlers.after({
      tool: "read",
      sessionID: "session-1",
      input: {},
      status: "completed",
      result,
    });
    const lh1 = computeLineHash(1, "const first = 1;");
    const lh2 = computeLineHash(2, "const second = 2;");
    const ah1 = computeAnchorHash(1, undefined, "const first = 1;", "const second = 2;");
    const ah2 = computeAnchorHash(2, "const first = 1;", "const second = 2;", undefined);
    expect(result.content).toBe(
      `<content>\n1#${lh1}#${ah1}|const first = 1;\n2#${lh2}#${ah2}|const second = 2;\n</content>`,
    );
  });

  test("uses the full file snapshot for partial read context anchors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-partial-"));
    try {
      const filePath = join(directory, "partial.txt");
      await writeFile(filePath, "line1\nline2\nline3", "utf8");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const result = { content: "2: line2\n3: line3" };
      await handlers.after({
        tool: "read",
        sessionID: "session-1",
        input: { path: filePath },
        status: "completed",
        result,
      });
      const anchor = `2#${computeLineHash(2, "line2")}#${computeAnchorHash(2, "line1", "line2", "line3")}`;
      expect(result.content).toContain(`${anchor}|line2`);

      const { context } = createToolContext();
      const edit = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: anchor, lines: ["line2 updated"] }] },
        context,
      );
      expect(edit.output).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2 updated\nline3");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("adds anchors only for hashline sessions", async () => {
    const { handlers } = createHarness();
    recordModel(handlers, "session-deepseek", "deepseek-v4-flash");
    const deepseek = { content: "1: const a = 1;" };
    await handlers.after({
      tool: "read",
      sessionID: "session-deepseek",
      input: {},
      status: "completed",
      result: deepseek,
    });
    expect(deepseek.content).toBe("1: const a = 1;");

    recordModel(handlers, "session-minimax", "minimax-m2");
    const minimax = { content: "1: const a = 1;" };
    await handlers.after({
      tool: "read",
      sessionID: "session-minimax",
      input: {},
      status: "completed",
      result: minimax,
    });
    expect(minimax.content).toContain("1#");
    expect(minimax.content).toContain("|const a = 1;");
  });
});

describe("HashlineEditPlugin edit execution", () => {
  test("applies anchored replace edits and emits filediff metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-edit-"));
    try {
      const filePath = join(directory, "sample.ts");
      await writeFile(filePath, 'function greet() {\n  return "hi";\n}\n', "utf8");
      const { handlers, permissionCalls } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const anchor = `2#${computeLineHash(2, '  return "hi";')}#${computeAnchorHash(2, "function greet() {", '  return "hi";', "}")}`;
      const { context, metadataCalls } = createToolContext();

      const result = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: anchor, lines: ['  return "hello";'] }] },
        context,
      );

      expect(result.output).toContain(`Updated ${filePath}`);
      expect(result.output).toContain("+1/-1");
      expect(result.output).toContain("first change line 2");
      expect(await readFile(filePath, "utf8")).toBe('function greet() {\n  return "hello";\n}\n');
      expect(permissionCalls).toEqual([
        { action: "edit", resources: [filePath], sessionID: "session-1" },
      ]);
      expect(metadataCalls).toHaveLength(1);
      expect(metadataCalls[0]?.title).toBe(filePath);
      expect((metadataCalls[0]?.metadata?.filediff as { after?: string } | undefined)?.after).toBe(
        'function greet() {\n  return "hello";\n}\n',
      );
      expect(hashlineEditMetadataSchema.safeParse(metadataCalls[0]?.metadata).success).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("applies ranged replace and anchored append in one call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-batch-"));
    try {
      const filePath = join(directory, "sample.ts");
      const originalLines = ["line1", "line2", "line3", "line4"];
      await writeFile(filePath, `${originalLines.join("\n")}\n`, "utf8");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext();

      const result = await handlers.tools.hashline_edit.execute(
        {
          filePath,
          edits: [
            {
              op: "replace_range",
              pos: anchorFor(originalLines, 2),
              end: anchorFor(originalLines, 3),
              lines: ["replaced"],
            },
            { op: "append", pos: anchorFor(originalLines, 4), lines: ["inserted"] },
          ],
        },
        context,
      );

      expect(result.output).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("line1\nreplaced\nline4\ninserted\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates a missing file from prepend and append edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-create-"));
    try {
      const filePath = join(directory, "created.ts");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext();
      const result = await handlers.tools.hashline_edit.execute(
        {
          filePath,
          edits: [
            { op: "append", lines: ["line2"] },
            { op: "prepend", lines: ["line1"] },
          ],
        },
        context,
      );
      expect(result.output).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("renames a file after applying edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-rename-"));
    try {
      const filePath = join(directory, "source.ts");
      const renamedPath = join(directory, "renamed.ts");
      const originalLines = ["line1", "line2"];
      await writeFile(filePath, originalLines.join("\n"), "utf8");
      const { handlers, permissionCalls } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext();
      const result = await handlers.tools.hashline_edit.execute(
        {
          filePath,
          rename: renamedPath,
          edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: ["line2-updated"] }],
        },
        context,
      );
      expect(result.output).toContain(`Moved ${filePath} to ${renamedPath}`);
      await expect(readFile(filePath, "utf8")).rejects.toThrow();
      expect(await readFile(renamedPath, "utf8")).toBe("line1\nline2-updated");
      expect(permissionCalls[0]?.resources).toEqual([filePath, renamedPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("deletes a file in delete mode and rejects delete/edits and delete/rename conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-delete-"));
    try {
      const filePath = join(directory, "delete-me.ts");
      await writeFile(filePath, "line1\n", "utf8");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext();

      const conflict = await handlers.tools.hashline_edit.execute(
        { filePath, delete: true, edits: [{ op: "replace", pos: "1#ZZ#ZZ", lines: ["bad"] }] },
        context,
      );
      expect(conflict.output).toContain("delete mode requires edits to be an empty array");

      const renameConflict = await handlers.tools.hashline_edit.execute(
        {
          filePath,
          delete: true,
          rename: join(directory, "new-name.ts"),
          edits: [],
        },
        context,
      );
      expect(renameConflict.output).toContain("delete and rename cannot be used together");

      const deleted = await handlers.tools.hashline_edit.execute(
        { filePath, delete: true, edits: [] },
        context,
      );
      expect(deleted.output).toBe(`Successfully deleted ${filePath}`);
      await expect(readFile(filePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects anchored append when the target file is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-missing-"));
    try {
      const filePath = join(directory, "missing.ts");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext();
      const result = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "append", pos: "1#ZZ#ZZ", lines: ["bad"] }] },
        context,
      );
      expect(result.output).toContain(`Error: File not found: ${filePath}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports no-op edits and rejects stale anchors with an updated mismatch snippet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-stale-"));
    try {
      const filePath = join(directory, "stale.ts");
      const originalLines = ["line1", "line2"];
      await writeFile(filePath, `${originalLines.join("\n")}\n`, "utf8");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext();

      const noop = await handlers.tools.hashline_edit.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: ["line2"] }],
        },
        context,
      );
      expect(noop.output).toContain("No changes made");
      expect(noop.output).toContain("No-op edits: 1");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2\n");

      await writeFile(filePath, 'function greet() {\n  return "hi";\n}\n', "utf8");
      const staleAnchor = `2#${computeLineHash(2, '  return "hi";')}#${computeAnchorHash(2, "function greet() {", '  return "hi";', "}")}`;
      await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: staleAnchor, lines: ['  return "hello";'] }] },
        createToolContext().context,
      );
      const second = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: staleAnchor, lines: ['  return "bonjour";'] }] },
        createToolContext().context,
      );
      expect(second.output).toContain("Error: hash mismatch");
      expect(second.output).toContain(
        `>>> 2#${computeLineHash(2, '  return "hello";')}#${computeAnchorHash(2, "function greet() {", '  return "hello";', "}")}|  return "hello";`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves BOM and CRLF when writing through hashline edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-crlf-"));
    try {
      const filePath = join(directory, "windows.ts");
      const original = "\uFEFFconst first = 1;\r\nconst second = 2;\r\n";
      await writeFile(filePath, original, "utf8");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const anchor = `2#${computeLineHash(2, "const second = 2;")}#${computeAnchorHash(2, "const first = 1;", "const second = 2;", "")}`;
      const result = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: anchor, lines: ["const second = 3;"] }] },
        createToolContext().context,
      );
      expect(result.output).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe(
        "\uFEFFconst first = 1;\r\nconst second = 3;\r\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires permission before any write and respects caller abort and denial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-perm-"));
    try {
      const filePath = join(directory, "perm.ts");
      const original = "line1\nline2\n";
      const originalLines = ["line1", "line2"];
      await writeFile(filePath, original, "utf8");

      const denied = createHarness(
        { enabled: true, routing: DEFAULT_ROUTING_CONFIG },
        { denyPermission: true },
      );
      recordModel(denied.handlers, "session-1", "minimax-m2");
      await expect(
        denied.handlers.tools.hashline_edit.execute(
          { filePath, edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: ["x"] }] },
          createToolContext().context,
        ),
      ).rejects.toThrow("PERMISSION_DENIED");
      expect(await readFile(filePath, "utf8")).toBe(original);

      const aborted = createHarness();
      recordModel(aborted.handlers, "session-1", "minimax-m2");
      await expect(
        aborted.handlers.tools.hashline_edit.execute(
          { filePath, edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: ["x"] }] },
          createToolContext({ aborted: true }).context,
        ),
      ).rejects.toThrow("PERMISSION_ABORTED");
      expect(await readFile(filePath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("HashlineEditPlugin routing and visibility", () => {
  async function seedDefinitions(handlers: HashlineEditHandlers) {
    const all: Record<string, unknown> = {
      hashline_edit: { description: "owned-hashline", input: {} },
      str_replace_editor: { description: "owned-str", input: {} },
      edit: { description: "native-edit", input: { type: "object" } },
      write: { description: "native-write", input: { type: "object" } },
      patch: { description: "native-patch", input: { type: "object" } },
    };
    handlers.recordModel({ sessionID: "__seed", model: { providerID: "seed", id: "minimax-m2" } });
    await handlers.sessionContext({ sessionID: "__seed", tools: all });
  }

  function allTools(): Record<string, unknown> {
    return {
      hashline_edit: { description: "owned-hashline", input: {} },
      str_replace_editor: { description: "owned-str", input: {} },
      edit: { description: "native-edit", input: { type: "object" } },
      write: { description: "native-write", input: { type: "object" } },
      patch: { description: "native-patch", input: { type: "object" } },
    };
  }

  test("governs exactly one edit mode per actual session model", async () => {
    const { handlers } = createHarness();
    await seedDefinitions(handlers);

    const deepseek = allTools();
    recordModel(handlers, "s1", "deepseek-v4-flash");
    await handlers.sessionContext({ sessionID: "s1", tools: deepseek });
    expect(Object.keys(deepseek)).toEqual(["str_replace_editor"]);

    const minimax = allTools();
    recordModel(handlers, "s2", "minimax-m2");
    await handlers.sessionContext({ sessionID: "s2", tools: minimax });
    expect(Object.keys(minimax)).toEqual(["hashline_edit"]);

    const kimi = allTools();
    recordModel(handlers, "s3", "kimi-k3");
    await handlers.sessionContext({ sessionID: "s3", tools: kimi });
    expect(Object.keys(kimi).sort()).toEqual(["edit", "write"]);

    const gpt = allTools();
    recordModel(handlers, "s4", "gpt-5.4");
    await handlers.sessionContext({ sessionID: "s4", tools: gpt });
    expect(Object.keys(gpt)).toEqual(["patch"]);
  });

  test("GPT routed to hashline_edit shows hashline and hides native patch/edit", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "hashline_edit", rules: [] },
    });
    await seedDefinitions(handlers);
    const gpt = allTools();
    recordModel(handlers, "s1", "gpt-5.4");
    await handlers.sessionContext({ sessionID: "s1", tools: gpt });
    expect(Object.keys(gpt)).toEqual(["hashline_edit"]);
  });

  test("GPT override to edit restores the genuine native edit/write definitions", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "apply_patch", rules: [{ pattern: "gpt", mode: "edit" }] },
    });
    await seedDefinitions(handlers);
    // The host gpt gate deleted edit/write before this plugin's hook ran.
    const gpt: Record<string, unknown> = {
      hashline_edit: { description: "owned-hashline", input: {} },
      str_replace_editor: { description: "owned-str", input: {} },
      patch: { description: "native-patch", input: { type: "object" } },
    };
    recordModel(handlers, "s1", "gpt-5.4");
    await handlers.sessionContext({ sessionID: "s1", tools: gpt });
    expect(gpt).toEqual({
      edit: { description: "native-edit", input: { type: "object" } },
      write: { description: "native-write", input: { type: "object" } },
    });
  });

  test("non-GPT override to apply_patch restores the genuine native patch definition", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "apply_patch", rules: [] },
    });
    await seedDefinitions(handlers);
    // The host gate deleted patch for this non-GPT model before this hook ran.
    const tools: Record<string, unknown> = {
      hashline_edit: { description: "owned-hashline", input: {} },
      str_replace_editor: { description: "owned-str", input: {} },
      edit: { description: "native-edit", input: { type: "object" } },
      write: { description: "native-write", input: { type: "object" } },
    };
    recordModel(handlers, "s1", "minimax-m2");
    await handlers.sessionContext({ sessionID: "s1", tools });
    expect(tools).toEqual({ patch: { description: "native-patch", input: { type: "object" } } });
  });

  test("refuses silently-exposed native tools when no genuine definition was observed", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "apply_patch", rules: [{ pattern: "gpt", mode: "edit" }] },
    });
    const gpt: Record<string, unknown> = {
      hashline_edit: { description: "owned-hashline", input: {} },
      str_replace_editor: { description: "owned-str", input: {} },
      patch: { description: "native-patch", input: { type: "object" } },
    };
    recordModel(handlers, "s1", "gpt-5.4");
    await expect(handlers.sessionContext({ sessionID: "s1", tools: gpt })).rejects.toThrow(
      /cannot expose native tool edit/,
    );
  });

  test("an explicit model switch changes visibility for the same session", async () => {
    const { handlers } = createHarness();
    await seedDefinitions(handlers);

    recordModel(handlers, "s1", "minimax-m2");
    const first = allTools();
    await handlers.sessionContext({ sessionID: "s1", tools: first });
    expect(Object.keys(first)).toEqual(["hashline_edit"]);

    handlers.recordModelRequest({
      sessionID: "s1",
      model: { providerID: "kimi-for-coding", id: "kimi-k3" },
    });
    const second = allTools();
    await handlers.sessionContext({ sessionID: "s1", tools: second });
    expect(Object.keys(second).sort()).toEqual(["edit", "write"]);
  });

  test("execute.before denies a hidden owned tool before argument validation and guards an allowed tool", async () => {
    const { handlers } = createHarness();
    recordModel(handlers, "session-1", "deepseek-v4-flash");

    await expect(
      handlers.before({ tool: "hashline_edit", sessionID: "session-1", input: {} }),
    ).rejects.toThrow(/str_replace_editor instead/);

    await expect(
      handlers.before({
        tool: "str_replace_editor",
        sessionID: "session-1",
        input: { command: "view", path: "/tmp/x" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      handlers.before({
        tool: "str_replace_editor",
        sessionID: "session-1",
        input: { command: "view", path: "/tmp/x", old_str: "boom" },
      }),
    ).rejects.toThrow(/old_str is not consumed by command view/);
  });

  test("execute.before enforces the same mode for native edit tools", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "apply_patch", rules: [] },
    });
    recordModel(handlers, "session-1", "minimax-m2");
    await expect(
      handlers.before({ tool: "edit", sessionID: "session-1", input: { path: "/tmp/x" } }),
    ).rejects.toThrow(/different edit tool/);
    await expect(
      handlers.before({ tool: "patch", sessionID: "session-1", input: { patchText: "x" } }),
    ).resolves.toBeUndefined();
  });

  test("direct execute enforces session model visibility before argument details", async () => {
    const { handlers } = createHarness();
    recordModel(handlers, "session-1", "deepseek-v4-flash");
    await expect(
      handlers.tools.hashline_edit.execute({}, createToolContext().context),
    ).rejects.toThrow(/str_replace_editor instead/);
  });

  test("disabled or unbound settings deny owned execution and hide only the owned tools", async () => {
    const { handlers } = createHarness(null);
    const tools = allTools();
    await handlers.sessionContext({ sessionID: "s1", tools });
    expect(Object.keys(tools).sort()).toEqual(["edit", "patch", "write"]);
    await expect(
      handlers.tools.hashline_edit.execute(
        { filePath: "/tmp/x.ts", edits: [{ op: "append", lines: ["a"] }] },
        createToolContext().context,
      ),
    ).rejects.toThrow(/no hashline-edit family policy/);
  });

  test("an explicitly disabled policy denies owned execution and never forces a mode", async () => {
    const { handlers } = createHarness({ enabled: false, routing: DEFAULT_ROUTING_CONFIG });
    const tools = allTools();
    await handlers.sessionContext({ sessionID: "s1", tools });
    expect(Object.keys(tools).sort()).toEqual(["edit", "patch", "write"]);
    await expect(
      handlers.tools.hashline_edit.execute({}, createToolContext().context),
    ).rejects.toThrow(/disabled for the captured policy/);
  });

  test("captured routing overrides change visibility", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "hashline_edit", rules: [{ pattern: "qwen", mode: "hashline_edit" }] },
    });
    const tools = allTools();
    handlers.recordModel({ sessionID: "s1", model: { providerID: "alibaba", id: "qwen3.8-max" } });
    await handlers.sessionContext({ sessionID: "s1", tools });
    expect(Object.keys(tools)).toEqual(["hashline_edit"]);
  });
});

describe("HashlineEditPlugin dsh str_replace_editor", () => {
  test("executes view and str_replace with permission before the write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-dsh-"));
    try {
      const filePath = join(directory, "sample.py");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const { handlers, permissionCalls } = createHarness();
      recordModel(handlers, "session-1", "deepseek-v4-flash");
      const { context, metadataCalls } = createToolContext();

      const viewed = await handlers.tools.str_replace_editor.execute(
        { command: "view", path: filePath },
        context,
      );
      expect(viewed.output).toContain("Here's the content of");
      expect(permissionCalls).toEqual([]);

      const replaced = await handlers.tools.str_replace_editor.execute(
        { command: "str_replace", path: filePath, old_str: "beta", new_str: "BETA" },
        context,
      );
      expect(replaced.output).toBe(`The file ${filePath} has been edited successfully.`);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\n");
      expect(permissionCalls).toEqual([
        { action: "edit", resources: [filePath], sessionID: "session-1" },
      ]);
      expect(strReplaceEditorMetadataSchema.safeParse(metadataCalls[0]?.metadata).success).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("HashlineEditPlugin truthful reporting", () => {
  test("a metadata publication failure after a successful edit stays truthful", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-meta-fail-"));
    try {
      const filePath = join(directory, "sample.ts");
      await writeFile(filePath, "line1\nline2\n", "utf8");
      const { handlers } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context } = createToolContext({ metadataThrows: true });
      const result = await handlers.tools.hashline_edit.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(["line1", "line2"], 2), lines: ["new"] }],
        },
        context,
      );
      expect(result.output).toContain("reporting metadata failed");
      expect(result.output).not.toContain(METADATA_FAILURE_SECRET);
      expect(await readFile(filePath, "utf8")).toBe("line1\nnew\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("direct hashline execute rejects structural input without editing or reporting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-structural-"));
    try {
      const filePath = join(directory, "sample.ts");
      await writeFile(filePath, "keep\n", "utf8");
      const { handlers, permissionCalls } = createHarness();
      recordModel(handlers, "session-1", "minimax-m2");
      const { context, metadataCalls } = createToolContext();
      const rejected = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [], extra: true },
        context,
      );
      expect(rejected.output).toContain("Error:");
      expect(rejected.output).toContain("unrecognized");
      expect(await readFile(filePath, "utf8")).toBe("keep\n");
      expect(metadataCalls).toEqual([]);
      expect(permissionCalls).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("HashlineEditPlugin cold-start native definitions", () => {
  function registryInfos() {
    return [
      {
        name: "hashline_edit",
        description: "Owned hashline",
        input: hashlineEditContract.runtimeSchema,
      },
      {
        name: "str_replace_editor",
        description: "Owned str",
        input: strReplaceEditorContract.runtimeSchema,
      },
      { name: "edit", description: "Native edit", input: z.object({ path: z.string() }) },
      { name: "write", description: "Native write", input: Schema.Struct({ path: Schema.String }) },
      { name: "patch", description: "Native patch", input: { type: "object", properties: {} } },
    ];
  }

  async function setupPlugin(settings: unknown) {
    const sessionHooks = new Map<string, (event: never) => unknown>();
    const vvoc = createDefaultVvocConfig();
    vvoc.plugins = { ...vvoc.plugins, "hashline-edit": settings as never };
    const fakeRuntime = {
      snapshots: {
        configFor: async () => ({ familyId: "fam-1", vvoc }),
        accept: async () => ({ status: "unbound" }),
      },
      permissions: {
        guard: async (_input: unknown, effect: () => Promise<unknown> | unknown) => effect(),
      },
      effectiveConfig: () => ({ vvoc }),
      release: async () => undefined,
    };
    const fakeContext = {
      location: {
        directory: "/tmp/project",
        project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
      },
      tool: {
        list: async () => registryInfos(),
        transform: async () => ({ dispose: async () => undefined }),
        hook: async () => ({ dispose: async () => undefined }),
      },
      session: {
        hook: async (name: string, callback: (event: never) => unknown) => {
          sessionHooks.set(name, callback);
          return { dispose: async () => undefined };
        },
      },
    };
    const plugin = createHashlineEditPlugin({ acquireRuntime: async () => fakeRuntime as never });
    await plugin.setup(fakeContext as never);
    return {
      runContext: async (modelID: string, tools: Record<string, unknown>) => {
        const handler = sessionHooks.get("context");
        if (handler === undefined) throw new Error("no context hook");
        await handler({
          sessionID: "s1",
          model: { providerID: "openai", id: modelID },
          tools,
        } as never);
        return tools;
      },
    };
  }

  test("the FIRST GPT request with override edit restores genuine edit/write schemas", async () => {
    const { runContext } = await setupPlugin({
      enabled: true,
      routing: { default: "apply_patch", rules: { gpt: "edit" } },
    });
    // The host gate already removed edit/write for this cold GPT request.
    const tools: Record<string, unknown> = {
      hashline_edit: { description: "owned", input: {} },
      str_replace_editor: { description: "owned", input: {} },
      patch: { description: "native-patch", input: { type: "object" } },
    };
    await runContext("gpt-5.4", tools);

    expect(Object.keys(tools).sort()).toEqual(["edit", "write"]);
    const edit = tools.edit as {
      description: string;
      input: { type?: string; properties?: Record<string, { type?: string }> };
    };
    expect(edit.description).toBe("Native edit");
    expect(edit.input.type).toBe("object");
    expect(edit.input.properties?.path?.type).toBe("string");
    const write = tools.write as { description: string; input: { type?: string } };
    expect(write.description).toBe("Native write");
    expect(write.input.type).toBe("object");
  });

  test("GPT routed to hashline_edit hides and denies native patch", async () => {
    const { runContext } = await setupPlugin({
      enabled: true,
      routing: { default: "apply_patch", rules: { gpt: "hashline_edit" } },
    });
    const tools: Record<string, unknown> = {
      hashline_edit: { description: "owned", input: {} },
      patch: { description: "native-patch", input: { type: "object" } },
      edit: { description: "native-edit", input: { type: "object" } },
    };
    await runContext("gpt-5.4", tools);
    expect(Object.keys(tools)).toEqual(["hashline_edit"]);
  });

  test("a cold non-GPT request routed to apply_patch restores genuine native patch", async () => {
    const { runContext } = await setupPlugin({
      enabled: true,
      routing: { default: "apply_patch", rules: {} },
    });
    const tools: Record<string, unknown> = {
      hashline_edit: { description: "owned", input: {} },
      str_replace_editor: { description: "owned", input: {} },
      edit: { description: "native-edit", input: { type: "object" } },
      write: { description: "native-write", input: { type: "object" } },
    };
    await runContext("minimax-m2", tools);
    expect(Object.keys(tools)).toEqual(["patch"]);
    expect((tools.patch as { description: string }).description).toBe("Native patch");
  });
});

describe("pure edit primitives", () => {
  test("strips boundary echo around range replacements", () => {
    const lines = ["before", "old 1", "old 2", "after"];
    expect(
      applyReplaceLines(lines, anchorFor(lines, 2), anchorFor(lines, 3), [
        "before",
        "new 1",
        "new 2",
        "after",
      ]),
    ).toEqual(["before", "new 1", "new 2", "after"]);
  });

  test("applies insert before and after primitives", () => {
    const lines = ["a", "b"];
    expect(applyInsertAfter(lines, anchorFor(lines, 1), ["x"])).toEqual(["a", "x", "b"]);
    expect(applyInsertBefore(lines, anchorFor(lines, 2), ["y"])).toEqual(["a", "y", "b"]);
  });
});
