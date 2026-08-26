// FILE: src/plugins/hashline-edit/index.ts
// VERSION: 0.9.0
// START_MODULE_CONTRACT
//   PURPOSE: Route per-model edit tooling: register hashline_edit and dsh str_replace_editor; resolve the session edit mode from vvoc routing config; expose exactly one edit tool per model (the host built-in edit/apply_patch for their cohorts, the plugin profiles otherwise); and transform read output with anchors for hashline sessions.
//   SCOPE: Routing config loading, session model/file caches, chat.message tool-visibility mutation, tool.execute.before safety net, routed read transformation, hashline/str_replace_editor execution, bounded post-edit diff feedback, and editMode telemetry metadata.
//   DEPENDS: [@opencode-ai/plugin, node:fs/promises, node:path, src/lib/config-layers.ts, src/plugins/hashline-edit/diff-summary.ts, src/plugins/hashline-edit/edit-operations.ts, src/plugins/hashline-edit/file-text-canonicalization.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/normalize-edits.ts, src/plugins/hashline-edit/routing.ts, src/plugins/hashline-edit/session-state.ts, src/plugins/hashline-edit/str-replace-editor.ts, src/plugins/hashline-edit/tool-description.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HashlineEditPlugin - Registers routed edit tools (hashline_edit, str_replace_editor), per-model tool visibility, and the routed read-output enhancer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.9.0 - Removed the replace profile: the plugin no longer registers an `edit` tool, so the host built-in edit serves qwen/kimi/glm cohorts with its native layers. Routing vocabulary is apply_patch|edit|str_replace_editor|hashline_edit.]
// END_CHANGE_SUMMARY

import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { findFirstChangedLine, summarizeEditDiff } from "./diff-summary.js";
import { applyHashlineEditsWithReport } from "./edit-operations.js";
import { canonicalizeFileText, restoreFileText } from "./file-text-canonicalization.js";
import { computeAnchorHash, computeLineHash } from "./hash-computation.js";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./normalize-edits.js";
import {
  parseHashlineEditPluginEntry,
  resolveEditMode,
  type EditMode,
  type RoutingConfig,
} from "./routing.js";
import { SessionFileCache, SessionModelCache, type FileSnapshot } from "./session-state.js";
import {
  STR_REPLACE_EDITOR_DESCRIPTION,
  StrReplaceEditor,
  type StrReplaceEditorArgs,
  type StrReplaceEditorFs,
  type StrReplaceEditorFsEntry,
} from "./str-replace-editor.js";
import { HASHLINE_EDIT_DESCRIPTION } from "./tool-description.js";
import type { HashlineEdit } from "./types.js";
import { HashlineMismatchError } from "./validation.js";
import { loadVvocConfig } from "../../lib/config-layers.js";

const z = tool.schema;
const CONTENT_OPEN_TAG = "<content>";
const CONTENT_CLOSE_TAG = "</content>";
const FILE_OPEN_TAG = "<file>";
const FILE_CLOSE_TAG = "</file>";
const OPENCODE_LINE_TRUNCATION_SUFFIX = "... (line truncated to 2000 chars)";
const COLON_READ_LINE_PATTERN = /^\s*(\d+): ?(.*)$/;
const PIPE_READ_LINE_PATTERN = /^\s*(\d+)\| ?(.*)$/;

// START_BLOCK_ROUTING_CONSTANTS
// Edit tools whose visibility chat.message manages. Includes the host
// built-in `edit` so deepseek/hashline cohorts see exactly one edit tool;
// `apply_patch` is deliberately absent (its visibility is owned by the host
// gate and never forced by this plugin).
const EDIT_VISIBILITY_TOOLS = ["hashline_edit", "edit", "str_replace_editor"] as const;

// Plugin-owned edit tools only. The host built-in edit/apply_patch are never
// registered or blocked by this plugin; they serve the `edit`/`apply_patch`
// routing modes with their native behavior.
const EDIT_TYPE_TOOLS = ["hashline_edit", "str_replace_editor"] as const;

type EditTypeTool = (typeof EDIT_TYPE_TOOLS)[number];

function isEditTypeTool(toolName: string): toolName is EditTypeTool {
  return (EDIT_TYPE_TOOLS as readonly string[]).includes(toolName);
}

