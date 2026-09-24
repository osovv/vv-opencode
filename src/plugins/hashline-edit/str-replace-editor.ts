// FILE: src/plugins/hashline-edit/str-replace-editor.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Implement the DeepSeek dsh str_replace_editor contract (view/create/str_replace/insert) as a native edit profile.
//   SCOPE: Command dispatch, dsh-verbatim view formatting and file-dependent error texts, exact-verbatim str_replace matching with occurrence line numbers, insert_line file-length validation, create guard, absolute-path hint, directory listing, output truncation, and view-cache freshness checks. Registered argument shapes and args-only command validation come from schemas.ts; this module reruns that validation at its direct entry before any filesystem access. The model-facing description is owned by tool-description.ts and re-exported here.
//   DEPENDS: [src/lib/agent-tool-contract.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/hashline-edit/session-state.ts, src/plugins/hashline-edit/tool-description.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   STR_REPLACE_EDITOR_DESCRIPTION - Model-facing dsh tool description (verbatim, MIT attribution); re-exported from tool-description.ts.
//   STR_REPLACE_TRUNCATION_MARKER - dsh response-clipped marker appended to truncated view output.
//   StrReplaceEditorArgs - Tool-facing command arguments; schema-derived from schemas.ts.
//   StrReplaceEditorResult - Ok output or fail-closed error text; schema-derived from schemas.ts.
//   StrReplaceEditorFs - Filesystem seam used by the editor (node:fs-backed in production, fake in tests).
//   StrReplaceEditorFsEntry - Directory entry name and type returned by the filesystem seam.
//   StrReplaceEditorOptions - Editor options: filesystem seam, output cap, and view-cache callbacks.
//   StrReplaceEditor - Executes str_replace_editor commands with dsh semantics and view-cache freshness checks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Moved the description to tool-description.ts (re-exported), derived argument/result types from the single-source contract, and rejected structural/command-invalid arguments at the direct editor entry before any filesystem access.]
// END_CHANGE_SUMMARY

import { formatContractIssues } from "../../lib/agent-tool-contract.js";
import type { FileCacheVerdict, FileSnapshot } from "./session-state.js";
import {
  validateStrReplaceEditorToolInput,
  type StrReplaceEditorResult,
  type StrReplaceEditorToolArgs,
} from "./schemas.js";
import { STR_REPLACE_EDITOR_DESCRIPTION } from "./tool-description.js";

export { STR_REPLACE_EDITOR_DESCRIPTION };
export type { StrReplaceEditorResult };

/** Tool-facing command arguments; schema-derived from the registered contract. */
export type StrReplaceEditorArgs = StrReplaceEditorToolArgs;

// START_BLOCK_CONSTANTS
export const STR_REPLACE_TRUNCATION_MARKER =
  "<response clipped><NOTE>To save on context only part of this file was been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
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
    // Reject structural and command-invalid arguments before touching the
    // filesystem or the view-freshness cache. The registered hook runs the same
    // validator; this direct entry never relies on the host having done so.
    const validation = validateStrReplaceEditorToolInput(args);
    if (!validation.ok) {
      return fail(formatContractIssues(validation.issues));
    }

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
