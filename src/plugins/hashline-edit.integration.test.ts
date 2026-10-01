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
//   previousConfigHome - Preserved caller config-home environment.
//   Harness - Native handler harness with recording permission calls.
//   recordModel - Record a session model into the handler cache.
//   REAL_HOST - Pinned host binary from VVOC_E2E_V2_HOST.
//   realHostDescribe - describe when a real host is configured, describe.skip otherwise.
//   HostHelpers - Structural view of the reused scripts/e2e-v2 host helpers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 - Rewrote V1 plugin-input/chat.message/tool.execute hook tests as native handler tests with pinned native tool context/result shapes and real temporary-file edits.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

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
    save?: ReadonlyArray<string>;
  }>;
  readonly permissionFailures: Error[];
}

function createHarness(
  settings: HashlineEditPluginSettings | null = {
    enabled: true,
    routing: DEFAULT_ROUTING_CONFIG,
  },
  options: {
    denyPermission?: boolean;
    denyExternal?: boolean;
    baseDir?: string;
    locations?: Record<string, string>;
    projectRoot?: string;
    projectRoots?: Record<string, string>;
    home?: string;
  } = {},
): Harness {
  const resolvedSettings = settings === null ? undefined : settings;
  const permissionCalls: Harness["permissionCalls"] = [];
  const permission: HashlinePermissionGuard = {
    async guard(input, effect, guardOptions) {
      permissionCalls.push({
        action: input.action,
        resources: input.resources,
        sessionID: input.sessionID,
        ...(input.save === undefined ? {} : { save: input.save }),
      });
      if (input.action === "external_directory" && options.denyExternal) {
        throw new Error("EXTERNAL_DENIED");
      }
      if (options.denyPermission) throw new Error("PERMISSION_DENIED");
      if (guardOptions?.signal?.aborted) throw new Error("PERMISSION_ABORTED");
      return effect();
    },
  };
  const registration = createHashlineEditHandlers({
    settingsFor: async () => resolvedSettings,
    locationFor: async (sessionID) => options.locations?.[sessionID] ?? options.baseDir ?? "/",
    projectRootFor: async (sessionID) =>
      options.projectRoots?.[sessionID] ?? options.projectRoot ?? options.baseDir ?? "/",
    hostHome: () => options.home ?? "/home/test",
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
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: directory });
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
        {
          action: "edit",
          resources: [relative(directory, filePath)],
          sessionID: "session-1",
          save: ["*"],
        },
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
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: directory });
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
      expect(permissionCalls[0]?.resources).toEqual([
        relative(directory, filePath),
        relative(directory, renamedPath),
      ]);
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
    expect(Object.keys(deepseek).sort()).toEqual(["str_replace_editor", "write"]);

    const minimax = allTools();
    recordModel(handlers, "s2", "minimax-m2");
    await handlers.sessionContext({ sessionID: "s2", tools: minimax });
    expect(Object.keys(minimax).sort()).toEqual(["hashline_edit", "write"]);

    const kimi = allTools();
    recordModel(handlers, "s3", "kimi-k3");
    await handlers.sessionContext({ sessionID: "s3", tools: kimi });
    expect(Object.keys(kimi).sort()).toEqual(["edit", "write"]);

    // The host gpt apply_patch gate already removed native write for this model.
    const gpt = allTools();
    delete gpt.write;
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
    // The host gpt gate deleted edit/write; hashline mode restores native write
    // for new-file creation but hides patch.
    const gpt: Record<string, unknown> = {
      hashline_edit: { description: "owned-hashline", input: {} },
      patch: { description: "native-patch", input: { type: "object" } },
      edit: { description: "native-edit", input: { type: "object" } },
    };
    recordModel(handlers, "s1", "gpt-5.4");
    await handlers.sessionContext({ sessionID: "s1", tools: gpt });
    expect(Object.keys(gpt).sort()).toEqual(["hashline_edit", "write"]);
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
    expect(tools).toEqual({
      patch: { description: "native-patch", input: { type: "object" } },
      write: { description: "native-write", input: { type: "object" } },
    });
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
    expect(Object.keys(first).sort()).toEqual(["hashline_edit", "write"]);

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

  test("native write stays available for creation and execute.before denies edit/patch in hashline mode", async () => {
    const { handlers } = createHarness({
      enabled: true,
      routing: { default: "hashline_edit", rules: [{ pattern: "gpt", mode: "hashline_edit" }] },
    });
    await seedDefinitions(handlers);
    // GPT gate removed write; hashline mode restores it and hides patch/edit.
    const tools: Record<string, unknown> = {
      hashline_edit: { description: "owned-hashline", input: {} },
      patch: { description: "native-patch", input: { type: "object" } },
      edit: { description: "native-edit", input: { type: "object" } },
    };
    recordModel(handlers, "session-1", "gpt-5.4");
    await handlers.sessionContext({ sessionID: "session-1", tools });
    expect(Object.keys(tools).sort()).toEqual(["hashline_edit", "write"]);
    await expect(
      handlers.before({
        tool: "write",
        sessionID: "session-1",
        input: { path: "x", content: "y" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      handlers.before({ tool: "edit", sessionID: "session-1", input: { path: "x" } }),
    ).rejects.toThrow(/different edit tool/);
    await expect(
      handlers.before({ tool: "patch", sessionID: "session-1", input: { patchText: "x" } }),
    ).rejects.toThrow(/different edit tool/);
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
    expect(Object.keys(tools).sort()).toEqual(["hashline_edit", "write"]);
  });
});

describe("HashlineEditPlugin dsh str_replace_editor", () => {
  test("executes view and str_replace with permission before the write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-dsh-"));
    try {
      const filePath = join(directory, "sample.py");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: directory });
      recordModel(handlers, "session-1", "deepseek-v4-flash");
      const { context, metadataCalls } = createToolContext();

      const viewed = await handlers.tools.str_replace_editor.execute(
        { command: "view", path: filePath },
        context,
      );
      expect(viewed.output).toContain("Here's the content of");
      // Internal reads are still permission-gated (location authority is not permission).
      expect(permissionCalls).toEqual([
        {
          action: "read",
          resources: [relative(directory, filePath)],
          sessionID: "session-1",
          save: ["*"],
        },
      ]);

      const replaced = await handlers.tools.str_replace_editor.execute(
        { command: "str_replace", path: filePath, old_str: "beta", new_str: "BETA" },
        context,
      );
      expect(replaced.output).toBe(`The file ${filePath} has been edited successfully.`);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\n");
      expect(permissionCalls).toEqual([
        {
          action: "read",
          resources: [relative(directory, filePath)],
          sessionID: "session-1",
          save: ["*"],
        },
        {
          action: "edit",
          resources: [relative(directory, filePath)],
          sessionID: "session-1",
          save: ["*"],
        },
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
    expect(Object.keys(tools).sort()).toEqual(["hashline_edit", "write"]);
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
    expect(Object.keys(tools).sort()).toEqual(["patch", "write"]);
    expect((tools.patch as { description: string }).description).toBe("Native patch");
  });
});