function visibleToolsForMode(mode: EditMode): EditTypeTool[] {
  switch (mode) {
    case "hashline_edit":
      return ["hashline_edit"];
    case "str_replace_editor":
      return ["str_replace_editor"];
    // The host owns these tools; the plugin exposes none of its own edit
    // tools for `edit` (built-in edit stays visible) and `apply_patch`
    // (the host gate shows it to gpt/codex cohorts).
    case "edit":
    case "apply_patch":
      return [];
  }
}
// END_BLOCK_ROUTING_CONSTANTS

type HashlineEditArgs = {
  filePath: string;
  edits: RawHashlineEdit[];
  delete?: boolean;
  rename?: string;
};

type ReadToolArgs = {
  filePath?: unknown;
  path?: unknown;
  file?: unknown;
};

interface EditTelemetry {
  editMode: EditMode;
  providerID?: string;
  modelID?: string;
}

// START_BLOCK_FS_HELPERS
async function statSnapshot(filePath: string): Promise<FileSnapshot | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return undefined;
    }
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

function createNodeStrReplaceFs(): StrReplaceEditorFs {
  return {
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async readText(path: string): Promise<string> {
      return readFile(path, "utf8");
    },
    async writeText(path: string, content: string): Promise<void> {
      await writeFile(path, content, "utf8");
    },
    async listDir(path: string): Promise<StrReplaceEditorFsEntry[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry): StrReplaceEditorFsEntry => {
        const type = entry.isDirectory() ? "directory" : "file";
        return { name: entry.name, type };
      });
    },
    async stat(path: string): Promise<FileSnapshot | undefined> {
      try {
        const info = await stat(path);
        return { mtimeMs: info.mtimeMs, size: info.isFile() ? info.size : 0 };
      } catch {
        return undefined;
      }
    },
  };
}
// END_BLOCK_FS_HELPERS

function canCreateFromMissingFile(edits: HashlineEdit[]): boolean {
  if (edits.length === 0) {
    return false;
  }
  return edits.every(
    (edit) => (edit.op === "append" || edit.op === "prepend") && edit.pos === undefined,
  );
}

function publishSuccessMetadata(args: {
  context: ToolContext;
  filePath: string;
  beforeContent: string;
  afterContent: string;
  noopEdits: number;
  deduplicatedEdits: number;
  telemetry: EditTelemetry;
}): void {
  args.context.metadata({
    title: args.filePath,
    metadata: {
      filePath: args.filePath,
      path: args.filePath,
      file: args.filePath,
      noopEdits: args.noopEdits,
      deduplicatedEdits: args.deduplicatedEdits,
      firstChangedLine: findFirstChangedLine(args.beforeContent, args.afterContent),
      editMode: args.telemetry.editMode,
      providerID: args.telemetry.providerID,
      modelID: args.telemetry.modelID,
      filediff: {
        file: args.filePath,
        path: args.filePath,
        filePath: args.filePath,
        before: args.beforeContent,
        after: args.afterContent,
      },
    },
  });
}

function isReadTool(toolName: string): boolean {
  return toolName.toLowerCase() === "read";
}

function isTextFileOutput(output: string): boolean {
  const firstLine = output.split("\n")[0] ?? "";
  return COLON_READ_LINE_PATTERN.test(firstLine) || PIPE_READ_LINE_PATTERN.test(firstLine);
}

function isHashlineEligibleReadOutput(output: string): boolean {
  if (!output) {
    return false;
  }

  const lines = output.split("\n");
  const contentStart = lines.findIndex(
    (line) => line === CONTENT_OPEN_TAG || line.startsWith(CONTENT_OPEN_TAG),
  );
  const contentEnd = lines.indexOf(CONTENT_CLOSE_TAG);
  const fileStart = lines.findIndex(
    (line) => line === FILE_OPEN_TAG || line.startsWith(FILE_OPEN_TAG),
  );
  const fileEnd = lines.indexOf(FILE_CLOSE_TAG);

  const blockStart = contentStart !== -1 ? contentStart : fileStart;
  const blockEnd = contentStart !== -1 ? contentEnd : fileEnd;
  const openTag = contentStart !== -1 ? CONTENT_OPEN_TAG : FILE_OPEN_TAG;

  if (blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart) {
    const openLine = lines[blockStart] ?? "";
    const inlineFirst =
      openLine.startsWith(openTag) && openLine !== openTag ? openLine.slice(openTag.length) : null;
    const firstFileLine = inlineFirst ?? lines[blockStart + 1] ?? "";
    return isTextFileOutput(firstFileLine);
  }

  return isTextFileOutput(lines[0] ?? "");
}

function readArgFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }

  const readArgs = args as ReadToolArgs;
  for (const candidate of [readArgs.filePath, readArgs.path, readArgs.file]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

async function readSourceLines(args: unknown): Promise<string[] | undefined> {
  const filePath = readArgFilePath(args);
  if (!filePath) {
    return undefined;
  }

  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return undefined;
    }

    const rawContent = Buffer.from(await file.arrayBuffer()).toString("utf8");
    const envelope = canonicalizeFileText(rawContent);
    return envelope.content.length === 0 ? [] : envelope.content.split("\n");
  } catch {
    return undefined;
  }
}

interface ParsedReadLine {
  lineNumber: number;
  content: string;
  isTruncated: boolean;
}

function parseReadLineParsed(line: string): ParsedReadLine | null {
  const colonMatch = COLON_READ_LINE_PATTERN.exec(line);
  if (colonMatch) {
    const content = colonMatch[2] ?? "";
    return {
      lineNumber: Number.parseInt(colonMatch[1] ?? "0", 10),
      content,
      isTruncated: content.endsWith(OPENCODE_LINE_TRUNCATION_SUFFIX),
    };
  }

  const pipeMatch = PIPE_READ_LINE_PATTERN.exec(line);
  if (pipeMatch) {
    const content = pipeMatch[2] ?? "";
    return {
      lineNumber: Number.parseInt(pipeMatch[1] ?? "0", 10),
      content,
      isTruncated: content.endsWith(OPENCODE_LINE_TRUNCATION_SUFFIX),
    };
  }

  return null;
}

function sourceLineAt(sourceLines: string[] | undefined, lineNumber: number): string | undefined {
  if (!sourceLines || lineNumber < 1 || lineNumber > sourceLines.length) {
    return undefined;
  }
  return sourceLines[lineNumber - 1];
}

function sourceMatchesVisibleRows(
  sourceLines: string[] | undefined,
  parsedLines: ParsedReadLine[],
): sourceLines is string[] {
  if (!sourceLines) {
    return false;
  }

  for (const parsed of parsedLines) {
    if (parsed.isTruncated) {
      continue;
    }
    if (sourceLineAt(sourceLines, parsed.lineNumber) !== parsed.content) {
      return false;
    }
  }

  return true;
}

function formatParsedReadLine(
  parsed: ParsedReadLine,
  prevContent: string | undefined,
  currentContent: string,
  nextContent: string | undefined,
): string {
  return `${parsed.lineNumber}#${computeLineHash(parsed.lineNumber, currentContent)}#${computeAnchorHash(parsed.lineNumber, prevContent, currentContent, nextContent)}|${parsed.content}`;
}

function formatReadLines(
  parsedLines: ParsedReadLine[],
  rawLines: string[],
  sourceLines?: string[],
): string[] {
  const result: string[] = [];
  let parsedIndex = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    if (parsedIndex >= parsedLines.length) {
      result.push(...rawLines.slice(i));
      break;
    }

    const parsed = parsedLines[parsedIndex];
    if (i !== parsedIndex || !parsed) {
      result.push(...rawLines.slice(i));
      break;
    }

    if (parsed.isTruncated) {
      result.push(rawLines[i]!);
      parsedIndex += 1;
      continue;
    }

    const currentContent = sourceLineAt(sourceLines, parsed.lineNumber) ?? parsed.content;
    const prevContent = sourceLines
      ? sourceLineAt(sourceLines, parsed.lineNumber - 1)
      : parsedIndex > 0
        ? parsedLines[parsedIndex - 1]?.content
        : undefined;
    const nextContent = sourceLines
      ? sourceLineAt(sourceLines, parsed.lineNumber + 1)
      : parsedIndex + 1 < parsedLines.length
        ? parsedLines[parsedIndex + 1]?.content
        : undefined;
    result.push(formatParsedReadLine(parsed, prevContent, currentContent, nextContent));
    parsedIndex += 1;
  }

  return result;
}

