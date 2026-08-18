// FILE: src/plugins/hashline-edit/str-replace-editor.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Implement the DeepSeek dsh str_replace_editor contract (view/create/str_replace/insert) as a native edit profile.
//   SCOPE: Command dispatch, dsh-verbatim view formatting and error texts, exact-verbatim str_replace matching with occurrence line numbers, insert_line validation, create guard, absolute-path hint, directory listing, output truncation, and view-cache freshness checks.
//   DEPENDS: [src/plugins/hashline-edit/session-state.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   STR_REPLACE_EDITOR_DESCRIPTION - Model-facing dsh tool description (verbatim, MIT attribution).
//   STR_REPLACE_TRUNCATION_MARKER - dsh response-clipped marker appended to truncated view output.
//   StrReplaceEditorArgs - Tool-facing command arguments.
//   StrReplaceEditorResult - Ok output or fail-closed error text.
//   StrReplaceEditorFs - Filesystem seam used by the editor (node:fs-backed in production, fake in tests).
//   StrReplaceEditorFsEntry - Directory entry name and type returned by the filesystem seam.
//   StrReplaceEditorOptions - Editor options: filesystem seam, output cap, and view-cache callbacks.
//   StrReplaceEditor - Executes str_replace_editor commands with dsh semantics and view-cache freshness checks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Ported the dsh str_replace_editor contract (deepseek-ai/deepseek-harness @ 47f94385, MIT) with an mtime/size view-cache as the replaceIfVersion CAS equivalent.]
// END_CHANGE_SUMMARY

import type { FileCacheVerdict, FileSnapshot } from "./session-state.js";

// START_BLOCK_CONSTANTS
// Verbatim from deepseek-ai/deepseek-harness (MIT).
export const STR_REPLACE_TRUNCATION_MARKER =
  "<response clipped><NOTE>To save on context only part of this file was been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

export const STR_REPLACE_EDITOR_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
export interface StrReplaceEditorArgs {
  command: "view" | "create" | "str_replace" | "insert";
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  view_range?: number[];
}

export type StrReplaceEditorResult = { ok: true; output: string } | { ok: false; error: string };

export interface StrReplaceEditorFsEntry {
  name: string;
  type: "file" | "directory";
}

export interface StrReplaceEditorFs {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<StrReplaceEditorFsEntry[]>;
  stat(path: string): Promise<FileSnapshot | undefined>;
}

export interface StrReplaceEditorOptions {
  fs: StrReplaceEditorFs;
  maxOutputChars?: number;
  onViewed?: (path: string, snapshot: FileSnapshot) => void;
  checkFreshness?: (path: string, current: FileSnapshot | undefined) => FileCacheVerdict;
}
// END_BLOCK_TYPES

// START_BLOCK_HELPERS
function ok(output: string): StrReplaceEditorResult {
  return { ok: true, output };
}

function fail(error: string): StrReplaceEditorResult {
  return { ok: false, error };
}

function maybeTruncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + STR_REPLACE_TRUNCATION_MARKER;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) {
      return offsets;
    }
    offsets.push(match);
    offset = match + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") {
        line += 1;
      }
      cursor += 1;
    }
    return line;
  });
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
// END_BLOCK_HELPERS

// START_BLOCK_EDITOR
export class StrReplaceEditor {
  private readonly maxOutputChars: number;

  constructor(private readonly options: StrReplaceEditorOptions) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  async execute(args: StrReplaceEditorArgs): Promise<StrReplaceEditorResult> {
    const path = args.path;
    if (typeof path !== "string" || path.trim().length === 0) {
      return fail("path must be a non-empty string");
    }
    if (!path.startsWith("/")) {
      return fail(
        `The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`,
      );
    }

    switch (args.command) {
      case "view":
        return this.view(path, args.view_range);
      case "create":
        return this.create(path, args.file_text);
      case "str_replace":
        return this.strReplace(path, args.old_str, args.new_str);
      case "insert":
        return this.insert(path, args.insert_line, args.new_str);
      default:
        return fail(`Unknown command: ${String(args.command)}`);
    }
  }

  private async statExisting(
    path: string,
    command: "view" | "str_replace" | "insert" | "create",
  ): Promise<{ snapshot: FileSnapshot; isDir: boolean } | StrReplaceEditorResult> {
    const exists = await this.options.fs.exists(path);
    if (!exists) {
      return fail(`The path ${path} does not exist. Please provide a valid path.`);
    }
    const isDir = await this.options.fs.isDirectory(path);
    if (isDir && command !== "view") {
      return fail(
        `The path ${path} is a directory and only the \`view\` command can be used on directories`,
      );
    }
    const snapshot = (await this.options.fs.stat(path)) ?? { mtimeMs: 0, size: 0 };
    return { snapshot, isDir };
  }