describe("HashlineEditPlugin native read content", () => {
  test("anchors normalized native text content arrays and preserves file and metadata parts", async () => {
    const { handlers } = createHarness();
    recordModel(handlers, "session-1", "minimax-m2");
    const result: {
      content: Array<Record<string, unknown>>;
      metadata: Record<string, unknown>;
    } = {
      content: [
        { type: "text", text: "1: const first = 1;\n2: const second = 2;" },
        { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png", name: "shot.png" },
      ],
      metadata: { truncated: false },
    };
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
    expect(result.content[0]!.text).toBe(
      `1#${lh1}#${ah1}|const first = 1;\n2#${lh2}#${ah2}|const second = 2;`,
    );
    expect(result.content[1]).toEqual({
      type: "file",
      uri: "data:image/png;base64,AA==",
      mime: "image/png",
      name: "shot.png",
    });
    expect(result.metadata).toEqual({ truncated: false });
  });

  test("uses the full-file snapshot for a partial native array read and stale rows hash-mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-native-partial-"));
    try {
      const filePath = join(directory, "race.txt");
      await writeFile(filePath, "line1\nline2 changed\nline3", "utf8");
      const { handlers } = createHarness(undefined, { baseDir: directory });
      recordModel(handlers, "session-1", "minimax-m2");
      const result: { content: Array<{ type: string; text: string }> } = {
        content: [{ type: "text", text: "2: line2\n3: line3" }],
      };
      await handlers.after({
        tool: "read",
        sessionID: "session-1",
        input: { path: filePath },
        status: "completed",
        result,
      });
      const fallback = `2#${computeLineHash(2, "line2")}#${computeAnchorHash(2, undefined, "line2", "line3")}`;
      const laterSnapshot = `2#${computeLineHash(2, "line2 changed")}#${computeAnchorHash(2, "line1", "line2 changed", "line3")}`;
      expect(result.content[0]!.text).toContain(`${fallback}|line2`);
      expect(result.content[0]!.text).not.toContain(laterSnapshot);

      const edit = await handlers.tools.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: fallback, lines: ["line2 updated"] }] },
        createToolContext().context,
      );
      expect(edit.output).toContain("Error: hash mismatch");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2 changed\nline3");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("HashlineEditPlugin location boundary", () => {
  function contextFor(sessionID: string): ToolContext {
    return createToolContext({ sessionID }).context;
  }

  test("relative paths resolve against each session location, not the daemon cwd", async () => {
    const locationA = await mkdtemp(join(tmpdir(), "vvoc-loc-a-"));
    const locationB = await mkdtemp(join(tmpdir(), "vvoc-loc-b-"));
    try {
      await writeFile(join(locationA, "same.txt"), "alpha", "utf8");
      await writeFile(join(locationB, "same.txt"), "beta", "utf8");
      const { handlers } = createHarness(undefined, {
        locations: { sA: locationA, sB: locationB },
      });
      recordModel(handlers, "sA", "minimax-m2");
      recordModel(handlers, "sB", "minimax-m2");

      const editA = await handlers.tools.hashline_edit.execute(
        { filePath: "same.txt", edits: [{ op: "append", lines: ["A"] }] },
        contextFor("sA"),
      );
      expect(editA.output).toContain(`Updated ${join(locationA, "same.txt")}`);
      expect(await readFile(join(locationA, "same.txt"), "utf8")).toBe("alpha\nA");
      expect(await readFile(join(locationB, "same.txt"), "utf8")).toBe("beta");

      await handlers.tools.hashline_edit.execute(
        { filePath: "same.txt", edits: [{ op: "append", lines: ["B"] }] },
        contextFor("sB"),
      );
      expect(await readFile(join(locationB, "same.txt"), "utf8")).toBe("beta\nB");
      expect(await readFile(join(locationA, "same.txt"), "utf8")).toBe("alpha\nA");
    } finally {
      await rm(locationA, { recursive: true, force: true });
      await rm(locationB, { recursive: true, force: true });
    }
  });

  test("relative and absolute aliases share one freshness identity", async () => {
    const location = await mkdtemp(join(tmpdir(), "vvoc-loc-alias-"));
    try {
      const filePath = join(location, "alias.txt");
      await writeFile(filePath, "alpha\n", "utf8");
      const { handlers } = createHarness(undefined, {
        baseDir: location,
        locations: { s1: location },
      });
      recordModel(handlers, "s1", "deepseek-v4-flash");

      const viewed = await handlers.tools.str_replace_editor.execute(
        { command: "view", path: "alias.txt" },
        contextFor("s1"),
      );
      expect(viewed.output).toContain("Here's the content of");

      // External mutation drifts the snapshot recorded under the relative alias.
      await writeFile(filePath, "alpha\nextra\n", "utf8");
      const replaced = await handlers.tools.str_replace_editor.execute(
        { command: "str_replace", path: filePath, old_str: "alpha", new_str: "ALPHA" },
        contextFor("s1"),
      );
      expect(replaced.output).toContain("changed since it was last viewed");
      expect(await readFile(filePath, "utf8")).toBe("alpha\nextra\n");
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  });

  test("expands a leading ~ against the trusted host home", async () => {
    const home = await mkdtemp(join(tmpdir(), "vvoc-loc-home-"));
    try {
      const target = join(home, "tilde.txt");
      await writeFile(target, "home\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: home, home });
      recordModel(handlers, "s1", "minimax-m2");
      const result = await handlers.tools.hashline_edit.execute(
        { filePath: "~/tilde.txt", edits: [{ op: "append", lines: ["x"] }] },
        contextFor("s1"),
      );
      expect(result.output).toContain(`Updated ${target}`);
      expect(await readFile(target, "utf8")).toBe("home\nx\n");
      expect(permissionCalls.map((call) => call.action)).toEqual(["edit"]);
      expect(permissionCalls[0]?.resources).toEqual(["tilde.txt"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("treats the trusted project/worktree root as internal scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "vvoc-loc-root-"));
    try {
      const location = join(root, "pkg");
      const other = join(root, "other");
      await mkdir(location, { recursive: true });
      await mkdir(other, { recursive: true });
      const target = join(other, "f.txt");
      await writeFile(target, "a\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, {
        baseDir: location,
        projectRoot: root,
      });
      recordModel(handlers, "s1", "minimax-m2");
      const result = await handlers.tools.hashline_edit.execute(
        { filePath: "../other/f.txt", edits: [{ op: "append", lines: ["b"] }] },
        contextFor("s1"),
      );
      expect(result.output).toContain(`Updated ${target}`);
      expect(await readFile(target, "utf8")).toBe("a\nb\n");
      // Internal to the project root: no external_directory boundary.
      expect(permissionCalls.map((call) => call.action)).toEqual(["edit"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("external read requests external_directory then read before content access", async () => {
    const inside = await mkdtemp(join(tmpdir(), "vvoc-loc-inside-r-"));
    const outside = await mkdtemp(join(tmpdir(), "vvoc-loc-outside-r-"));
    try {
      const target = join(outside, "page.txt");
      await writeFile(target, "page\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: inside });
      recordModel(handlers, "s1", "deepseek-v4-flash");
      const viewed = await handlers.tools.str_replace_editor.execute(
        { command: "view", path: target },
        contextFor("s1"),
      );
      expect(viewed.output).toContain("Here's the content of");
      expect(permissionCalls.map((call) => call.action)).toEqual(["external_directory", "read"]);
      expect(permissionCalls[0]?.resources).toEqual([`${outside}/*`]);
      expect(permissionCalls[1]?.resources).toEqual([target]);
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("external edit requests external_directory then edit before mutation", async () => {
    const inside = await mkdtemp(join(tmpdir(), "vvoc-loc-inside-e-"));
    const outside = await mkdtemp(join(tmpdir(), "vvoc-loc-outside-e-"));
    try {
      const target = join(outside, "edit.txt");
      await writeFile(target, "edit\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: inside });
      recordModel(handlers, "s1", "minimax-m2");
      await handlers.tools.hashline_edit.execute(
        { filePath: target, edits: [{ op: "append", lines: ["x"] }] },
        contextFor("s1"),
      );
      expect(await readFile(target, "utf8")).toBe("edit\nx\n");
      expect(permissionCalls.map((call) => call.action)).toEqual(["external_directory", "edit"]);
      expect(permissionCalls[1]?.resources).toEqual([target]);
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a failed native read cannot bless the freshness cache", async () => {
    const location = await mkdtemp(join(tmpdir(), "vvoc-loc-failed-read-"));
    try {
      const filePath = join(location, "doc.txt");
      await writeFile(filePath, "one\n", "utf8");
      const { handlers } = createHarness(undefined, {
        baseDir: location,
        locations: { s1: location },
      });
      recordModel(handlers, "s1", "deepseek-v4-flash");

      // A genuine successful normalized native read records the snapshot.
      await handlers.after({
        tool: "read",
        sessionID: "s1",
        input: { path: "doc.txt" },
        status: "completed",
        result: { content: [{ type: "text", text: "Read file doc.txt, lines 1-1\n1: one" }] },
      });

      // External mutation drifts the recorded snapshot.
      await writeFile(filePath, "one\ntwo\n", "utf8");

      // A denied/failed native read must not establish a new freshness snapshot.
      await handlers.after({
        tool: "read",
        sessionID: "s1",
        input: { path: "doc.txt" },
        status: "error",
        error: { message: "denied" },
      });

      const replaced = await handlers.tools.str_replace_editor.execute(
        { command: "str_replace", path: "doc.txt", old_str: "one", new_str: "ONE" },
        contextFor("s1"),
      );
      expect(replaced.output).toContain("changed since it was last viewed");
      expect(await readFile(filePath, "utf8")).toBe("one\ntwo\n");
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  });

  test("external boundary save uses the outside project root, not the caller worktree", async () => {
    const inside = await mkdtemp(join(tmpdir(), "vvoc-loc-inside-root-"));
    const outside = await mkdtemp(join(tmpdir(), "vvoc-loc-outside-root-"));
    try {
      await mkdir(join(outside, ".git"), { recursive: true });
      const outsideDir = join(outside, "mod");
      await mkdir(outsideDir, { recursive: true });
      const target = join(outsideDir, "file.txt");
      await writeFile(target, "x\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: inside });
      recordModel(handlers, "s1", "minimax-m2");
      await handlers.tools.hashline_edit.execute(
        { filePath: target, edits: [{ op: "append", lines: ["y"] }] },
        contextFor("s1"),
      );
      expect(permissionCalls[0]?.action).toBe("external_directory");
      expect(permissionCalls[0]?.resources).toEqual([`${outsideDir}/*`]);
      expect(permissionCalls[0]?.save).toEqual([`${outside}/*`]);
      expect(permissionCalls[0]?.save).not.toEqual([`${inside}/*`]);
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("external directory view requests that directory boundary, not its parent", async () => {
    const inside = await mkdtemp(join(tmpdir(), "vvoc-loc-inside-dir-"));
    const outside = await mkdtemp(join(tmpdir(), "vvoc-loc-outside-dir-"));
    try {
      const listing = join(outside, "listing");
      await mkdir(listing, { recursive: true });
      await writeFile(join(listing, "a.txt"), "a\n", "utf8");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: inside });
      recordModel(handlers, "s1", "deepseek-v4-flash");
      const viewed = await handlers.tools.str_replace_editor.execute(
        { command: "view", path: listing },
        contextFor("s1"),
      );
      expect(viewed.output).toContain(listing);
      expect(permissionCalls[0]?.action).toBe("external_directory");
      expect(permissionCalls[0]?.resources).toEqual([`${listing}/*`]);
      expect(permissionCalls[0]?.resources).not.toEqual([`${outside}/*`]);
      expect(permissionCalls[1]?.action).toBe("read");
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("external create for a missing parent uses the file parent boundary and de-duplicates", async () => {
    const inside = await mkdtemp(join(tmpdir(), "vvoc-loc-inside-create-"));
    const outside = await mkdtemp(join(tmpdir(), "vvoc-loc-outside-create-"));
    try {
      const newDir = join(outside, "new");
      const target = join(newDir, "missing.txt");
      const { handlers, permissionCalls } = createHarness(undefined, { baseDir: inside });
      recordModel(handlers, "s1", "minimax-m2");
      await handlers.tools.hashline_edit.execute(
        { filePath: target, edits: [{ op: "append", lines: ["created"] }] },
        contextFor("s1"),
      );
      const boundaries = permissionCalls.filter((call) => call.action === "external_directory");
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]?.resources).toEqual([`${newDir}/*`]);
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("external_directory denial leaves no read/write/rename effect", async () => {
    const inside = await mkdtemp(join(tmpdir(), "vvoc-loc-inside-"));
    const outside = await mkdtemp(join(tmpdir(), "vvoc-loc-outside-"));
    try {
      const target = join(outside, "secret.txt");
      await writeFile(target, "secret\n", "utf8");

      const editor = createHarness(undefined, { baseDir: inside, denyExternal: true });
      recordModel(editor.handlers, "s1", "minimax-m2");
      await expect(
        editor.handlers.tools.hashline_edit.execute(
          { filePath: target, edits: [{ op: "append", lines: ["x"] }] },
          contextFor("s1"),
        ),
      ).rejects.toThrow("EXTERNAL_DENIED");
      expect(await readFile(target, "utf8")).toBe("secret\n");
      expect(editor.permissionCalls[0]?.action).toBe("external_directory");
      expect(editor.permissionCalls[0]?.resources).toEqual([`${outside}/*`]);

      const renamer = createHarness(undefined, { baseDir: inside, denyExternal: true });
      recordModel(renamer.handlers, "s1", "minimax-m2");
      await writeFile(join(inside, "source.txt"), "source\n", "utf8");
      await expect(
        renamer.handlers.tools.hashline_edit.execute(
          {
            filePath: join(inside, "source.txt"),
            rename: join(outside, "moved.txt"),
            edits: [{ op: "append", lines: ["x"] }],
          },
          contextFor("s1"),
        ),
      ).rejects.toThrow("EXTERNAL_DENIED");
      expect(await readFile(join(inside, "source.txt"), "utf8")).toBe("source\n");
      await expect(readFile(join(outside, "moved.txt"), "utf8")).rejects.toThrow();

      const viewer = createHarness(undefined, { baseDir: inside, denyExternal: true });
      recordModel(viewer.handlers, "s1", "deepseek-v4-flash");
      await expect(
        viewer.handlers.tools.str_replace_editor.execute(
          { command: "view", path: target },
          contextFor("s1"),
        ),
      ).rejects.toThrow("EXTERNAL_DENIED");
      expect(viewer.permissionCalls.some((call) => call.action === "read")).toBe(false);
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
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

// START_BLOCK_REAL_HOST_SMOKE
/**
 * Optional isolated real-host smoke. Runs only when `VVOC_E2E_V2_HOST` points at
 * the pinned OpenCode 2.0.18 binary. It composes the actual built
 * ModelRolesPlugin.setup(ctx) and HashlineEditPlugin.setup(ctx) on ONE native
 * Context, drives genuine native write -> read -> hashline_edit through a
 * scripted loopback model, and asserts the provider observed anchored native
 * read content, the intended location changed, a same-relative-name second
 * location did not cross-write, and denied external access left no effects.
 */
const REAL_HOST = process.env.VVOC_E2E_V2_HOST;
const realHostDescribe = REAL_HOST ? describe : describe.skip;

interface HostHelpers {
  createOwnedScratch(base: string): Promise<{ dir: string; base: string; markerPath: string }>;
  removeOwnedScratch(scratch: { dir: string; base: string; markerPath: string }): Promise<void>;
  buildHostEnv(
    base: Record<string, string>,
    extra?: Record<string, string | undefined>,
  ): Record<string, string>;
  OwnedProcesses: new () => {
    spawn(
      command: string,
      args: readonly string[],
      options?: { readonly cwd?: string; readonly env?: Record<string, string> },
    ): { readonly pid?: number };
    stopAll(): Promise<void>;
  };
  waitForRegisteredService(input: { servicePath: string; timeoutMs?: number }): Promise<string>;
  createNativeApi(input: {
    baseUrl: string;
    password: string;
    directory: string;
  }): (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: unknown; text: string }>;
  assertLoopbackHttpUrl(raw: string, label?: string): URL;
}

realHostDescribe("real OpenCode 2.0.18 hashline host smoke (built model-roles + hashline)", () => {
  test("native write -> read -> hashline_edit across two isolated locations with denied external access", async () => {
    const helpers = (await import(
      new URL("../../scripts/e2e-v2/host.ts", import.meta.url).href
    )) as unknown as HostHelpers;
    const core = (await import(new URL("../../scripts/e2e-v2/core.ts", import.meta.url).href)) as {
      getFreePort(): Promise<number>;
    };
    const scratch = await helpers.createOwnedScratch(
      process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode",
    );
    const processes = new helpers.OwnedProcesses();
    const tracePath = join(scratch.dir, "provider.jsonl");
    const outsideDir = join(scratch.dir, "outside");
    const daemonCwd = join(scratch.dir, "daemon-cwd");
    const locationA = join(scratch.dir, "location-a");
    const locationB = join(scratch.dir, "location-b");
    const externalTarget = join(outsideDir, "secret.txt");
    const providerPort = await core.getFreePort();
    const hostPort = await core.getFreePort();
    helpers.assertLoopbackHttpUrl(`http://127.0.0.1:${providerPort}`, "provider");
    const externalAnchor = `2#${computeLineHash(2, "beta")}#${computeAnchorHash(2, "alpha", "beta", "")}`;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: providerPort,
      async fetch(request) {
        const url = new URL(request.url);
        const body = (await request
          .clone()
          .json()
          .catch(() => ({}))) as {
          model?: string;
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        appendFileSync(tracePath, `${JSON.stringify({ path: url.pathname, body })}\n`, "utf8");
        if (url.pathname.endsWith("/models")) {
          return Response.json({
            object: "list",
            data: [
              {
                id: "seam-smart",
                object: "model",
                created: 1,
                owned_by: "loopback",
                name: "Seam Smart",
                context_window: 128000,
                max_output_tokens: 8192,
              },
            ],
          });
        }
        if (!url.pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        const messages = body.messages ?? [];
        const model = body.model;
        const text = (value: unknown) =>
          typeof value === "string" ? value : JSON.stringify(value ?? "");
        if (
          messages.some((message) =>
            text(message.content).includes("Generate a short, specific title"),
          )
        ) {
          return sseText(model, "Title");
        }
        const toolMessages = messages.filter((message) => message.role === "tool");
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        const external = text(lastUser?.content).includes("EXTERNAL");
        const target = external ? externalTarget : "notes.txt";
        const step = toolMessages.length;
        if (step === 0) {
          return sseTool(model, "write", { path: target, content: "alpha\nbeta\n" });
        }
        if (step === 1) {
          return sseTool(model, "read", { path: target });
        }
        if (step === 2) {
          const readText = text(toolMessages[toolMessages.length - 1]?.content);
          const anchor = external
            ? externalAnchor
            : (readText.match(/\d+#[^#\s|]+#[^#\s|]+/g) ?? []).find((candidate) =>
                candidate.startsWith("2#"),
              );
          if (anchor === undefined) return sseText(model, "no-anchor");
          return sseTool(model, "hashline_edit", {
            filePath: target,
            edits: [{ op: "replace", pos: anchor, lines: ["beta-updated"] }],
          });
        }
        return sseText(model, "done");
      },
    });

    const sseChunk = (
      model: string | undefined,
      delta: Record<string, unknown>,
      finish: string | null,
    ) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const sseUsage = (model: string | undefined) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;
    const sseText = (model: string | undefined, content: string) =>
      new Response(
        `${sseChunk(model, { role: "assistant" }, null)}${sseChunk(model, { content }, null)}${sseChunk(model, {}, "stop")}${sseUsage(model)}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    const sseTool = (model: string | undefined, name: string, args: unknown) =>
      new Response(
        `${sseChunk(model, { role: "assistant" }, null)}${sseChunk(model, { tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null)}${sseChunk(model, {}, "tool_calls")}${sseUsage(model)}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );

    try {
      await mkdir(outsideDir, { recursive: true });
      await mkdir(daemonCwd, { recursive: true });
      for (const dir of ["home", "cfg", "data", "state", "cache"]) {
        await mkdir(join(scratch.dir, dir), { recursive: true });
      }
      await writeFile(externalTarget, "alpha\nbeta\n", "utf8");
      const distRoot = join(import.meta.dir, "..", "..", "dist", "plugins");
      const compositeDir = join(scratch.dir, "composite");
      await mkdir(compositeDir, { recursive: true });
      // The built plugin imports the pinned native SDK packages directly (T009
      // will declare them); the scratch package resolves them from the workspace.
      symlinkSync(
        join(import.meta.dir, "..", "..", "node_modules"),
        join(compositeDir, "node_modules"),
        "dir",
      );
      await writeFile(
        join(compositeDir, "package.json"),
        JSON.stringify({ name: "vvoc-t005-hashline-composite", private: true, version: "0.0.0" }),
        "utf8",
      );
      await writeFile(
        join(compositeDir, "index.ts"),
        `import modelRoles from "${join(distRoot, "model-roles", "index.js")}";\n` +
          `import hashline from "${join(distRoot, "hashline-edit", "index.js")}";\n` +
          `export default { id: "vvoc.t005.hashline-composite", async setup(ctx) {\n` +
          `  const cleanups = [];\n` +
          `  const roles = await modelRoles.setup(ctx);\n` +
          `  if (roles) cleanups.push(roles);\n` +
          `  const edits = await hashline.setup(ctx);\n` +
          `  if (edits) cleanups.push(edits);\n` +
          `  return async () => { for (const cleanup of cleanups.reverse()) await cleanup(); };\n` +
          `} };\n`,
        "utf8",
      );
      for (const location of [locationA, locationB]) {
        await mkdir(join(location, ".vvoc"), { recursive: true });
        await writeFile(
          join(location, "opencode.json"),
          JSON.stringify({
            model: "loopback/seam-smart",
            providers: {
              loopback: {
                name: "Smoke Loopback",
                package: "@opencode/ai/providers/openai-compatible",
                env: ["LOOPBACK_API_KEY"],
                settings: {
                  baseURL: `http://127.0.0.1:${providerPort}/v1`,
                  provider: "loopback",
                },
                models: { "seam-smart": { name: "Seam Smart" } },
              },
            },
            plugins: [{ package: compositeDir }],
          }),
          "utf8",
        );
        const vvoc = createDefaultVvocConfig();
        vvoc.roles = {
          ...vvoc.roles,
          default: "loopback/seam-smart",
          smart: "loopback/seam-smart",
          fast: "loopback/seam-smart",
          reviewer: "loopback/seam-smart",
        };
        await writeFile(join(location, ".vvoc", "vvoc.json"), renderVvocConfig(vvoc), "utf8");
      }

      const env = helpers.buildHostEnv(
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: join(scratch.dir, "home"),
          XDG_CONFIG_HOME: join(scratch.dir, "cfg"),
          XDG_DATA_HOME: join(scratch.dir, "data"),
          XDG_STATE_HOME: join(scratch.dir, "state"),
          XDG_CACHE_HOME: join(scratch.dir, "cache"),
          LOOPBACK_API_KEY: "smoke-key",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
        },
        { HOME: join(scratch.dir, "home") },
      );
      processes.spawn(
        REAL_HOST as string,
        [
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(hostPort),
          "--log-level",
          "error",
        ],
        { cwd: daemonCwd, env },
      );
      const password = await helpers.waitForRegisteredService({
        servicePath: join(scratch.dir, "state", "opencode", "service.json"),
      });
      const baseUrl = `http://127.0.0.1:${hostPort}`;
      const apiFor = (directory: string) =>
        helpers.createNativeApi({ baseUrl, password, directory });

      // Wait for the real native model registry to expose the loopback model.
      const apiA = apiFor(locationA);
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const models = await apiA("/api/model");
        if (models.status === 200 && models.text.includes("seam-smart")) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(ready, "native model registry did not expose the loopback model").toBe(true);

      const runSession = async (
        directory: string,
        textPrompt: string,
        permissions?: ReadonlyArray<{ action: string; resource: string; effect: string }>,
      ): Promise<{ outcome: string | undefined; entries: Array<Record<string, unknown>> }> => {
        const api = apiFor(directory);
        const created = (await api("/api/session", {
          method: "POST",
          body: JSON.stringify({
            location: { directory },
            ...(permissions === undefined ? {} : { permissions }),
          }),
        })) as { status: number; body?: { data?: { id?: string } } };
        const sessionID = created.body?.data?.id;
        expect(sessionID).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const prompted = await api(`/api/session/${sessionID}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: textPrompt }),
        });
        expect(prompted.status).toBeLessThan(400);
        const deadline = Date.now() + 30000;
        for (;;) {
          const context = (await api(`/api/session/${sessionID}/context`)) as {
            body?: { data?: Array<Record<string, unknown>> };
          };
          const entries = context.body?.data ?? [];
          if (entries.some((entry) => entry.type === "idle")) {
            return {
              outcome: entries.find((entry) => entry.type === "idle")?.outcome as
                | string
                | undefined,
              entries,
            };
          }
          if (Date.now() > deadline) return { outcome: "timeout", entries };
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      };

      const first = await runSession(locationA, "create and update notes");
      expect(first.outcome).toBe("succeeded");
      expect(await readFile(join(locationA, "notes.txt"), "utf8")).toBe("alpha\nbeta-updated\n");
      // Location B was not touched by location A's turn.
      await expect(readFile(join(locationB, "notes.txt"), "utf8")).rejects.toThrow();

      const second = await runSession(locationB, "create and update notes");
      expect(second.outcome).toBe("succeeded");
      expect(await readFile(join(locationB, "notes.txt"), "utf8")).toBe("alpha\nbeta-updated\n");
      expect(await readFile(join(locationA, "notes.txt"), "utf8")).toBe("alpha\nbeta-updated\n");

      const trace = await readFile(tracePath, "utf8");
      // The provider saw actual native normalized read content with usable anchors.
      expect(trace).toContain("notes.txt");
      expect(/\d+#[^#\s|]+#[^#\s|]+\|/.test(trace)).toBe(true);

      // Denied external_directory: native write/read/hashline_edit effect nothing.
      const denied = await runSession(locationA, "EXTERNAL deny probe", [
        { action: "external_directory", resource: "*", effect: "deny" },
      ]);
      expect(denied.outcome).toBe("succeeded");
      expect(await readFile(externalTarget, "utf8")).toBe("alpha\nbeta\n");
    } finally {
      await processes.stopAll();
      server.stop(true);
      await helpers.removeOwnedScratch(scratch);
    }
  }, 240_000);
});
// END_BLOCK_REAL_HOST_SMOKE