function transformReadOutput(output: string, sourceLines?: string[]): string {
  if (!output) {
    return output;
  }

  const lines = output.split("\n");
  const contentStart = lines.findIndex(
    (line) => line === CONTENT_OPEN_TAG || line.startsWith(CONTENT_OPEN_TAG),
  );
  const contentEnd = lines.indexOf(CONTENT_CLOSE_TAG);
  const fileStart = lines.findIndex(
    (line) => line === FILE_OPEN_TAG || line.startsWith(FILE_OPEN_TAG),
  );
  const fileEnd = lines.indexOf(FILE_CLOSE_TAG);

  const blockStart = contentStart !== -1 ? contentStart : fileStart;
  const blockEnd = contentStart !== -1 ? contentEnd : fileEnd;
  const openTag = contentStart !== -1 ? CONTENT_OPEN_TAG : FILE_OPEN_TAG;

  if (blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart) {
    const openLine = lines[blockStart] ?? "";
    const inlineFirst =
      openLine.startsWith(openTag) && openLine !== openTag ? openLine.slice(openTag.length) : null;
    const fileLines =
      inlineFirst !== null
        ? [inlineFirst, ...lines.slice(blockStart + 1, blockEnd)]
        : lines.slice(blockStart + 1, blockEnd);

    if (!isTextFileOutput(fileLines[0] ?? "")) {
      return output;
    }

    const parsedLines: ParsedReadLine[] = [];
    for (const line of fileLines) {
      const parsed = parseReadLineParsed(line);
      if (!parsed) {
        break;
      }
      parsedLines.push(parsed);
    }
    const result = formatReadLines(
      parsedLines,
      fileLines,
      sourceMatchesVisibleRows(sourceLines, parsedLines) ? sourceLines : undefined,
    );

    const prefixLines =
      inlineFirst !== null
        ? [...lines.slice(0, blockStart), openTag]
        : lines.slice(0, blockStart + 1);
    return [...prefixLines, ...result, ...lines.slice(blockEnd)].join("\n");
  }

  if (!isTextFileOutput(lines[0] ?? "")) {
    return output;
  }

  const parsedLines: ParsedReadLine[] = [];
  for (const line of lines) {
    const parsed = parseReadLineParsed(line);
    if (!parsed) {
      break;
    }
    parsedLines.push(parsed);
  }
  const result = formatReadLines(
    parsedLines,
    lines,
    sourceMatchesVisibleRows(sourceLines, parsedLines) ? sourceLines : undefined,
  );
  return result.join("\n");
}

