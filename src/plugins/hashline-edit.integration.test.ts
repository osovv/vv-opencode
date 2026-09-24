// FILE: src/plugins/hashline-edit.integration.test.ts
// VERSION: 0.9.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline read-output enhancement and the default-on hash-anchored edit override behavior, including the owned contract hooks and direct-entry validation.
//   SCOPE: Plugin registration, contract publication and hook validation, wrapped and plain read hashing, ranged edits, rename/delete flows, missing-file edits, stale-anchor rejection, partial-read anchors, literal payload application, blank/embedded-newline payload rejection, EOF append behavior, normalization heuristics, post-edit diff feedback, BOM/CRLF preservation, and truthful applied reporting when metadata publication fails.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/index.ts, src/plugins/hashline-edit/schemas.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   previousConfigHome - Preserves the caller's config-home environment for cleanup.
//   METADATA_FAILURE_SECRET - Sentinel secret that must never leak through a metadata failure.
//   METADATA_FAILURE_MESSAGE - Oversized metadata failure message embedding the sentinel secret.
//   createPluginInput - Builds an isolated OpenCode plugin input fixture.
//   createToolContext - Builds a tool execution context fixture (optionally with a throwing metadata sink).
//   anchorFor - Builds a visible hashline anchor for fixture content.
//   userMessage - Builds an SDK-shaped user message fixture carrying a provider/model pair.
//   writeProjectVvocConfig - Seeds a project .vvoc/vvoc.json overriding the hashline-edit plugin entry.
//   hook_call - Invokes the chat.message hook with a session model fixture.
//   establishModel - Registers a real session model so direct execute passes the visibility gate.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Added contract publication/hook-validation coverage, direct-entry structural rejection without side effects, path-equivalent rename, the metadata fault-injection applied-truth check, and updated the before-hook fixture for the allowed-tool validation step.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInsertAfter,
  applyInsertBefore,
  applyReplaceLines,
} from "./hashline-edit/edit-operation-primitives.js";
import { computeAnchorHash, computeLineHash } from "./hashline-edit/hash-computation.js";
import { HashlineEditPlugin } from "./hashline-edit/index.js";
import {
  hashlineEditMetadataSchema,
  strReplaceEditorMetadataSchema,
} from "./hashline-edit/schemas.js";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
// A deliberately huge, secret-bearing thrown message: reporting-failure warnings
// must stay bounded and must never echo the thrown payload.
const METADATA_FAILURE_SECRET = "SECRET_TOKEN_must_not_leak";
const METADATA_FAILURE_MESSAGE = `${METADATA_FAILURE_SECRET} ${"x".repeat(4096)}`;

beforeEach(() => {
  resetVvocConfigForTests();
  process.env.XDG_CONFIG_HOME = join(tmpdir(), `vvoc-hashline-empty-config-${process.pid}`);
});

afterEach(() => {
  resetVvocConfigForTests();
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});

function createPluginInput(directory: string) {
  return {
    client: {} as never,
    project: {} as never,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  };
}

function createToolContext(
  directory: string,
  options: { metadataThrows?: boolean; sessionID?: string } = {},
) {
  const metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }> = [];
  return {
    context: {
      sessionID: options.sessionID ?? "session-1",
      messageID: "message-1",
      agent: "build",
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      metadata(input: { title?: string; metadata?: Record<string, unknown> }) {
        if (options.metadataThrows) {
          throw new Error(METADATA_FAILURE_MESSAGE);
        }
        metadataCalls.push(input);
      },
      ask: async () => {},
    },
    metadataCalls,
  };
}

function anchorFor(lines: string[], line: number): string {
  const content = lines[line - 1] ?? "";
  const hash = computeLineHash(line, content);
  const anchor = computeAnchorHash(line, lines[line - 2], content, lines[line]);
  return `${line}#${hash}#${anchor}`;
}

