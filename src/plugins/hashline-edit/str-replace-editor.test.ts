// FILE: src/plugins/hashline-edit/str-replace-editor.test.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the dsh str_replace_editor contract: view formatting, view_range validation (exact shape before dispatch, file-length in the editor), exact-verbatim str_replace, ambiguity line numbers, insert validation, create guard, path hints, directory listing, truncation, structural/command rejection at the direct entry, result-envelope production, and view-cache drift rejection.
//   SCOPE: Deterministic in-memory filesystem coverage of every str_replace_editor command, structural rejection path, and error path.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/schemas.ts, src/plugins/hashline-edit/str-replace-editor.ts, src/plugins/hashline-edit/session-state.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeFile - In-memory file record with content and snapshot.
//   FakeFs - In-memory StrReplaceEditorFs implementation with mutable snapshots.
//   SESSION - Fixed session identifier used across editor fixtures.
//   makeEditor - Build a StrReplaceEditor wired to a FakeFs and a session file cache.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Updated view_range/missing-field expectations to the shared contract diagnostics, added direct-entry structural rejection, empty/whitespace path rejection with preserved in-name spaces, empty file_text/empty new_str acceptance, and result-envelope schema checks.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  STR_REPLACE_TRUNCATION_MARKER,
  StrReplaceEditor,
  type StrReplaceEditorFs,
  type StrReplaceEditorFsEntry,
} from "./str-replace-editor.js";
import { strReplaceEditorResultSchema } from "./schemas.js";
import { SessionFileCache, type FileSnapshot } from "./session-state.js";

interface FakeFile {
  content: string;
  snapshot: FileSnapshot;
}

class FakeFs implements StrReplaceEditorFs {
  files = new Map<string, FakeFile>();
  dirs = new Map<string, StrReplaceEditorFsEntry[]>();

  addFile(
    path: string,
    content: string,
    snapshot: FileSnapshot = { mtimeMs: 1, size: content.length },
  ): void {
    this.files.set(path, { content, snapshot });
  }

  addDir(path: string, entries: StrReplaceEditorFsEntry[]): void {
    this.dirs.set(path, entries);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }

  async readText(path: string): Promise<string> {
    return this.files.get(path)?.content ?? "";
  }

  async writeText(path: string, content: string): Promise<void> {
    const existing = this.files.get(path);
    this.files.set(path, {
      content,
      snapshot: { mtimeMs: (existing?.snapshot.mtimeMs ?? 0) + 1, size: content.length },
    });
  }

  async listDir(path: string): Promise<StrReplaceEditorFsEntry[]> {
    return this.dirs.get(path) ?? [];
  }

  async stat(path: string): Promise<FileSnapshot | undefined> {
    return (
      this.files.get(path)?.snapshot ?? (this.dirs.has(path) ? { mtimeMs: 0, size: 0 } : undefined)
    );
  }
}

const SESSION = "ses_1";

function makeEditor(fs: FakeFs): StrReplaceEditor {
  const cache = new SessionFileCache();
  return new StrReplaceEditor({
    fs,
    onViewed: (path, snapshot) => cache.record(SESSION, path, snapshot),
    checkFreshness: (path, current) => cache.check(SESSION, path, current),
  });
}

