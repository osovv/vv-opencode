// FILE: src/plugins/hashline-edit.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline read-output enhancement and the default-on hash-anchored edit override behavior.
//   SCOPE: Plugin registration, read hashing, successful anchored edits, stale-anchor rejection, and BOM/CRLF preservation.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/index.ts]
//   LINKS: [V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HashlineEditPlugin tests - Verify read hashing, edit execution, mismatch handling, and text-envelope preservation.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLineHash } from "./hashline-edit/hash-computation.js";
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

      expect(output.output).toBe(
        `1#${computeLineHash(1, "const first = 1;")}|const first = 1;\n2#${computeLineHash(2, "const second = 2;")}|const second = 2;`,
      );
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
        `>>> 2#${computeLineHash(2, '  return "hello";')}|  return "hello";`,
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
});