describe("HashlineEditPlugin", () => {
  test("registers the edit override and hashes read output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-"));

    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      expect(plugin.tool?.hashline_edit).toBeDefined();

      const output = {
        title: directory,
        output: "1: const first = 1;\n2: const second = 2;",
        metadata: {},
      };

      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1", args: {} } as never,
        output as never,
      );

      const lh1 = computeLineHash(1, "const first = 1;");
      const lh2 = computeLineHash(2, "const second = 2;");
      const ah1 = computeAnchorHash(1, undefined, "const first = 1;", "const second = 2;");
      const ah2 = computeAnchorHash(2, "const first = 1;", "const second = 2;", undefined);
      expect(output.output).toBe(
        `1#${lh1}#${ah1}|const first = 1;\n2#${lh2}#${ah2}|const second = 2;`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("hashes wrapped <content> read output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-wrapped-"));

    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const output = {
        title: directory,
        output: "<content>1: const first = 1;\n2: const second = 2;\n</content>",
        metadata: {},
      };

      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1", args: {} } as never,
        output as never,
      );

      const lh1 = computeLineHash(1, "const first = 1;");
      const lh2 = computeLineHash(2, "const second = 2;");
      const ah1 = computeAnchorHash(1, undefined, "const first = 1;", "const second = 2;");
      const ah2 = computeAnchorHash(2, "const first = 1;", "const second = 2;", undefined);
      expect(output.output).toBe(
        `<content>\n1#${lh1}#${ah1}|const first = 1;\n2#${lh2}#${ah2}|const second = 2;\n</content>`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses the full file snapshot for partial read context anchors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-partial-"));

    try {
      const filePath = join(directory, "partial.txt");
      await writeFile(filePath, "line1\nline2\nline3", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const output = {
        title: filePath,
        output: "2: line2\n3: line3",
        metadata: {},
      };

      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1", args: { filePath } } as never,
        output as never,
      );

      const anchor = `2#${computeLineHash(2, "line2")}#${computeAnchorHash(2, "line1", "line2", "line3")}`;
      expect(output.output).toContain(`${anchor}|line2`);

      const { context } = createToolContext(directory);
      const result = await plugin.tool!.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: anchor, lines: ["line2 updated"] }] },
        context as never,
      );
      expect(result).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2 updated\nline3");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses full neighbor text when hashing lines around truncated read output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-truncated-"));

    try {
      const filePath = join(directory, "truncated.txt");
      const longLine = "x".repeat(2100);
      const truncatedLine = `${longLine.slice(0, 2000)}... (line truncated to 2000 chars)`;
      await writeFile(filePath, `short\n${longLine}\nafter`, "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const output = {
        title: filePath,
        output: `1: short\n2: ${truncatedLine}\n3: after`,
        metadata: {},
      };

      await plugin["tool.execute.after"]?.(
        {
          tool: "read",
          sessionID: "session-1",
          callID: "call-1",
          args: { path: filePath },
        } as never,
        output as never,
      );

      const firstAnchor = `1#${computeLineHash(1, "short")}#${computeAnchorHash(1, undefined, "short", longLine)}`;
      const thirdAnchor = `3#${computeLineHash(3, "after")}#${computeAnchorHash(3, longLine, "after", undefined)}`;
      expect(output.output).toContain(`${firstAnchor}|short`);
      expect(output.output).toContain(`2: ${truncatedLine}`);
      expect(output.output).toContain(`${thirdAnchor}|after`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not pair stale visible read rows with a later file snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-race-"));

    try {
      const filePath = join(directory, "race.txt");
      await writeFile(filePath, "line1\nline2 changed\nline3", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const output = {
        title: filePath,
        output: "2: line2\n3: line3",
        metadata: {},
      };

      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1", args: { filePath } } as never,
        output as never,
      );

      const fallbackAnchor = `2#${computeLineHash(2, "line2")}#${computeAnchorHash(2, undefined, "line2", "line3")}`;
      const laterSnapshotAnchor = `2#${computeLineHash(2, "line2 changed")}#${computeAnchorHash(2, "line1", "line2 changed", "line3")}`;
      expect(output.output).toContain(`${fallbackAnchor}|line2`);
      expect(output.output).not.toContain(laterSnapshotAnchor);

      const { context } = createToolContext(directory);
      const result = await plugin.tool!.hashline_edit.execute(
        { filePath, edits: [{ op: "replace", pos: fallbackAnchor, lines: ["line2 updated"] }] },
        context as never,
      );
      expect(result).toContain("Error: hash mismatch");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2 changed\nline3");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("applies anchored replace edits and emits filediff metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-edit-"));

    try {
      const filePath = join(directory, "sample.ts");
      await writeFile(filePath, 'function greet() {\n  return "hi";\n}\n', "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const anchor = `2#${computeLineHash(2, '  return "hi";')}#${computeAnchorHash(2, "function greet() {", '  return "hi";', "}")}`;
      const { context, metadataCalls } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchor, lines: ['  return "hello";'] }],
        },
        context as never,
      );

      expect(result).toContain(`Updated ${filePath}`);
      expect(result).toContain("+1/-1");
      expect(result).toContain("first change line 2");
      expect(result).toContain("@@ changed lines 2 @@");
      expect(result).toContain('-   return "hi";');
      expect(result).toContain('+   return "hello";');
      expect(await readFile(filePath, "utf8")).toBe('function greet() {\n  return "hello";\n}\n');
      expect(metadataCalls).toHaveLength(1);
      expect(metadataCalls[0]?.title).toBe(filePath);
      expect((metadataCalls[0]?.metadata?.filediff as { after?: string } | undefined)?.after).toBe(
        'function greet() {\n  return "hello";\n}\n',
      );
      // Producer contract: the emitted metadata matches the declared schema.
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

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [
            {
              op: "replace_range",
              pos: anchorFor(originalLines, 2),
              end: anchorFor(originalLines, 3),
              lines: ["replaced"],
            },
            {
              op: "append",
              pos: anchorFor(originalLines, 4),
              lines: ["inserted"],
            },
          ],
        },
        context as never,
      );

      expect(result).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("line1\nreplaced\nline4\ninserted\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates a missing file from prepend and append edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-create-"));

    try {
      const filePath = join(directory, "created.ts");
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [
            { op: "append", lines: ["line2"] },
            { op: "prepend", lines: ["line1"] },
          ],
        },
        context as never,
      );

      expect(result).toContain(`Updated ${filePath}`);
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

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          rename: renamedPath,
          edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: ["line2-updated"] }],
        },
        context as never,
      );

      expect(result).toContain(`Moved ${filePath} to ${renamedPath}`);
      expect(result).toContain("+1/-1");
      await expect(readFile(filePath, "utf8")).rejects.toThrow();
      expect(await readFile(renamedPath, "utf8")).toBe("line1\nline2-updated");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("deletes a file in delete mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-delete-"));

    try {
      const filePath = join(directory, "delete-me.ts");
      await writeFile(filePath, "line1\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          delete: true,
          edits: [],
        },
        context as never,
      );

      expect(result).toBe(`Successfully deleted ${filePath}`);
      await expect(readFile(filePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects delete mode with non-empty edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-delete-reject-"));

    try {
      const filePath = join(directory, "delete-reject.ts");
      await writeFile(filePath, "line1\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          delete: true,
          edits: [{ op: "replace", pos: "1#ZZ#ZZ", lines: ["bad"] }],
        },
        context as never,
      );

      expect(result).toContain("delete mode requires edits to be an empty array");
      expect(await readFile(filePath, "utf8")).toBe("line1\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects delete mode combined with rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-delete-rename-"));

    try {
      const filePath = join(directory, "delete-rename.ts");
      await writeFile(filePath, "line1\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          delete: true,
          rename: join(directory, "new-name.ts"),
          edits: [],
        },
        context as never,
      );

      expect(result).toContain("delete and rename cannot be used together");
      expect(await readFile(filePath, "utf8")).toBe("line1\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects anchored append when the target file is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-missing-anchored-"));

    try {
      const filePath = join(directory, "missing.ts");
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "append", pos: "1#ZZ#ZZ", lines: ["bad"] }],
        },
        context as never,
      );

      expect(result).toContain(`Error: File not found: ${filePath}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports no-op edits instead of rewriting the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-noop-"));

    try {
      const filePath = join(directory, "noop.ts");
      const originalLines = ["line1", "line2"];
      await writeFile(filePath, `${originalLines.join("\n")}\n`, "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: ["line2"] }],
        },
        context as never,
      );

      expect(result).toContain("No changes made");
      expect(result).toContain("No-op edits: 1");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects stale anchors with an updated mismatch snippet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-stale-"));

    try {
      const filePath = join(directory, "stale.ts");
      await writeFile(filePath, 'function greet() {\n  return "hi";\n}\n', "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      const staleAnchor = `2#${computeLineHash(2, '  return "hi";')}#${computeAnchorHash(2, "function greet() {", '  return "hi";', "}")}`;

      const firstContext = createToolContext(directory).context;
      await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: staleAnchor, lines: ['  return "hello";'] }],
        },
        firstContext as never,
      );

      const secondContext = createToolContext(directory).context;
      const secondResult = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: staleAnchor, lines: ['  return "bonjour";'] }],
        },
        secondContext as never,
      );

      expect(secondResult).toContain("Error: hash mismatch");
      expect(secondResult).toContain(
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

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      const anchor = `2#${computeLineHash(2, "const second = 2;")}#${computeAnchorHash(2, "const first = 1;", "const second = 2;", "")}`;

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchor, lines: ["const second = 3;"] }],
        },
        context as never,
      );

      expect(result).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe(
        "\uFEFFconst first = 1;\r\nconst second = 3;\r\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  test("reports a warning when stripping exact boundary echoes", () => {
    const lines = ["before", "old 1", "old 2", "after"];
    const warnings: string[] = [];

    applyReplaceLines(
      lines,
      anchorFor(lines, 2),
      anchorFor(lines, 3),
      ["before", "new 1", "new 2", "after"],
      { onWarning: (message) => warnings.push(message) },
    );

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("exact boundary echo");
  });

  test("keeps boundary-identical payload lines when the payload is not longer than the range", () => {
    const lines = ["before", "old", "after"];

    expect(applyReplaceLines(lines, anchorFor(lines, 2), anchorFor(lines, 2), ["before"])).toEqual([
      "before",
      "before",
      "after",
    ]);
  });

  test("preserves range boundary lines that differ only by indentation", () => {
    const lines = ["if (outer) {", "  old();", "}"];

    expect(
      applyReplaceLines(lines, anchorFor(lines, 2), anchorFor(lines, 2), [
        "  if (inner) {",
        "    work();",
        "  }",
      ]),
    ).toEqual(["if (outer) {", "  if (inner) {", "    work();", "  }", "}"]);
  });

  test("strips copied anchor echoes for anchored inserts", () => {
    const lines = ["line1", "line2", "line3"];

    expect(applyInsertAfter(lines, anchorFor(lines, 1), ["line1", "between"])).toEqual([
      "line1",
      "between",
      "line2",
      "line3",
    ]);
    expect(applyInsertBefore(lines, anchorFor(lines, 3), ["before3", "line3"])).toEqual([
      "line1",
      "line2",
      "before3",
      "line3",
    ]);
  });

  test("keeps whitespace-differing insert payload lines literally", () => {
    const lines = ["line1", "line2", "line3"];

    expect(applyInsertAfter(lines, anchorFor(lines, 1), [" line1", "between"])).toEqual([
      "line1",
      " line1",
      "between",
      "line2",
      "line3",
    ]);
  });

  test("autocorrects merged replacement lines back to the original line count", () => {
    const lines = ["const a = 1;", "const b = 2;"];

    expect(
      applyReplaceLines(
        lines,
        anchorFor(lines, 1),
        anchorFor(lines, 2),
        "const a = 10; const b = 20;",
      ),
    ).toEqual(["const a = 10; const b = 20;"]);
  });

  test("applies merged single-line replacement payloads literally", () => {
    const lines = ["const a = 1;", "const b = 2;"];

    expect(
      applyReplaceLines(
        lines,
        anchorFor(lines, 1),
        anchorFor(lines, 2),
        "const a = 10; const b = 20;",
      ),
    ).toEqual(["const a = 10; const b = 20;"]);
  });

  test("appends to a newline-terminated file without a phantom blank line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-eof-"));

    try {
      const filePath = join(directory, "eof.ts");
      await writeFile(filePath, "line1\nline2\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        { filePath, edits: [{ op: "append", lines: ["line3"] }] },
        context as never,
      );

      expect(result).toContain(`Updated ${filePath}`);
      expect(result).toContain("+1/-0");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2\nline3\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects blank-only replacement payloads with teaching guidance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-blank-"));

    try {
      const filePath = join(directory, "blank.ts");
      const originalLines = ["line1", "line2"];
      await writeFile(filePath, originalLines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(originalLines, 2), lines: [""] }],
        },
        context as never,
      );

      expect(result).toContain("ambiguous");
      expect(result).toContain("lines: []");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects embedded newlines inside array payload entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-newline-"));

    try {
      const filePath = join(directory, "newline.ts");
      const originalLines = ["line1", "line2"];
      await writeFile(filePath, originalLines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool?.hashline_edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "append", pos: anchorFor(originalLines, 1), lines: ["a\nb"] }],
        },
        context as never,
      );

      expect(result).toContain("embedded newline");
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function userMessage(model: { providerID: string; modelID: string }) {
  return {
    id: "msg_1",
    sessionID: "session-1",
    role: "user" as const,
    time: { created: Date.now() },
    agent: "build",
    model,
    tools: undefined as Record<string, boolean> | undefined,
  };
}