// START_BLOCK_HASHLINE_EXECUTE
async function executeHashlineEdit(
  args: HashlineEditArgs,
  context: ToolContext,
  telemetry: EditTelemetry,
): Promise<string> {
  try {
    const { filePath, rename, delete: deleteMode } = args;
    if (deleteMode && rename) {
      return "Error: delete and rename cannot be used together";
    }
    if (deleteMode && args.edits.length > 0) {
      return "Error: delete mode requires edits to be an empty array";
    }
    if (!deleteMode && (!Array.isArray(args.edits) || args.edits.length === 0)) {
      return "Error: edits parameter must be a non-empty array";
    }

    const edits = deleteMode ? [] : normalizeHashlineEdits(args.edits);
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists && !deleteMode && !canCreateFromMissingFile(edits)) {
      return `Error: File not found: ${filePath}`;
    }

    if (deleteMode) {
      if (!exists) {
        return `Error: File not found: ${filePath}`;
      }
      await file.delete();
      return `Successfully deleted ${filePath}`;
    }

    const rawOldContent = exists ? Buffer.from(await file.arrayBuffer()).toString("utf8") : "";
    const oldEnvelope = canonicalizeFileText(rawOldContent);
    const applyResult = applyHashlineEditsWithReport(oldEnvelope.content, edits);
    const canonicalNewContent = applyResult.content;

    if (canonicalNewContent === oldEnvelope.content && !rename) {
      let diagnostic = `No changes made to ${filePath}. The edits produced identical content.`;
      if (applyResult.noopEdits > 0) {
        diagnostic += ` No-op edits: ${applyResult.noopEdits}. Re-read the file and provide content that differs from the current lines.`;
      }
      return `Error: ${diagnostic}`;
    }

    const writeContent = restoreFileText(canonicalNewContent, oldEnvelope);

    // Resolve the rename target up front so path-equivalent strings (e.g.
    // /tmp/a and /tmp/./a) are detected as the same file and never cause a
    // write-then-delete data loss.
    const sourcePath = resolve(filePath);
    const targetPath = rename ? resolve(rename) : undefined;
    const isMove = targetPath !== undefined && targetPath !== sourcePath;

    if (isMove && (await Bun.file(targetPath!).exists())) {
      return `Error: rename target already exists: ${rename}. Refusing to overwrite an existing file.`;
    }

    await Bun.write(filePath, writeContent);

    if (isMove) {
      await Bun.write(targetPath!, writeContent);
      await Bun.file(filePath).delete();
    }

    const effectivePath = isMove ? targetPath! : filePath;
    publishSuccessMetadata({
      context,
      filePath: effectivePath,
      beforeContent: oldEnvelope.content,
      afterContent: canonicalNewContent,
      noopEdits: applyResult.noopEdits,
      deduplicatedEdits: applyResult.deduplicatedEdits,
      telemetry,
    });

    const diffSummary = summarizeEditDiff(oldEnvelope.content, canonicalNewContent);
    const firstChangedLine = findFirstChangedLine(oldEnvelope.content, canonicalNewContent);
    const stats = `+${diffSummary.additions}/-${diffSummary.deletions}${
      firstChangedLine !== undefined ? `, first change line ${firstChangedLine}` : ""
    }`;
    const headline = isMove
      ? `Moved ${filePath} to ${rename} (${stats})`
      : `Updated ${effectivePath} (${stats})`;
    const outputParts = [headline];
    for (const warning of applyResult.warnings) {
      outputParts.push(`Warning: ${warning}`);
    }
    if (applyResult.deduplicatedEdits > 0) {
      outputParts.push(
        `Note: ${applyResult.deduplicatedEdits} duplicate edit(s) were applied only once.`,
      );
    }
    outputParts.push(...diffSummary.rendered);
    return outputParts.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HashlineMismatchError) {
      return `Error: hash mismatch - ${message}\nTip: reuse LINE#ID#ANCHOR entries from the latest read output or mismatch snippet, or batch related edits in one call.`;
    }
    return `Error: ${message}`;
  }
}
// END_BLOCK_HASHLINE_EXECUTE

// START_BLOCK_STR_REPLACE_EXECUTE
async function executeStrReplaceEditor(
  args: StrReplaceEditorArgs,
  context: ToolContext,
  sessionID: string,
  fileCache: SessionFileCache,
  telemetry: EditTelemetry,
): Promise<string> {
  const editor = new StrReplaceEditor({
    fs: createNodeStrReplaceFs(),
    onViewed: (path, snapshot) => fileCache.record(sessionID, path, snapshot),
    checkFreshness: (path, current) => fileCache.check(sessionID, path, current),
  });

  const result = await editor.execute(args);
  if (!result.ok) {
    return `Error: ${result.error}`;
  }

  if (args.command !== "view") {
    context.metadata({
      title: args.path,
      metadata: {
        filePath: args.path,
        path: args.path,
        file: args.path,
        editMode: telemetry.editMode,
        providerID: telemetry.providerID,
        modelID: telemetry.modelID,
      },
    });
  }
  return result.output;
}
// END_BLOCK_STR_REPLACE_EXECUTE

