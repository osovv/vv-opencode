// FILE: src/plugins/hashline-edit.test.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline read-output enhancement and the default-on hash-anchored edit override behavior.
//   SCOPE: Plugin registration, wrapped and plain read hashing, ranged edits, rename/delete flows, missing-file edits, stale-anchor rejection, partial-read anchors, normalization heuristics, and BOM/CRLF preservation.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/index.ts]
//   LINKS: [V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HashlineEditPlugin tests - Verify read hashing, edit execution, partial-read anchor stability, normalization heuristics, mismatch handling, and text-envelope preservation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Added regression coverage preventing post-read source snapshots from being mixed into stale visible rows.]
//   LAST_CHANGE: [v0.4.0 - Added regression coverage for full-snapshot context anchors on partial and truncated read output.]
//   LAST_CHANGE: [v0.3.0 - Updated read output expectations for anchor hash format (line#hash#anchor|content).]
//   LAST_CHANGE: [v0.2.0 - Added regression coverage for wrapped read output, ranged plus appended edits, missing-file creation, and normalization heuristics adapted from oh-my-openagent.]
//   LAST_CHANGE: [v0.1.0 - Added a default-on hash-anchored edit override that rewrites Read output to `line#hash|content` and rejects stale anchors on edit.
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInsertAfter,
  applyInsertBefore,
  applyReplaceLines,
} from "./hashline-edit/edit-operation-primitives.js";
import { computeAnchorHash, computeLineHash } from "./hashline-edit/hash-computation.js";
import { HashlineEditPlugin } from "./hashline-edit/index.js";

function createPluginInput(directory: string) {
  return {
    client: {} as never,
    project: {} as never,
    directory,
    worktree: directory,
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
  return `${line}#${computeLineHash(line, lines[line - 1] ?? "")}`;
}

describe("HashlineEditPlugin", () => {
  test("registers the edit override and hashes read output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-hashline-read-"));

    try {
      const plugin = await HashlineEditPlugin(createPluginInput(directory));
      expect(plugin.tool?.edit).toBeDefined();

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
      const result = await plugin.tool!.edit.execute(
        { filePath, edits: [{ op: "replace", pos: anchor, lines: ["line2 updated"] }] },
        context as never,
      );
      expect(result).toBe(`Updated ${filePath}`);
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
      const result = await plugin.tool!.edit.execute(
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
      const editTool = plugin.tool?.edit;
      expect(editTool).toBeDefined();

      const anchor = `2#${computeLineHash(2, '  return "hi";')}`;
      const { context, metadataCalls } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchor, lines: ['  return "hello";'] }],
        },
        context as never,
      );

      expect(result).toBe(`Updated ${filePath}`);
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
      const editTool = plugin.tool?.edit;
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

      expect(result).toBe(`Updated ${filePath}`);
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
      const editTool = plugin.tool?.edit;
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

      expect(result).toBe(`Updated ${filePath}`);
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
      const editTool = plugin.tool?.edit;
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

      expect(result).toBe(`Moved ${filePath} to ${renamedPath}`);
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
      const editTool = plugin.tool?.edit;
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
      const editTool = plugin.tool?.edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          delete: true,
          edits: [{ op: "replace", pos: "1#ZZ", lines: ["bad"] }],
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
      const editTool = plugin.tool?.edit;
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
      const editTool = plugin.tool?.edit;
      expect(editTool).toBeDefined();

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "append", pos: "1#ZZ", lines: ["bad"] }],
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
      const editTool = plugin.tool?.edit;
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
      const editTool = plugin.tool?.edit;
      const staleAnchor = `2#${computeLineHash(2, '  return "hi";')}`;

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
      const editTool = plugin.tool?.edit;
      const anchor = `2#${computeLineHash(2, "const second = 2;")}`;

      const { context } = createToolContext(directory);
      const result = await editTool!.execute(
        {
          filePath,
          edits: [{ op: "replace", pos: anchor, lines: ["const second = 3;"] }],
        },
        context as never,
      );

      expect(result).toBe(`Updated ${filePath}`);
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

  test("autocorrects merged replacement lines back to the original line count", () => {
    const lines = ["const a = 1;", "const b = 2;"];

    expect(
      applyReplaceLines(
        lines,
        anchorFor(lines, 1),
        anchorFor(lines, 2),
        "const a = 10; const b = 20;",
      ),
    ).toEqual(["const a = 10;", "const b = 20;"]);
  });
});