async function writeProjectVvocConfig(directory: string, pluginsEntry: unknown): Promise<void> {
  const doc = JSON.parse(renderVvocConfig(createDefaultVvocConfig())) as {
    plugins: Record<string, unknown>;
  };
  doc.plugins["hashline-edit"] = pluginsEntry;
  await mkdir(join(directory, ".vvoc"), { recursive: true });
  await writeFile(
    join(directory, ".vvoc", "vvoc.json"),
    JSON.stringify(doc, null, 2) + "\n",
    "utf8",
  );
}

describe("HashlineEditPlugin routing", () => {
  test("registers hashline_edit and str_replace_editor tools only (built-in edit stays host-owned)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-reg-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      expect(plugin.tool?.hashline_edit).toBeDefined();
      expect(plugin.tool?.str_replace_editor).toBeDefined();
      expect(plugin.tool?.edit).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("chat.message hides non-profile edit tools per model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-vis-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const hook = plugin["chat.message"]!;

      const deepseekMessage = userMessage({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
      await hook({ sessionID: "session-1", model: deepseekMessage.model } as never, {
        message: deepseekMessage as never,
        parts: [],
      });
      expect(deepseekMessage.tools).toEqual({ hashline_edit: false, edit: false });

      const qwenMessage = userMessage({ providerID: "alibaba-token-plan", modelID: "qwen3.8-max" });
      await hook({ sessionID: "session-2", model: qwenMessage.model } as never, {
        message: qwenMessage as never,
        parts: [],
      });
      expect(qwenMessage.tools).toEqual({ hashline_edit: false, str_replace_editor: false });

      const glmMessage = userMessage({ providerID: "zai-coding-plan", modelID: "glm-5.1" });
      await hook({ sessionID: "session-3", model: glmMessage.model } as never, {
        message: glmMessage as never,
        parts: [],
      });
      expect(glmMessage.tools).toEqual({ hashline_edit: false, str_replace_editor: false });

      const minimaxMessage = userMessage({
        providerID: "minimax-coding-plan",
        modelID: "MiniMax-M2.7",
      });
      await hook({ sessionID: "session-5", model: minimaxMessage.model } as never, {
        message: minimaxMessage as never,
        parts: [],
      });
      expect(minimaxMessage.tools).toEqual({ edit: false, str_replace_editor: false });

      const gptMessage = userMessage({ providerID: "openai", modelID: "gpt-5.4" });
      await hook({ sessionID: "session-4", model: gptMessage.model } as never, {
        message: gptMessage as never,
        parts: [],
      });
      expect(gptMessage.tools).toEqual({
        hashline_edit: false,
        edit: false,
        str_replace_editor: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("tool.execute.before denies visibility before argument validation and guards allowed tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-guard-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;
      const beforeHook = plugin["tool.execute.before"]!;

      const message = userMessage({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
      await hook_call(chatHook, "session-1", message);

      // Visibility denial stays first: the hidden tool is refused with the
      // routing teaching error even though its arguments are also invalid.
      await expect(
        beforeHook(
          { tool: "hashline_edit", sessionID: "session-1", callID: "c1" } as never,
          { args: {} } as never,
        ),
      ).rejects.toThrow(/str_replace_editor instead/);

      // The visible tool accepts valid arguments...
      await expect(
        beforeHook(
          { tool: "str_replace_editor", sessionID: "session-1", callID: "c2" } as never,
          { args: { command: "view", path: "/tmp/x" } } as never,
        ),
      ).resolves.toBeUndefined();

      // ...and rejects structural/command-invalid raw arguments before the handler.
      await expect(
        beforeHook(
          { tool: "str_replace_editor", sessionID: "session-1", callID: "c3" } as never,
          { args: { command: "view", path: "/tmp/x", old_str: "boom" } } as never,
        ),
      ).rejects.toThrow(/old_str is not consumed by command view/);

      await expect(
        beforeHook(
          { tool: "str_replace_editor", sessionID: "session-1", callID: "c4" } as never,
          { args: { command: "view", path: "   " } } as never,
        ),
      ).rejects.toThrow(/path must be a non-empty path/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("read hook adds anchors only for hashline sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-read-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;

      const deepseekMessage = userMessage({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
      await hook_call(chatHook, "session-deepseek", deepseekMessage);
      const deepseekOutput = { title: "t", output: "1: const a = 1;", metadata: {} };
      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-deepseek", callID: "c1", args: {} } as never,
        deepseekOutput as never,
      );
      expect(deepseekOutput.output).toBe("1: const a = 1;");

      const minimaxMessage = userMessage({
        providerID: "minimax-coding-plan",
        modelID: "MiniMax-M2.7",
      });
      await hook_call(chatHook, "session-minimax", minimaxMessage);
      const minimaxOutput = { title: "t", output: "1: const a = 1;", metadata: {} };
      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-minimax", callID: "c2", args: {} } as never,
        minimaxOutput as never,
      );
      expect(minimaxOutput.output).toContain("1#");
      expect(minimaxOutput.output).toContain("|const a = 1;");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("built-in edit stays host-owned: not registered, never blocked, visible for the edit cohort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-builtin-edit-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;

      // The plugin registers no edit tool: the host built-in edit is the only
      // edit runtime, and tool.execute.before must not block it.
      expect(plugin.tool?.edit).toBeUndefined();
      const before = plugin["tool.execute.before"]!;
      await expect(
        before({ tool: "edit", sessionID: "session-1", callID: "call-1" } as never, {} as never),
      ).resolves.toBeUndefined();

      // The edit cohort (kimi-k3 modelID contains "kimi") keeps the built-in
      // edit visible and hides the plugin profiles; its read output carries no
      // hash anchors.
      const kimiMessage = userMessage({ providerID: "kimi-for-coding", modelID: "kimi-k3" });
      await hook_call(chatHook, "session-1", kimiMessage);
      expect(kimiMessage.tools).toEqual({
        hashline_edit: false,
        str_replace_editor: false,
      });
      expect(kimiMessage.tools?.edit).toBeUndefined();

      const output = {
        title: directory,
        output: "1: const first = 1;\n2: const second = 2;",
        metadata: {},
      };
      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-1", callID: "call-1", args: {} } as never,
        output as never,
      );
      expect(output.output).toBe("1: const first = 1;\n2: const second = 2;");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("str_replace_editor executes the dsh contract through the plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-dsh-"));
    try {
      const filePath = join(directory, "sample.py");
      await writeFile(filePath, "alpha\nbeta\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;
      const message = userMessage({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
      await hook_call(chatHook, "session-1", message);

      const { context, metadataCalls } = createToolContext(directory);
      const editorTool = plugin.tool!.str_replace_editor;

      const viewed = await editorTool.execute(
        { command: "view", path: filePath },
        context as never,
      );
      expect(viewed).toContain("Here's the content of");
      expect(metadataCalls).toHaveLength(0);

      const replaced = await editorTool.execute(
        { command: "str_replace", path: filePath, old_str: "beta", new_str: "BETA" },
        context as never,
      );
      expect(replaced).toBe(`The file ${filePath} has been edited successfully.`);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\n");
      // Producer contract: the emitted metadata matches the declared schema.
      expect(metadataCalls).toHaveLength(1);
      expect(strReplaceEditorMetadataSchema.safeParse(metadataCalls[0]?.metadata).success).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("routing overrides from project vvoc config change profile visibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-config-"));
    try {
      await writeProjectVvocConfig(directory, {
        enabled: true,
        routing: { default: "hashline_edit", rules: { qwen: "hashline_edit" } },
      });

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;
      const message = userMessage({ providerID: "alibaba-token-plan", modelID: "qwen3.8-max" });
      await hook_call(chatHook, "session-1", message);
      expect(message.tools).toEqual({ edit: false, str_replace_editor: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("disabled plugin entry registers nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-disabled-"));
    try {
      await writeProjectVvocConfig(directory, false);
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      expect(plugin.tool).toBeUndefined();
      expect(plugin["chat.message"]).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("HashlineEditPlugin edit tool contracts", () => {
  test("publishes strict input schemas for both edit tools through the definition hook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-definition-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const definition = plugin["tool.definition"]!;

      const hashlineOutput: Record<string, unknown> = {
        description: "hashline",
        parameters: {},
        jsonSchema: {},
      };
      await definition({ toolID: "hashline_edit" } as never, hashlineOutput as never);
      const hashlineSchema = hashlineOutput.jsonSchema as Record<string, unknown>;
      expect(hashlineSchema.additionalProperties).toBe(false);
      const hashlineProps = hashlineSchema.properties as Record<string, unknown>;
      expect(Object.keys(hashlineProps).sort()).toEqual(["delete", "edits", "filePath", "rename"]);
      const edits = hashlineProps.edits as {
        items: { additionalProperties?: boolean; properties: Record<string, unknown> };
      };
      expect(edits.items.additionalProperties).toBe(false);
      expect((edits.items.properties.op as { enum?: string[] }).enum).toEqual([
        "replace",
        "replace_range",
        "append",
        "prepend",
      ]);

      const strOutput: Record<string, unknown> = {
        description: "str",
        parameters: {},
        jsonSchema: {},
      };
      await definition({ toolID: "str_replace_editor" } as never, strOutput as never);
      const strSchema = strOutput.jsonSchema as Record<string, unknown>;
      expect(strSchema.additionalProperties).toBe(false);
      const strProps = strSchema.properties as Record<string, unknown>;
      expect((strProps.command as { enum?: string[] }).enum).toEqual([
        "view",
        "create",
        "str_replace",
        "insert",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("registered hook rejects unknown edit fields and blank anchors for a visible tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-hook-shape-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const beforeHook = plugin["tool.execute.before"]!;
      const call = (args: Record<string, unknown>) =>
        beforeHook(
          { tool: "hashline_edit", sessionID: "session-hook", callID: "h1" } as never,
          { args } as never,
        );

      // No model registered for this session: the default mode is hashline_edit.
      await expect(
        call({ filePath: "/tmp/a.ts", edits: [{ op: "append", lines: ["x"], typo: 1 }] }),
      ).rejects.toThrow(/typo/);
      await expect(
        call({ filePath: "/tmp/a.ts", edits: [{ op: "append", pos: "   ", lines: ["x"] }] }),
      ).rejects.toThrow(/pos was provided but is blank/);
      await expect(
        call({ filePath: "/tmp/a.ts", edits: [{ op: "prepend", end: "", lines: ["x"] }] }),
      ).rejects.toThrow(/end was provided but is blank/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("direct hashline execute rejects structural input without editing or reporting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-structural-"));
    try {
      const filePath = join(directory, "structural.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const { context, metadataCalls } = createToolContext(directory);

      const unknownKey = await editTool.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(lines, 1), lines: ["x"], bogus: true }],
        } as never,
        context as never,
      );
      expect(unknownKey).toContain("INVALID_INPUT");
      expect(await readFile(filePath, "utf8")).toBe(lines.join("\n"));

      const unknownOp = await editTool.execute(
        { filePath, edits: [{ op: "set_line", pos: anchorFor(lines, 1), lines: ["x"] }] } as never,
        context as never,
      );
      expect(unknownOp).toContain("INVALID_INPUT");
      expect(metadataCalls).toHaveLength(0);
      expect(await readFile(filePath, "utf8")).toBe(lines.join("\n"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("direct hashline execute rejects delete/rename and delete/edits conflicts before mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-conflict-"));
    try {
      const filePath = join(directory, "conflict.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const { context, metadataCalls } = createToolContext(directory);

      const deleteRename = await editTool.execute(
        { filePath, delete: true, rename: join(directory, "renamed.ts"), edits: [] },
        context as never,
      );
      expect(deleteRename).toContain("delete and rename cannot be used together");

      const deleteEdits = await editTool.execute(
        {
          filePath,
          delete: true,
          edits: [{ op: "replace", pos: anchorFor(lines, 1), lines: ["x"] }],
        },
        context as never,
      );
      expect(deleteEdits).toContain("delete mode requires edits to be an empty array");

      expect(metadataCalls).toHaveLength(0);
      expect(await readFile(filePath, "utf8")).toBe(lines.join("\n"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("renaming to a path-equivalent source applies edits in place without deleting the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-self-rename-"));
    try {
      const filePath = join(directory, "same.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const { context } = createToolContext(directory);

      const result = await editTool.execute(
        {
          filePath,
          rename: join(directory, ".", "same.ts"),
          edits: [{ op: "replace", pos: anchorFor(lines, 2), lines: ["line2-updated"] }],
        },
        context as never,
      );

      expect(result).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2-updated");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a metadata publication failure after a successful edit stays truthful", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-metadata-fail-"));
    try {
      const filePath = join(directory, "meta.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const { context } = createToolContext(directory, { metadataThrows: true });

      const result = await editTool.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(lines, 2), lines: ["line2-updated"] }],
        },
        context as never,
      );

      const text = result as string;
      expect(text).toContain(`Updated ${filePath}`);
      expect(text).not.toContain("INVALID_INPUT");
      expect(text).toContain("reporting metadata failed");
      expect(text).toContain("inspect the file before retrying");
      expect(text).not.toContain(METADATA_FAILURE_SECRET);
      const warningLine = text
        .split("\n")
        .find((line: string) => line.includes("reporting metadata failed"));
      expect(warningLine).toBeDefined();
      expect(warningLine!.length).toBeLessThan(300);
      expect(await readFile(filePath, "utf8")).toBe("line1\nline2-updated");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("str_replace_editor metadata failure after a successful edit stays truthful", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-str-metadata-fail-"));
    try {
      const filePath = join(directory, "str-meta.ts");
      await writeFile(filePath, "alpha\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      await establishModel(plugin, "session-1", "deepseek", "deepseek-v4-flash");
      const editorTool = plugin.tool!.str_replace_editor;
      const { context } = createToolContext(directory, { metadataThrows: true });

      const result = await editorTool.execute(
        { command: "str_replace", path: filePath, old_str: "alpha", new_str: "beta" },
        context as never,
      );

      const text = result as string;
      expect(text).toContain(`The file ${filePath} has been edited successfully.`);
      expect(text).not.toContain("INVALID_INPUT");
      expect(text).toContain("reporting metadata failed");
      expect(text).not.toContain(METADATA_FAILURE_SECRET);
      expect(text.length).toBeLessThan(1000);
      expect(await readFile(filePath, "utf8")).toBe("beta\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("str_replace_editor direct execute rejects unknown fields without writing or reporting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-str-structural-"));
    try {
      const filePath = join(directory, "str.ts");
      await writeFile(filePath, "alpha\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      await establishModel(plugin, "session-1", "deepseek", "deepseek-v4-flash");
      const editorTool = plugin.tool!.str_replace_editor;
      const { context, metadataCalls } = createToolContext(directory);

      const result = await editorTool.execute(
        {
          command: "str_replace",
          path: filePath,
          old_str: "alpha",
          new_str: "beta",
          bogus: 1,
        } as never,
        context as never,
      );

      expect(result).toContain("Error: INVALID_INPUT");
      expect(metadataCalls).toHaveLength(0);
      expect(await readFile(filePath, "utf8")).toBe("alpha\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("str_replace_editor view accepts an end-of-file range through the plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-str-view-"));
    try {
      const filePath = join(directory, "view.ts");
      await writeFile(filePath, "one\ntwo\nthree\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      await establishModel(plugin, "session-1", "deepseek", "deepseek-v4-flash");
      const editorTool = plugin.tool!.str_replace_editor;
      const { context, metadataCalls } = createToolContext(directory);

      const result = await editorTool.execute(
        { command: "view", path: filePath, view_range: [2, -1] },
        context as never,
      );
      expect(result).toContain("     2  two");
      expect(result).toContain("     3  three");
      expect(metadataCalls).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("direct execute enforces session model visibility before argument details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-direct-visibility-"));
    try {
      const filePath = join(directory, "visibility.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const editorTool = plugin.tool!.str_replace_editor;

      // A real deepseek session model: str_replace_editor is visible, hashline_edit is not.
      await establishModel(plugin, "session-1", "deepseek", "deepseek-v4-flash");

      const validCtx = createToolContext(directory);
      await expect(
        editTool.execute(
          { filePath, edits: [{ op: "replace", pos: anchorFor(lines, 1), lines: ["x"] }] },
          validCtx.context as never,
        ),
      ).rejects.toThrow(/not available for this session's model/);

      // Invalid arguments are denied by visibility too, before schema details.
      const invalidCtx = createToolContext(directory);
      await expect(
        editTool.execute({ filePath, edits: [] }, invalidCtx.context as never),
      ).rejects.toThrow(/not available for this session's model/);

      expect(validCtx.metadataCalls).toHaveLength(0);
      expect(invalidCtx.metadataCalls).toHaveLength(0);
      expect(await readFile(filePath, "utf8")).toBe(lines.join("\n"));

      // A session with no routing match defaults to hashline_edit, so the str editor is hidden.
      const defaultCtx = createToolContext(directory, { sessionID: "session-default" });
      await expect(
        editorTool.execute({ command: "view", path: filePath }, defaultCtx.context as never),
      ).rejects.toThrow(/not available for this session's model/);
      expect(defaultCtx.metadataCalls).toHaveLength(0);
      expect(await readFile(filePath, "utf8")).toBe(lines.join("\n"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("direct execute rejects empty paths, blank rename, and blank anchors before effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-path-blank-"));
    try {
      const filePath = join(directory, "paths.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const { context, metadataCalls } = createToolContext(directory);

      const blankPath = await editTool.execute(
        { filePath: "   ", edits: [{ op: "append", lines: ["x"] }] },
        context as never,
      );
      expect(blankPath).toContain("filePath must be a non-empty path");

      const blankRename = await editTool.execute(
        { filePath, rename: "  ", edits: [{ op: "append", lines: ["x"] }] },
        context as never,
      );
      expect(blankRename).toContain("rename must be a non-empty path");

      const blankAnchor = await editTool.execute(
        { filePath, edits: [{ op: "append", pos: "   ", lines: ["x"] }] },
        context as never,
      );
      expect(blankAnchor).toContain("pos was provided but is blank");

      expect(metadataCalls).toHaveLength(0);
      expect(await readFile(filePath, "utf8")).toBe(lines.join("\n"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves spaces inside real file and rename paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-path-spaces-"));
    try {
      const filePath = join(directory, "my file.ts");
      const renamedPath = join(directory, "renamed file.ts");
      const lines = ["line1", "line2"];
      await writeFile(filePath, lines.join("\n"), "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const editTool = plugin.tool!.hashline_edit;
      const { context } = createToolContext(directory);

      const updated = await editTool.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchorFor(lines, 2), lines: ["line2-updated"] }],
        },
        context as never,
      );
      expect(updated).toContain(`Updated ${filePath}`);

      const moved = await editTool.execute(
        { filePath, rename: renamedPath, edits: [{ op: "append", lines: ["tail"] }] },
        context as never,
      );
      expect(moved).toContain(`Moved ${filePath} to ${renamedPath}`);
      expect(await readFile(renamedPath, "utf8")).toBe("line1\nline2-updated\ntail");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function hook_call(
  hook: (input: never, output: never) => Promise<void>,
  sessionID: string,
  message: ReturnType<typeof userMessage>,
): Promise<void> {
  await hook(
    { sessionID, model: message.model } as never,
    { message: message as never, parts: [] } as never,
  );
}

/** Register a real session model so direct execute passes the visibility gate. */
async function establishModel(
  plugin: Awaited<ReturnType<typeof HashlineEditPlugin>>,
  sessionID: string,
  providerID: string,
  modelID: string,
): Promise<void> {
  await hook_call(plugin["chat.message"]!, sessionID, userMessage({ providerID, modelID }));
}