// START_BLOCK_PLUGIN
export const HashlineEditPlugin: Plugin = async ({ directory }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  const settings = parseHashlineEditPluginEntry(vvoc.config.plugins?.["hashline-edit"]);
  if (!settings.enabled) return {};
  const routing: RoutingConfig = settings.routing;

  const modelCache = new SessionModelCache();
  const fileCache = new SessionFileCache();

  const resolveSessionMode = (sessionID: string): EditMode =>
    resolveEditMode(routing, modelCache.get(sessionID));

  const telemetryFor = (sessionID: string): EditTelemetry => {
    const model = modelCache.get(sessionID);
    return {
      editMode: resolveEditMode(routing, model),
      providerID: model?.providerID,
      modelID: model?.modelID,
    };
  };

  return {
    "chat.message": async (input, output) => {
      const model = output.message?.model;
      if (
        input.sessionID &&
        model &&
        typeof model.providerID === "string" &&
        typeof model.modelID === "string"
      ) {
        modelCache.set(input.sessionID, { providerID: model.providerID, modelID: model.modelID });
      }

      const mode = resolveEditMode(routing, model);
      const visible = new Set<string>(visibleToolsForMode(mode));
      const message = output.message;
      if (!message) return;
      const toolsMap = message.tools ?? {};
      for (const toolName of EDIT_VISIBILITY_TOOLS) {
        if (toolName === "edit" && mode === "edit") {
          // The host built-in edit stays visible for the edit cohort.
          continue;
        }
        if (!visible.has(toolName)) {
          toolsMap[toolName] = false;
        }
      }
      message.tools = toolsMap;
    },

    "tool.execute.before": async (input) => {
      if (!isEditTypeTool(input.tool)) {
        return;
      }
      const mode = resolveSessionMode(input.sessionID);
      const visible = visibleToolsForMode(mode);
      if (visible.includes(input.tool)) {
        return;
      }
      const preferred = visible[0] ?? "the host-provided edit tool (for example apply_patch)";
      throw new Error(
        `${input.tool} is not available for this session's model (edit mode: ${mode}). Use ${preferred} instead.`,
      );
    },

    "tool.execute.after": async (input, output) => {
      if (!isReadTool(input.tool)) {
        return;
      }

      const filePath = readArgFilePath(input.args);
      if (filePath) {
        const snapshot = await statSnapshot(filePath);
        if (snapshot) {
          fileCache.record(input.sessionID, filePath, snapshot);
        }
      }

      if (typeof output.output !== "string") {
        return;
      }
      if (resolveSessionMode(input.sessionID) !== "hashline_edit") {
        return;
      }
      if (!isHashlineEligibleReadOutput(output.output)) {
        return;
      }
      output.output = transformReadOutput(output.output, await readSourceLines(input.args));
    },

    tool: {
      hashline_edit: tool({
        description: HASHLINE_EDIT_DESCRIPTION,
        args: {
          filePath: z.string().describe("Absolute path to the file to edit"),
          delete: z.boolean().optional().describe("Delete the file instead of editing it"),
          rename: z.string().optional().describe("Rename the file after edits are applied"),
          edits: z
            .array(
              z.object({
                op: z.enum(["replace", "replace_range", "append", "prepend"]),
                pos: z
                  .string()
                  .optional()
                  .describe("Primary anchor in LINE#HASH#ANCHOR three-part format"),
                end: z
                  .string()
                  .optional()
                  .describe(
                    "Optional range end anchor in LINE#HASH#ANCHOR format. With end, replace covers the inclusive range pos..end; required when op is replace_range.",
                  ),
                lines: z
                  .union([z.array(z.string()), z.string(), z.null()])
                  .describe("Replacement or inserted lines as plain text content"),
              }),
            )
            .describe("Hash-anchored edit operations to apply to the file"),
        },
        execute: (args, context) =>
          executeHashlineEdit(args, context, telemetryFor(context.sessionID)),
      }),

      str_replace_editor: tool({
        description: STR_REPLACE_EDITOR_DESCRIPTION,
        args: {
          command: z
            .enum(["view", "create", "str_replace", "insert"])
            .describe("The command to run: view, create, str_replace, or insert"),
          path: z.string().describe("Absolute path to file or directory"),
          file_text: z
            .string()
            .optional()
            .describe("Required parameter of create command with the content of the new file"),
          old_str: z
            .string()
            .optional()
            .describe("Required parameter of str_replace command: the exact text to replace"),
          new_str: z
            .string()
            .optional()
            .describe(
              "Optional parameter of str_replace command with the replacement text; required for insert",
            ),
          insert_line: z
            .number()
            .int()
            .optional()
            .describe("Required parameter of insert command; new_str is inserted AFTER this line"),
          view_range: z
            .array(z.number().int())
            .optional()
            .describe("Optional [start, end] line range for view; end may be -1 for end of file"),
        },
        execute: (args, context) =>
          executeStrReplaceEditor(
            args,
            context,
            context.sessionID,
            fileCache,
            telemetryFor(context.sessionID),
          ),
      }),
    },
  };
};
// END_BLOCK_PLUGIN