describe("str_replace_editor view command", () => {
  test("renders the dsh header and 6-padded line numbers", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\nbeta\n");
    const result = await makeEditor(fs).execute({ command: "view", path: "/repo/a.py" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain(
      "Here's the content of /repo/a.py with line numbers (which has a total of 3 lines):",
    );
    expect(result.output).toContain("     1  alpha");
    expect(result.output).toContain("     2  beta");
  });

  test("view_range slices and validates with dsh error texts", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "one\ntwo\nthree\nfour\n");
    const editor = makeEditor(fs);

    const sliced = await editor.execute({
      command: "view",
      path: "/repo/a.py",
      view_range: [2, 3],
    });
    expect(sliced.ok).toBe(true);
    if (sliced.ok) {
      expect(sliced.output).toContain("with view_range=[2, 3]");
      expect(sliced.output).toContain("     2  two");
      expect(sliced.output).not.toContain("     1  one");
    }

    const eofRange = await editor.execute({
      command: "view",
      path: "/repo/a.py",
      view_range: [3, -1],
    });
    expect(eofRange.ok).toBe(true);
    if (eofRange.ok) {
      expect(eofRange.output).toContain("     3  three");
    }

    // The exact length is a representable schema bound and is rejected before any
    // filesystem access; the file-length checks below still run inside the editor.
    const badShape = await editor.execute({ command: "view", path: "/repo/a.py", view_range: [1] });
    expect(badShape.ok).toBe(false);
    if (!badShape.ok) {
      expect(badShape.error).toContain("INVALID_INPUT");
      expect(badShape.error).toContain("view_range");
    }

    const badFirst = await editor.execute({
      command: "view",
      path: "/repo/a.py",
      view_range: [99, 100],
    });
    expect(badFirst.ok).toBe(false);
    if (!badFirst.ok) {
      expect(badFirst.error).toContain(
        "Its first element `99` should be within the range of lines of the file: [1, 5]",
      );
    }

    const badSecond = await editor.execute({
      command: "view",
      path: "/repo/a.py",
      view_range: [1, 99],
    });
    expect(badSecond.ok).toBe(false);
    if (!badSecond.ok) {
      expect(badSecond.error).toContain(
        "Its second element `99` should be smaller than the number of lines in the file: `5`",
      );
    }

    const inverted = await editor.execute({
      command: "view",
      path: "/repo/a.py",
      view_range: [3, 2],
    });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) {
      expect(inverted.error).toContain("INVALID_INPUT");
      expect(inverted.error).toContain("must be -1 or >= start");
    }
  });

  test("truncates long output with the dsh marker", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/big.txt", "x".repeat(500));
    const cache = new SessionFileCache();
    const editor = new StrReplaceEditor({
      fs,
      maxOutputChars: 100,
      onViewed: (path, snapshot) => cache.record(SESSION, path, snapshot),
      checkFreshness: (path, current) => cache.check(SESSION, path, current),
    });
    const result = await editor.execute({ command: "view", path: "/repo/big.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.endsWith(STR_REPLACE_TRUNCATION_MARKER)).toBe(true);
  });

  test("directory view lists two levels excluding hidden, node_modules, __pycache__", async () => {
    const fs = new FakeFs();
    fs.addDir("/repo", [
      { name: "src", type: "directory" },
      { name: ".git", type: "directory" },
      { name: "node_modules", type: "directory" },
      { name: "__pycache__", type: "directory" },
      { name: "README.md", type: "file" },
    ]);
    fs.addDir("/repo/src", [{ name: "main.py", type: "file" }]);

    const result = await makeEditor(fs).execute({ command: "view", path: "/repo" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain(
      "Here're the files and directories up to 2 levels deep in /repo",
    );
    expect(result.output).toContain("d\t/repo/src");
    expect(result.output).toContain("f\t/repo/src/main.py");
    expect(result.output).toContain("f\t/repo/README.md");
    expect(result.output).not.toContain("/repo/.git");
    expect(result.output).not.toContain("/repo/node_modules");
    expect(result.output).not.toContain("/repo/__pycache__");
  });

  test("view_range is rejected for directories", async () => {
    const fs = new FakeFs();
    fs.addDir("/repo", []);
    const result = await makeEditor(fs).execute({
      command: "view",
      path: "/repo",
      view_range: [1, 2],
    });
    expect(result).toEqual({
      ok: false,
      error: "The `view_range` parameter is not allowed when `path` points to a directory.",
    });
  });
});

describe("str_replace_editor str_replace command", () => {
  test("replaces an exact verbatim match", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\nbeta\ngamma\n");
    const editor = makeEditor(fs);

    await editor.execute({ command: "view", path: "/repo/a.py" });
    const result = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      old_str: "beta",
      new_str: "BETA",
    });
    expect(result).toEqual({
      ok: true,
      output: "The file /repo/a.py has been edited successfully.",
    });
    expect(fs.files.get("/repo/a.py")?.content).toBe("alpha\nBETA\ngamma\n");
  });

  test("zero matches return the dsh FS_EDIT_NOT_FOUND text", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n");
    const editor = makeEditor(fs);
    await editor.execute({ command: "view", path: "/repo/a.py" });
    const result = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      old_str: "beta",
      new_str: "x",
    });
    expect(result).toEqual({
      ok: false,
      error: "No replacement was performed, old_str `beta` did not appear verbatim in /repo/a.py.",
    });
  });

  test("multiple matches list all occurrence line numbers", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "dup\nkeep\ndup\n");
    const editor = makeEditor(fs);
    await editor.execute({ command: "view", path: "/repo/a.py" });
    const result = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      old_str: "dup",
      new_str: "x",
    });
    expect(result).toEqual({
      ok: false,
      error:
        "No replacement was performed. Multiple occurrences of old_str `dup` in lines [1, 3]. Please ensure it is unique",
    });
  });

  test("missing or empty old_str are rejected by the shared command contract", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n");
    const editor = makeEditor(fs);

    const missing = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      new_str: "x",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain("INVALID_INPUT");
      expect(missing.error).toContain("old_str: str_replace requires old_str");
    }

    const empty = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      old_str: "",
      new_str: "x",
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toContain("INVALID_INPUT");
      expect(empty.error).toContain("old_str must be a non-empty exact string");
    }
  });

  test("rejects edits when the file drifted since the last view", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n", { mtimeMs: 10, size: 6 });
    const editor = makeEditor(fs);
    await editor.execute({ command: "view", path: "/repo/a.py" });

    // External modification drifts the snapshot.
    fs.files.set("/repo/a.py", { content: "changed\n", snapshot: { mtimeMs: 99, size: 8 } });

    const result = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      old_str: "alpha",
      new_str: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("has changed since it was last viewed");
    }
  });
});

