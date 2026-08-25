// FILE: src/plugins/hashline-edit.test.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline read-output enhancement and the default-on hash-anchored edit override behavior.
//   SCOPE: Plugin registration, wrapped and plain read hashing, ranged edits, rename/delete flows, missing-file edits, stale-anchor rejection, partial-read anchors, literal payload application, blank/embedded-newline payload rejection, EOF append behavior, normalization heuristics, post-edit diff feedback, and BOM/CRLF preservation.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/index.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   anchorFor - Builds a visible hashline anchor for fixture content.
//   createPluginInput - Builds an isolated OpenCode plugin input fixture.
//   createToolContext - Builds a tool execution context fixture.
//   hook_call - Invokes the chat.message hook with a session model fixture.
//   previousConfigHome - Preserves the caller's config-home environment for cleanup.
//   userMessage - Builds an SDK-shaped user message fixture carrying a provider/model pair.
//   writeProjectVvocConfig - Seeds a project .vvoc/vvoc.json overriding the hashline-edit plugin entry.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.8.0 - Replaced autocorrect expectations with literal-application coverage and added blank-payload, embedded-newline, EOF-append, and diff-feedback regression tests.]
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
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;

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

function createToolContext(directory: string) {
  const metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }> = [];
  return {
    context: {
      sessionID: "session-1",
      messageID: "message-1",
      agent: "build",
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      metadata(input: { title?: string; metadata?: Record<string, unknown> }) {
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
  test("registers hashline_edit, replace edit, and str_replace_editor tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-reg-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      expect(plugin.tool?.hashline_edit).toBeDefined();
      expect(plugin.tool?.edit).toBeDefined();
      expect(plugin.tool?.str_replace_editor).toBeDefined();
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

  test("tool.execute.before rejects wrong-profile tools with a teaching error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-guard-"));
    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;
      const beforeHook = plugin["tool.execute.before"]!;

      const message = userMessage({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
      await hook_call(chatHook, "session-1", message);

      await expect(
        beforeHook(
          { tool: "hashline_edit", sessionID: "session-1", callID: "c1" } as never,
          { args: {} } as never,
        ),
      ).rejects.toThrow(/str_replace_editor instead/);

      await expect(
        beforeHook(
          { tool: "str_replace_editor", sessionID: "session-1", callID: "c2" } as never,
          { args: {} } as never,
        ),
      ).resolves.toBeUndefined();
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

  test("replace edit enforces prior read and applies exact matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-replace-"));
    try {
      const filePath = join(directory, "sample.ts");
      await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      const chatHook = plugin["chat.message"]!;
      const message = userMessage({ providerID: "kimi-for-coding", modelID: "k3" });
      await hook_call(chatHook, "session-1", message);

      const { context } = createToolContext(directory);
      const editTool = plugin.tool!.edit;

      const unread = await editTool.execute(
        { filePath, oldString: "beta", newString: "BETA" },
        context as never,
      );
      expect(unread).toContain("has not been read in this session");

      await plugin["tool.execute.after"]?.(
        { tool: "read", sessionID: "session-1", callID: "c1", args: { filePath } } as never,
        { title: "t", output: "1: alpha", metadata: {} } as never,
      );

      const result = await editTool.execute(
        { filePath, oldString: "beta", newString: "BETA" },
        context as never,
      );
      expect(result).toContain(`Updated ${filePath}`);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma\n");
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

      const { context } = createToolContext(directory);
      const editorTool = plugin.tool!.str_replace_editor;

      const viewed = await editorTool.execute(
        { command: "view", path: filePath },
        context as never,
      );
      expect(viewed).toContain("Here's the content of");

      const replaced = await editorTool.execute(
        { command: "str_replace", path: filePath, old_str: "beta", new_str: "BETA" },
        context as never,
      );
      expect(replaced).toBe(`The file ${filePath} has been edited successfully.`);
      expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("routing overrides from project vvoc config change profile visibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-routing-config-"));
    try {
      await writeProjectVvocConfig(directory, {
        enabled: true,
        routing: { default: "hashline", rules: { qwen: "hashline" } },
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