  private async view(
    path: string,
    viewRange: number[] | undefined,
  ): Promise<StrReplaceEditorResult> {
    const stated = await this.statExisting(path, "view");
    if ("ok" in stated) {
      return stated;
    }

    if (stated.isDir) {
      if (viewRange !== undefined) {
        return fail("The `view_range` parameter is not allowed when `path` points to a directory.");
      }
      return this.listDirectory(path);
    }

    const content = await this.options.fs.readText(path);
    let formatted: string;
    try {
      formatted = this.formatFileView(path, content, viewRange);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    this.options.onViewed?.(path, stated.snapshot);
    return ok(formatted);
  }

  private formatFileView(path: string, content: string, viewRange: number[] | undefined): string {
    const allLines = content.split("\n");
    let lines = allLines;
    let initialLine = 1;
    let finalLine: number | undefined;
    let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;

    if (viewRange !== undefined) {
      const [requestedInitialLine, requestedFinalLine] = viewRange;
      if (
        viewRange.length !== 2 ||
        requestedInitialLine === undefined ||
        requestedFinalLine === undefined ||
        !viewRange.every(Number.isInteger)
      ) {
        throw new Error("Invalid `view_range`. It should be a list of two integers.");
      }
      initialLine = requestedInitialLine;
      finalLine = requestedFinalLine;
      if (initialLine < 1 || initialLine > allLines.length) {
        throw new Error(
          `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
        );
      }
      if (finalLine > allLines.length) {
        throw new Error(
          `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
        );
      }
      if (finalLine !== -1 && finalLine < initialLine) {
        throw new Error(
          `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
        );
      }
      lines =
        finalLine === -1
          ? allLines.slice(initialLine - 1)
          : allLines.slice(initialLine - 1, finalLine);
      prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
    }

    const numbered = lines
      .map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
      .join("\n");
    return maybeTruncate(`${prompt}:\n${numbered}\n`, this.maxOutputChars);
  }

  private async listDirectory(path: string): Promise<StrReplaceEditorResult> {
    const visit = async (dir: string, depth: number): Promise<string[]> => {
      const entries = await this.options.fs.listDir(dir);
      const rows: string[] = [];
      for (const entry of entries.filter(
        (candidate) =>
          !candidate.name.startsWith(".") &&
          candidate.name !== "node_modules" &&
          candidate.name !== "__pycache__",
      )) {
        const entryPath = `${dir}/${entry.name}`;
        const type = entry.type === "directory" ? "d" : "f";
        rows.push(`${type}\t${entryPath}`);
        if (entry.type === "directory" && depth < 2) {
          rows.push(...(await visit(entryPath, depth + 1)));
        }
      }
      return rows;
    };

    const rows = [`d\t${path}`, ...(await visit(path, 1))];
    rows.sort((left, right) =>
      codepointCompare(left.slice(left.indexOf("\t") + 1), right.slice(right.indexOf("\t") + 1)),
    );
    const listing = maybeTruncate(rows.join("\n") + "\n", this.maxOutputChars);
    return ok(
      `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`,
    );
  }

  private async create(
    path: string,
    fileText: string | undefined,
  ): Promise<StrReplaceEditorResult> {
    if (fileText === undefined) {
      return fail("Parameter `file_text` is required for command: create");
    }
    if (await this.options.fs.exists(path)) {
      return fail(
        `File already exists at: ${path}. Cannot overwrite files using command \`create\`.`,
      );
    }
    await this.options.fs.writeText(path, fileText);
    const snapshot = await this.options.fs.stat(path);
    if (snapshot) {
      this.options.onViewed?.(path, snapshot);
    }
    return ok(`New file created successfully at: ${path}`);
  }

  private async strReplace(
    path: string,
    oldStr: string | undefined,
    newStr: string | undefined,
  ): Promise<StrReplaceEditorResult> {
    if (oldStr === undefined) {
      return fail("Parameter `old_str` is required for command: str_replace");
    }
    if (oldStr.length === 0) {
      return fail("Parameter `old_str` is empty for command: str_replace");
    }
    const stated = await this.statExisting(path, "str_replace");
    if ("ok" in stated) {
      return stated;
    }

    const drift = this.options.checkFreshness?.(path, stated.snapshot);
    if (drift === "drifted") {
      return fail(
        `The file ${path} has changed since it was last viewed. Run the view command again before editing.`,
      );
    }

    const before = await this.options.fs.readText(path);
    const offsets = matchOffsets(before, oldStr);
    if (offsets.length === 0) {
      return fail(
        `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`,
      );
    }
    if (offsets.length > 1) {
      const lines = lineNumbersAt(before, offsets);
      return fail(
        `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
      );
    }

    const offset = offsets[0]!;
    const newValue = newStr ?? "";
    await this.options.fs.writeText(
      path,
      before.slice(0, offset) + newValue + before.slice(offset + oldStr.length),
    );
    const snapshot = await this.options.fs.stat(path);
    if (snapshot) {
      this.options.onViewed?.(path, snapshot);
    }
    return ok(`The file ${path} has been edited successfully.`);
  }

  private async insert(
    path: string,
    insertLine: number | undefined,
    newStr: string | undefined,
  ): Promise<StrReplaceEditorResult> {
    if (insertLine === undefined) {
      return fail("Parameter `insert_line` is required for command: insert");
    }
    if (newStr === undefined) {
      return fail("Parameter `new_str` is required for command: insert");
    }
    const stated = await this.statExisting(path, "insert");
    if ("ok" in stated) {
      return stated;
    }

    const drift = this.options.checkFreshness?.(path, stated.snapshot);
    if (drift === "drifted") {
      return fail(
        `The file ${path} has changed since it was last viewed. Run the view command again before editing.`,
      );
    }

    const before = await this.options.fs.readText(path);
    const lines = before.split("\n");
    if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
      return fail(
        `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
      );
    }
    const after = [
      ...lines.slice(0, insertLine),
      ...newStr.split("\n"),
      ...lines.slice(insertLine),
    ].join("\n");
    await this.options.fs.writeText(path, after);
    const snapshot = await this.options.fs.stat(path);
    if (snapshot) {
      this.options.onViewed?.(path, snapshot);
    }
    return ok(`The file ${path} has been edited successfully.`);
  }
}
// END_BLOCK_EDITOR