describe("str_replace_editor create and insert commands", () => {
  test("create writes a new file and rejects existing files with the dsh guard", async () => {
    const fs = new FakeFs();
    const editor = makeEditor(fs);

    const created = await editor.execute({
      command: "create",
      path: "/repo/new.py",
      file_text: "print(1)\n",
    });
    expect(created).toEqual({ ok: true, output: "New file created successfully at: /repo/new.py" });
    expect(fs.files.get("/repo/new.py")?.content).toBe("print(1)\n");

    const again = await editor.execute({ command: "create", path: "/repo/new.py", file_text: "x" });
    expect(again).toEqual({
      ok: false,
      error: "File already exists at: /repo/new.py. Cannot overwrite files using command `create`.",
    });
  });

  test("insert validates insert_line and inserts after the line", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "one\ntwo\n");
    const editor = makeEditor(fs);
    await editor.execute({ command: "view", path: "/repo/a.py" });

    const inserted = await editor.execute({
      command: "insert",
      path: "/repo/a.py",
      insert_line: 1,
      new_str: "INSERTED",
    });
    expect(inserted).toEqual({
      ok: true,
      output: "The file /repo/a.py has been edited successfully.",
    });
    expect(fs.files.get("/repo/a.py")?.content).toBe("one\nINSERTED\ntwo\n");

    const invalid = await editor.execute({
      command: "insert",
      path: "/repo/a.py",
      insert_line: 99,
      new_str: "x",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain("Invalid `insert_line` parameter: 99");
    }

    const missingLine = await editor.execute({
      command: "insert",
      path: "/repo/a.py",
      new_str: "x",
    });
    expect(missingLine.ok).toBe(false);
    if (!missingLine.ok) {
      expect(missingLine.error).toContain("INVALID_INPUT");
      expect(missingLine.error).toContain("insert requires an integer insert_line >= 0");
    }

    const missingNewStr = await editor.execute({
      command: "insert",
      path: "/repo/a.py",
      insert_line: 0,
    });
    expect(missingNewStr.ok).toBe(false);
    if (!missingNewStr.ok) {
      expect(missingNewStr.error).toContain("insert requires new_str");
    }
  });

  test("create accepts an explicitly empty file_text", async () => {
    const fs = new FakeFs();
    const result = await makeEditor(fs).execute({
      command: "create",
      path: "/repo/empty.txt",
      file_text: "",
    });
    expect(result).toEqual({
      ok: true,
      output: "New file created successfully at: /repo/empty.txt",
    });
    expect(fs.files.get("/repo/empty.txt")?.content).toBe("");
  });

  test("insert accepts an explicitly empty new_str", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "one\ntwo\n");
    const editor = makeEditor(fs);
    await editor.execute({ command: "view", path: "/repo/a.py" });

    const result = await editor.execute({
      command: "insert",
      path: "/repo/a.py",
      insert_line: 1,
      new_str: "",
    });
    expect(result.ok).toBe(true);
    expect(fs.files.get("/repo/a.py")?.content).toBe("one\n\ntwo\n");
  });

  test("str_replace defaults an omitted new_str to deletion", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\nbeta\ngamma\n");
    const editor = makeEditor(fs);
    await editor.execute({ command: "view", path: "/repo/a.py" });

    const result = await editor.execute({
      command: "str_replace",
      path: "/repo/a.py",
      old_str: "beta\n",
    });
    expect(result.ok).toBe(true);
    expect(fs.files.get("/repo/a.py")?.content).toBe("alpha\ngamma\n");
  });
});

describe("str_replace_editor path handling", () => {
  test("relative paths return the absolute-path hint", async () => {
    const fs = new FakeFs();
    const result = await makeEditor(fs).execute({ command: "view", path: "repo/a.py" });
    expect(result).toEqual({
      ok: false,
      error:
        "The path repo/a.py is not an absolute path, it should start with `/`. Maybe you meant /repo/a.py?",
    });
  });

  test("missing paths and directories under mutation commands return dsh errors", async () => {
    const fs = new FakeFs();
    fs.addDir("/repo", []);
    const editor = makeEditor(fs);

    const missing = await editor.execute({ command: "view", path: "/nope" });
    expect(missing).toEqual({
      ok: false,
      error: "The path /nope does not exist. Please provide a valid path.",
    });

    const dirEdit = await editor.execute({
      command: "str_replace",
      path: "/repo",
      old_str: "a",
      new_str: "b",
    });
    expect(dirEdit).toEqual({
      ok: false,
      error: "The path /repo is a directory and only the `view` command can be used on directories",
    });
  });
});

describe("str_replace_editor direct-entry contract rejection", () => {
  test("rejects an unknown root property before any filesystem access or cache update", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n");
    const viewed: Array<{ path: string }> = [];
    const editor = new StrReplaceEditor({
      fs,
      onViewed: (path) => viewed.push({ path }),
      checkFreshness: () => "fresh",
    });

    const result = await editor.execute({
      command: "view",
      path: "/repo/a.py",
      bogus: true,
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("INVALID_INPUT");
      expect(result.error).toContain("bogus");
    }
    expect(viewed).toHaveLength(0);
    expect(fs.files.get("/repo/a.py")?.content).toBe("alpha\n");
  });

  test("rejects a recognized field the selected command does not consume", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n");
    const result = await makeEditor(fs).execute({
      command: "view",
      path: "/repo/a.py",
      old_str: "alpha",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("old_str is not consumed by command view");
    }
  });

  test("rejects an empty or whitespace-only path without a filesystem call", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n");
    const viewed: Array<{ path: string }> = [];
    const editor = new StrReplaceEditor({
      fs,
      onViewed: (path) => viewed.push({ path }),
      checkFreshness: () => "fresh",
    });

    for (const badPath of ["", "   "]) {
      const result = await editor.execute({ command: "view", path: badPath });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("path must be a non-empty path");
      }
    }
    expect(viewed).toHaveLength(0);
  });

  test("preserves spaces inside a real file name", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/my file.py", "alpha\n");
    const result = await makeEditor(fs).execute({ command: "view", path: "/repo/my file.py" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("/repo/my file.py");
    }
  });

  test("emits result envelopes matching the producer schema", async () => {
    const fs = new FakeFs();
    fs.addFile("/repo/a.py", "alpha\n");
    const editor = makeEditor(fs);

    const view = await editor.execute({ command: "view", path: "/repo/a.py" });
    const missing = await editor.execute({ command: "view", path: "/nope" });
    expect(strReplaceEditorResultSchema.safeParse(view).success).toBe(true);
    expect(strReplaceEditorResultSchema.safeParse(missing).success).toBe(true);
    expect(
      strReplaceEditorResultSchema.safeParse({ ok: true, output: "x", extra: true }).success,
    ).toBe(false);
  });
});
