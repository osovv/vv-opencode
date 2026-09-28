// FILE: src/plugins/hashline-edit/index.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Route per-model native edit tooling: register hashline_edit and str_replace_editor as native OpenCode 2.0.18 tools, resolve the session edit mode from the captured vvoc routing config, expose exactly one plugin edit tool per actual session model (never touching the host edit/patch contracts), require a native resource permission before any write, and transform native read results with true line anchors and freshness tracking.
//   SCOPE: Native Plugin.define entry, per-bound-family captured routing resolution, session model capture from native context/model.request hooks, native session context tool-list visibility enforcement, execute.before visibility/structural guards, execute.after read-anchor transformation and freshness recording, native tool execution with awaited permission before mutation and respected caller abort, bounded post-edit metadata reporting, and editMode telemetry. Pure edit algorithms, anchors, encoding, normalization, and error semantics are unchanged. No V1 chat.message/tool.execute hooks, no V1 tool()/ToolContext.
//   DEPENDS: [@opencode/plugin, @opencode/plugin/promise/tool, effect (Schema.toJsonSchemaDocument; direct dep T009), zod, zod/v4/core, node:fs/promises, node:path, src/lib/agent-tool-contract.ts, src/plugins/hashline-edit/diff-summary.ts, src/plugins/hashline-edit/edit-operations.ts, src/plugins/hashline-edit/file-text-canonicalization.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/normalize-edits.ts, src/plugins/hashline-edit/routing.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/hashline-edit/session-state.ts, src/plugins/hashline-edit/str-replace-editor.ts, src/plugins/hashline-edit/validation.ts, src/runtime/context.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT, M-NATIVE-RUNTIME, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   nativeToolJsonSchema - Serialize a genuine native tool input ValueSchema to JSON Schema via public SDK APIs.
//   captureNativeToolDefinitions - Capture genuine activated native tool definitions into a map.
//   HashlinePermissionGuard - Narrow native resource-permission guard awaited before writes.
//   HashlineEditDependencies - Injectable per-family routing settings, permission guard and diagnostics.
//   HashlineEditHandlers - Native session/tool hook handlers plus the two native tool infos.
//   HashlineEditRegistration - Handlers plus cleanup-owning dispose.
//   createHashlineEditHandlers - Build routing state, native hook handlers and the two tool infos.
//   HashlineEditPluginOptions - Optional injectable runtime acquisition for tests.
//   createHashlineEditPlugin - Native plugin factory; the default export acquires the real shared runtime.
//   HashlineEditPlugin - Default production native hashline-edit plugin object.
//   default - Default export alias of HashlineEditPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [T-009 - Detects genuine Effect Schema codecs via Schema.isSchema before the isPlainRecord gate in nativeToolJsonSchema, so a callable effect@4 codec is converted through Schema.toJsonSchemaDocument instead of being rejected as non-plain-record.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { z } from "zod";
import { $ZodType, toJSONSchema } from "zod/v4/core";
import type { ToolContext as NativeToolContext } from "@opencode/plugin/promise/tool";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilyCapture } from "../../runtime/types.js";
import { ContractInputError, formatContractIssues } from "../../lib/agent-tool-contract.js";
import { findFirstChangedLine, summarizeEditDiff } from "./diff-summary.js";
import { applyHashlineEditsWithReport } from "./edit-operations.js";
import { canonicalizeFileText, restoreFileText } from "./file-text-canonicalization.js";
import { computeAnchorHash, computeLineHash } from "./hash-computation.js";
import { normalizeHashlineEdits } from "./normalize-edits.js";
import {
  parseHashlineEditPluginEntry,
  resolveEditMode,
  type EditMode,
  type HashlineEditPluginSettings,
} from "./routing.js";
import {
  hashlineEditContract,
  strReplaceEditorContract,
  validateHashlineEditToolInput,
  validateStrReplaceEditorToolInput,
  type HashlineEditToolArgs,
} from "./schemas.js";
import { SessionFileCache, SessionModelCache, type FileSnapshot } from "./session-state.js";
import {
  StrReplaceEditor,
  type StrReplaceEditorArgs,
  type StrReplaceEditorFs,
  type StrReplaceEditorFsEntry,
} from "./str-replace-editor.js";
import type { HashlineEdit } from "./types.js";
import { HashlineMismatchError } from "./validation.js";

const CONTENT_OPEN_TAG = "<content>";
const CONTENT_CLOSE_TAG = "</content>";
const FILE_OPEN_TAG = "<file>";
const FILE_CLOSE_TAG = "</file>";
const OPENCODE_LINE_TRUNCATION_SUFFIX = "... (line truncated to 2000 chars)";
const COLON_READ_LINE_PATTERN = /^\s*(\d+): ?(.*)$/;
const PIPE_READ_LINE_PATTERN = /^\s*(\d+)\| ?(.*)$/;

// START_BLOCK_ROUTING_CONSTANTS
// Native tools whose definitions the plugin may capture/restore.
const NATIVE_TOOL_NAMES = [
  "hashline_edit",
  "str_replace_editor",
  "edit",
  "write",
  "patch",
] as const;
// Existing-file editor tools whose visibility the selected mode governs. Native
// `write` is deliberately absent: baseline v1.7.0 never hid it, so new-file
// creation stays available alongside the one selected existing-file editor.
const HIDDEN_MODE_TOOLS = ["hashline_edit", "str_replace_editor", "edit", "patch"] as const;
// Native edit tools whose EXECUTION the mode enforces. `write` is always allowed
// (creation), matching the baseline.
const MANAGED_NATIVE_TOOLS = new Set(["edit", "patch"]);
const EDIT_TYPE_TOOLS = ["hashline_edit", "str_replace_editor"] as const;
type EditTypeTool = (typeof EDIT_TYPE_TOOLS)[number];

function isEditTypeTool(toolName: string): toolName is EditTypeTool {
  return (EDIT_TYPE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Tools that must be visible for a mode; canonical `apply_patch` maps to native
 * `patch` once. Native `write` stays for every mode except `apply_patch` (where
 * the native patch plugin itself owns file creation), preserving baseline
 * new-file creation next to the selected existing-file editor.
 */
function visibleToolsForMode(mode: EditMode): string[] {
  switch (mode) {
    case "hashline_edit":
      return ["hashline_edit", "write"];
    case "str_replace_editor":
      return ["str_replace_editor", "write"];
    case "edit":
      return ["edit", "write"];
    case "apply_patch":
      return ["patch"];
  }
}

interface NativeToolDefinition {
  readonly description: string;
  readonly input: unknown;
}

function isNativeToolDefinition(value: unknown): value is NativeToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { description?: unknown }).description === "string" &&
    "input" in (value as object)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize a genuine registered native tool input ValueSchema to JSON Schema
 * using only public SDK/Effect APIs, mirroring the pinned host projection.
 * Effect Schema codecs are detected first because an Effect codec is a callable
 * value, not a plain record; the plain-record gate below applies only to the
 * Standard JSON Schema (`~standard.jsonSchema.input`), Zod (`zod/v4/core`) and
 * literal JSON schema shapes.
 */
export function nativeToolJsonSchema(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) return undefined;
  if (Schema.isSchema(input)) {
    const document = Schema.toJsonSchemaDocument(input);
    const schema = document.schema as Record<string, unknown>;
    const definitions = document.definitions as Record<string, unknown> | undefined;
    return definitions !== undefined && Object.keys(definitions).length > 0
      ? { ...schema, $defs: definitions }
      : schema;
  }
  if (!isPlainRecord(input)) return undefined;
  const standard = (input as { "~standard"?: unknown })["~standard"];
  if (isPlainRecord(standard)) {
    const jsonSchema = (standard as { jsonSchema?: { input?: (options: unknown) => unknown } })
      .jsonSchema;
    if (jsonSchema !== undefined && typeof jsonSchema.input === "function") {
      const projected = jsonSchema.input({ target: "draft-2020-12" });
      if (isPlainRecord(projected)) return projected;
    }
    if (input instanceof $ZodType) {
      return toJSONSchema(input as never, { target: "draft-2020-12", io: "input" }) as Record<
        string,
        unknown
      >;
    }
    return input;
  }
  // A literal JSON schema is already in the host's expected shape.
  return input;
}

/** Capture genuine native tool definitions from the activated registry. */
export function captureNativeToolDefinitions(
  infos: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly input: unknown;
  }>,
  target: Map<string, NativeToolDefinition>,
): void {
  for (const info of infos) {
    const schema = nativeToolJsonSchema(info.input);
    if (schema !== undefined)
      target.set(info.name, { description: info.description, input: schema });
  }
}
// END_BLOCK_ROUTING_CONSTANTS

// START_BLOCK_PATH_BOUNDARY
/** Reject empty/whitespace-only caller paths before any location resolution. */
function requireNonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Mirror the pinned Windows shell-path normalization (no-op on non-Windows). */
function windowsPath(value: string): string {
  if (process.platform !== "win32") return value;
  return value
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`);
}

/**
 * Resolve one caller path against the trusted native invocation location exactly
 * once, mirroring pinned `FileAccess.resolvePath`: normalize Windows shell paths,
 * expand leading `~` against the trusted host home, then resolve relative to the
 * location directory. Absolute paths keep their contract.
 */
function normalizeTargetPath(baseDir: string, callerPath: string, hostHome: string): string {
  const normalized = windowsPath(callerPath);
  if (normalized === "~") return resolve(baseDir, hostHome);
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return resolve(baseDir, join(hostHome, normalized.slice(2)));
  }
  return resolve(baseDir, normalized);
}

/** Pinned `FSUtil.contains` semantics: `child` is `parent` or lexically inside it. */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Pinned `Project.root` semantics using metadata only: walk up from a directory
 * to the nearest ancestor containing a `.git`/`.hg` marker. It runs no git
 * command and never reads file content, so it cannot modify user git config.
 */
function findExternalProjectRoot(directory: string): string | undefined {
  let current = resolve(directory);
  const filesystemRoot = parse(current).root;
  for (;;) {
    for (const marker of [".git", ".hg"]) {
      try {
        if (existsSync(join(current, marker))) return current;
      } catch {
        // Unreadable directories are treated as no match.
      }
    }
    if (current === filesystemRoot) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

interface LocatedResource {
  readonly internal: boolean;
  readonly resource: string;
  readonly externalDirectory?: {
    readonly directory: string;
    readonly resource: string;
    readonly save: string;
  };
}

/**
 * Map one resolved absolute target to the pinned permission resources: native
 * internal scope is the current location plus its trusted project/worktree root
 * (except the filesystem root special case), producing a location-relative
 * resource; everything else is external and gets an `external_directory`
 * `<dir>/*` boundary with the absolute resource.
 */
function locateResource(
  locationDir: string,
  projectRoot: string | undefined,
  target: string,
  kind?: "file" | "directory",
): LocatedResource {
  const worktree = projectRoot === undefined ? undefined : resolve(projectRoot);
  const internal =
    containsPath(locationDir, target) ||
    (worktree !== undefined && worktree !== parse(worktree).root && containsPath(worktree, target));
  if (internal) {
    return {
      internal: true,
      resource: (relative(locationDir, target) || ".").split(sep).join("/"),
    };
  }
  const directory = kind === "directory" ? target : dirname(target);
  const outsideRoot = findExternalProjectRoot(directory) ?? directory;
  return {
    internal: false,
    resource: target.split(sep).join("/"),
    externalDirectory: {
      directory,
      resource: join(directory, "*").split(sep).join("/"),
      save: join(outsideRoot, "*").split(sep).join("/"),
    },
  };
}
// END_BLOCK_PATH_BOUNDARY

type ReadToolArgs = { filePath?: unknown; path?: unknown; file?: unknown };

interface EditTelemetry {
  editMode: EditMode;
  providerID?: string;
  modelID?: string;
}

/** Narrow native resource-permission guard awaited before writes. */
export interface HashlinePermissionGuard {
  guard<T>(
    input: {
      readonly sessionID: string;
      readonly action: string;
      readonly resources: ReadonlyArray<string>;
      readonly save?: ReadonlyArray<string> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly agent?: string | undefined;
      readonly source?:
        | { readonly type: "tool"; readonly messageID: string; readonly id: string }
        | undefined;
    },
    effect: () => Promise<T> | T,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<T>;
}

/** Injectable per-family routing settings, permission guard and diagnostics. */
export interface HashlineEditDependencies {
  settingsFor(sessionID: string): Promise<HashlineEditPluginSettings | undefined>;
  /** Trusted native invocation location (absolute directory) for a session. */
  locationFor(sessionID: string): Promise<string | undefined>;
  /** Trusted native project/worktree root for a session, when known. */
  projectRootFor(sessionID: string): Promise<string | undefined>;
  /** Trusted host home used to expand a leading `~`. */
  readonly hostHome: () => string;
  readonly permission: HashlinePermissionGuard;
  log(event: {
    readonly level: "info" | "warn" | "error";
    readonly message: string;
    readonly extra?: Record<string, unknown>;
  }): void;
}

interface NativeHookEvents {
  context: {
    sessionID: string;
    model?: { providerID?: unknown; id?: unknown };
    tools?: Record<string, unknown>;
  };
  modelRequest: { sessionID: string; model?: { providerID?: unknown; id?: unknown } };
  before: { tool: string; sessionID: string; input: unknown };
  after: {
    tool: string;
    sessionID: string;
    input: unknown;
    status: "completed" | "error";
    result?: { content?: unknown; output?: unknown; metadata?: Record<string, unknown> };
    error?: unknown;
  };
}

/** Native session/tool hook handlers plus the two native tool infos. */
export interface HashlineEditHandlers {
  readonly tools: {
    hashline_edit: {
      name: string;
      description: string;
      input: typeof hashlineEditContract.runtimeSchema;
      output: z.ZodString;
      options: { codemode: false };
      execute(
        input: unknown,
        context: NativeToolContext,
      ): Promise<{ output: string; content: string; metadata?: Record<string, unknown> }>;
    };
    str_replace_editor: {
      name: string;
      description: string;
      input: typeof strReplaceEditorContract.runtimeSchema;
      output: z.ZodString;
      options: { codemode: false };
      execute(
        input: unknown,
        context: NativeToolContext,
      ): Promise<{ output: string; content: string; metadata?: Record<string, unknown> }>;
    };
  };
  recordModel(event: NativeHookEvents["context"]): void;
  recordModelRequest(event: NativeHookEvents["modelRequest"]): void;
  sessionContext(event: NativeHookEvents["context"]): Promise<void>;
  before(event: NativeHookEvents["before"]): Promise<void>;
  after(event: NativeHookEvents["after"]): Promise<void>;
}

/** Handlers plus cleanup-owning dispose. */
export interface HashlineEditRegistration {
  readonly handlers: HashlineEditHandlers;
  dispose(): void;
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

/** Metadata-only target kind used to select the native external directory boundary. */
async function inferTargetKind(target: string): Promise<"file" | "directory"> {
  try {
    return (await stat(target)).isDirectory() ? "directory" : "file";
  } catch {
    return "file";
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

function canCreateFromMissingFile(edits: HashlineEdit[]): boolean {
  if (edits.length === 0) {
    return false;
  }
  return edits.every(
    (edit) => (edit.op === "append" || edit.op === "prepend") && edit.pos === undefined,
  );
}

function isReadTool(toolName: string): boolean {
  return toolName.toLowerCase() === "read";
}

function isTextFileOutput(output: string): boolean {
  const firstLine = output.split("\n")[0] ?? "";
  return COLON_READ_LINE_PATTERN.test(firstLine) || PIPE_READ_LINE_PATTERN.test(firstLine);
}

function hasNumberedReadLines(lines: readonly string[]): boolean {
  return lines.some((line) => parseReadLineParsed(line) !== null);
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

  // Native read text prepends a human summary header ("Read file <path>, lines
  // N-M"); anchors are still applicable when any numbered line is present.
  return isTextFileOutput(lines[0] ?? "") || hasNumberedReadLines(lines);
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

async function readSourceLinesAt(filePath: string): Promise<string[] | undefined> {
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
      if (!parsed) break;
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

  // Native read text prepends a summary header and may append a truncation
  // marker; transform the numbered block in place and keep every other line.
  const numberedStart = lines.findIndex((line) => parseReadLineParsed(line) !== null);
  if (numberedStart < 0) {
    if (!isTextFileOutput(lines[0] ?? "")) return output;
  }
  const contentLines = lines.slice(Math.max(numberedStart, 0));
  const parsedLines: ParsedReadLine[] = [];
  for (const line of contentLines) {
    const parsed = parseReadLineParsed(line);
    if (!parsed) break;
    parsedLines.push(parsed);
  }
  const result = formatReadLines(
    parsedLines,
    contentLines,
    sourceMatchesVisibleRows(sourceLines, parsedLines) ? sourceLines : undefined,
  );
  return [...lines.slice(0, Math.max(numberedStart, 0)), ...result].join("\n");
}
// END_BLOCK_FS_HELPERS

// START_BLOCK_EXECUTE
type PublishMetadata = (metadata: Record<string, unknown>) => Promise<void> | void;

async function executeHashlineEdit(
  args: HashlineEditToolArgs,
  telemetry: EditTelemetry,
  publish: PublishMetadata,
  baseDir: string,
  hostHome: string,
): Promise<string> {
  try {
    const validation = validateHashlineEditToolInput(args);
    if (!validation.ok) {
      return `Error: ${formatContractIssues(validation.issues)}`;
    }
    const requestedPath = requireNonEmptyPath(validation.data.filePath);
    if (requestedPath === undefined) {
      return "Error: filePath must be a non-empty path";
    }
    const sourcePath = normalizeTargetPath(baseDir, requestedPath, hostHome);
    const requestedRename = validation.data.rename;
    const renamePath =
      requestedRename === undefined
        ? undefined
        : normalizeTargetPath(
            baseDir,
            requireNonEmptyPath(requestedRename) ?? requestedRename,
            hostHome,
          );
    const deleteMode = validation.data.delete === true;

    const edits = deleteMode ? [] : normalizeHashlineEdits(validation.data.edits);
    const file = Bun.file(sourcePath);
    const exists = await file.exists();

    if (!exists && !deleteMode && !canCreateFromMissingFile(edits)) {
      return `Error: File not found: ${sourcePath}`;
    }

    if (deleteMode) {
      if (!exists) {
        return `Error: File not found: ${sourcePath}`;
      }
      await file.delete();
      return `Successfully deleted ${sourcePath}`;
    }

    const rawOldContent = exists ? Buffer.from(await file.arrayBuffer()).toString("utf8") : "";
    const oldEnvelope = canonicalizeFileText(rawOldContent);
    const applyResult = applyHashlineEditsWithReport(oldEnvelope.content, edits);
    const canonicalNewContent = applyResult.content;

    if (canonicalNewContent === oldEnvelope.content && renamePath === undefined) {
      let diagnostic = `No changes made to ${sourcePath}. The edits produced identical content.`;
      if (applyResult.noopEdits > 0) {
        diagnostic += ` No-op edits: ${applyResult.noopEdits}. Re-read the file and provide content that differs from the current lines.`;
      }
      return `Error: ${diagnostic}`;
    }

    const writeContent = restoreFileText(canonicalNewContent, oldEnvelope);
    const isMove = renamePath !== undefined && renamePath !== sourcePath;

    if (isMove && (await Bun.file(renamePath!).exists())) {
      return `Error: rename target already exists: ${renamePath}. Refusing to overwrite an existing file.`;
    }

    await Bun.write(sourcePath, writeContent);

    if (isMove) {
      await Bun.write(renamePath!, writeContent);
      await Bun.file(sourcePath).delete();
    }

    const effectivePath = isMove ? renamePath! : sourcePath;
    let metadataReportFailed = false;
    try {
      await publish({
        title: effectivePath,
        metadata: {
          filePath: effectivePath,
          path: effectivePath,
          file: effectivePath,
          noopEdits: applyResult.noopEdits,
          deduplicatedEdits: applyResult.deduplicatedEdits,
          firstChangedLine: findFirstChangedLine(oldEnvelope.content, canonicalNewContent),
          editMode: telemetry.editMode,
          providerID: telemetry.providerID,
          modelID: telemetry.modelID,
          filediff: {
            file: effectivePath,
            path: effectivePath,
            filePath: effectivePath,
            before: oldEnvelope.content,
            after: canonicalNewContent,
          },
        },
      });
    } catch {
      metadataReportFailed = true;
    }

    const diffSummary = summarizeEditDiff(oldEnvelope.content, canonicalNewContent);
    const firstChangedLine = findFirstChangedLine(oldEnvelope.content, canonicalNewContent);
    const stats = `+${diffSummary.additions}/-${diffSummary.deletions}${
      firstChangedLine !== undefined ? `, first change line ${firstChangedLine}` : ""
    }`;
    const headline = isMove
      ? `Moved ${sourcePath} to ${renamePath} (${stats})`
      : `Updated ${effectivePath} (${stats})`;
    const outputParts = [headline];
    if (metadataReportFailed) {
      outputParts.push(
        `Warning: the edit was applied to ${effectivePath} but reporting metadata failed; inspect the file before retrying.`,
      );
    }
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

async function executeStrReplaceEditor(
  args: StrReplaceEditorArgs,
  sessionID: string,
  fileCache: SessionFileCache,
  telemetry: EditTelemetry,
  publish: PublishMetadata,
  baseDir: string,
  hostHome: string,
): Promise<string> {
  const requestedPath = requireNonEmptyPath(args.path);
  if (requestedPath === undefined) {
    return "Error: path must be a non-empty path";
  }
  const targetPath = normalizeTargetPath(baseDir, requestedPath, hostHome);
  const resolvedArgs: StrReplaceEditorArgs = { ...args, path: targetPath };
  const editor = new StrReplaceEditor({
    fs: createNodeStrReplaceFs(),
    onViewed: (path, snapshot) => fileCache.record(sessionID, path, snapshot),
    checkFreshness: (path, current) => fileCache.check(sessionID, path, current),
  });

  const result = await editor.execute(resolvedArgs);
  if (!result.ok) {
    return `Error: ${result.error}`;
  }

  if (resolvedArgs.command !== "view") {
    try {
      await publish({
        title: targetPath,
        metadata: {
          filePath: targetPath,
          path: targetPath,
          file: targetPath,
          editMode: telemetry.editMode,
          providerID: telemetry.providerID,
          modelID: telemetry.modelID,
        },
      });
    } catch {
      return `${result.output}\nWarning: the edit was applied to ${targetPath} but reporting metadata failed; inspect the file before retrying.`;
    }
  }
  return result.output;
}
// END_BLOCK_EXECUTE

// START_BLOCK_HANDLERS
function modelOf(
  model: { providerID?: unknown; id?: unknown } | undefined,
): { providerID: string; modelID: string } | undefined {
  if (model === undefined) return undefined;
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined;
  return { providerID: model.providerID, modelID: model.id };
}

/** Build routing state, native hook handlers and the two native tool infos. */
export function createHashlineEditHandlers(
  deps: HashlineEditDependencies,
  options: { readonly nativeDefinitions?: Map<string, NativeToolDefinition> } = {},
): HashlineEditRegistration {
  const modelCache = new SessionModelCache();
  const fileCache = new SessionFileCache();
  const nativeDefinitions = options.nativeDefinitions ?? new Map<string, NativeToolDefinition>();

  const resolveMode = (sessionID: string, settings: HashlineEditPluginSettings): EditMode =>
    resolveEditMode(settings.routing, modelCache.get(sessionID));

  const requireLocation = async (sessionID: string): Promise<string | undefined> => {
    const directory = await deps.locationFor(sessionID);
    if (typeof directory !== "string" || directory.length === 0) return undefined;
    return resolve(directory);
  };

  const permissionSource = (context: NativeToolContext) => ({
    type: "tool" as const,
    messageID: String(context.messageID),
    id: String(context.id),
  });

  /**
   * Request the pinned file boundary before any effect. External targets first
   * obtain `external_directory` (`<dir>/*`) approval; reads then always request
   * `read` (location authority is not permission); edits request `edit` with
   * location-relative resources for internal targets and absolute resources for
   * external ones, `save: ["*"]`.
   */
  const requestFileEffect = async (
    context: NativeToolContext,
    baseDir: string,
    projectRoot: string | undefined,
    action: "edit" | "read",
    targets: ReadonlyArray<string>,
    tool: string,
    effect: () => Promise<string>,
    kind?: "file" | "directory",
  ): Promise<string> => {
    const located: LocatedResource[] = [];
    for (const target of targets) {
      const targetKind = kind ?? (await inferTargetKind(target));
      located.push(locateResource(baseDir, projectRoot, target, targetKind));
    }
    const seenBoundaries = new Set<string>();
    const externals = located
      .flatMap((entry) => (entry.externalDirectory === undefined ? [] : [entry.externalDirectory]))
      .filter((entry) => {
        if (seenBoundaries.has(entry.resource)) return false;
        seenBoundaries.add(entry.resource);
        return true;
      });
    const source = permissionSource(context);
    if (externals.length > 0) {
      await deps.permission.guard(
        {
          sessionID: context.sessionID,
          action: "external_directory",
          resources: externals.map((entry) => entry.resource),
          save: externals.map((entry) => entry.save),
          metadata: { tool, boundary: "external_directory" },
          ...(context.agent === undefined ? {} : { agent: String(context.agent) }),
          source,
        },
        () => undefined,
        { signal: context.signal },
      );
    }
    return deps.permission.guard(
      {
        sessionID: context.sessionID,
        action,
        resources: located.map((entry) => entry.resource),
        save: ["*"],
        metadata: { tool },
        ...(context.agent === undefined ? {} : { agent: String(context.agent) }),
        source,
      },
      effect,
      { signal: context.signal },
    );
  };

  const assertVisible = async (toolName: EditTypeTool, sessionID: string): Promise<void> => {
    const settings = await deps.settingsFor(sessionID);
    if (settings === undefined) {
      throw new Error(
        `${toolName} is not available for this session: no hashline-edit family policy is bound.`,
      );
    }
    if (!settings.enabled) {
      throw new Error(
        `${toolName} is not available for this session: the hashline-edit plugin is disabled for the captured policy.`,
      );
    }
    const mode = resolveMode(sessionID, settings);
    const visible = visibleToolsForMode(mode);
    if (visible.includes(toolName)) return;
    const preferred = visible[0] ?? "the host-provided edit tool";
    throw new Error(
      `${toolName} is not available for this session's model (edit mode: ${mode}). Use ${preferred} instead.`,
    );
  };

  const telemetryFor = async (sessionID: string): Promise<EditTelemetry> => {
    const settings = await deps.settingsFor(sessionID);
    const model = modelCache.get(sessionID);
    return {
      editMode: settings === undefined ? "edit" : resolveEditMode(settings.routing, model),
      providerID: model?.providerID,
      modelID: model?.modelID,
    };
  };

  const nativeResult = (
    output: string,
    metadata?: Record<string, unknown>,
  ): { output: string; content: string; metadata?: Record<string, unknown> } => ({
    output,
    content: output,
    ...(metadata === undefined ? {} : { metadata }),
  });

  const tools: HashlineEditHandlers["tools"] = {
    hashline_edit: {
      name: "hashline_edit",
      description: hashlineEditContract.description,
      input: hashlineEditContract.runtimeSchema,
      output: z.string(),
      options: { codemode: false },
      async execute(input, context) {
        await assertVisible("hashline_edit", context.sessionID);
        const validation = validateHashlineEditToolInput(input);
        if (!validation.ok) {
          // Structural/branch rejection returns an error result rather than a
          // retryable host failure; the host schema independently rejects before
          // the handler in production.
          return nativeResult(`Error: ${formatContractIssues(validation.issues)}`);
        }
        const baseDir = await requireLocation(context.sessionID);
        if (baseDir === undefined) {
          return nativeResult("Error: no trusted session location is available for this session");
        }
        const requestedPath = requireNonEmptyPath(validation.data.filePath);
        if (requestedPath === undefined) {
          return nativeResult("Error: filePath must be a non-empty path");
        }
        const hostHome = deps.hostHome();
        const projectRoot = await deps.projectRootFor(context.sessionID);
        const sourcePath = normalizeTargetPath(baseDir, requestedPath, hostHome);
        const renamePath =
          validation.data.rename === undefined
            ? undefined
            : normalizeTargetPath(
                baseDir,
                requireNonEmptyPath(validation.data.rename) ?? validation.data.rename,
                hostHome,
              );
        const telemetry = await telemetryFor(context.sessionID);
        const targets = renamePath === undefined ? [sourcePath] : [sourcePath, renamePath];
        const output = await requestFileEffect(
          context,
          baseDir,
          projectRoot,
          "edit",
          targets,
          "hashline_edit",
          () =>
            executeHashlineEdit(
              validation.data,
              telemetry,
              (u) => context.progress(u),
              baseDir,
              hostHome,
            ),
        );
        return nativeResult(output);
      },
    },
    str_replace_editor: {
      name: "str_replace_editor",
      description: strReplaceEditorContract.description,
      input: strReplaceEditorContract.runtimeSchema,
      output: z.string(),
      options: { codemode: false },
      async execute(input, context) {
        await assertVisible("str_replace_editor", context.sessionID);
        const validation = validateStrReplaceEditorToolInput(input);
        if (!validation.ok) {
          return nativeResult(`Error: ${formatContractIssues(validation.issues)}`);
        }
        const baseDir = await requireLocation(context.sessionID);
        if (baseDir === undefined) {
          return nativeResult("Error: no trusted session location is available for this session");
        }
        const requestedPath = requireNonEmptyPath(validation.data.path);
        if (requestedPath === undefined) {
          return nativeResult("Error: path must be a non-empty path");
        }
        const hostHome = deps.hostHome();
        const projectRoot = await deps.projectRootFor(context.sessionID);
        const targetPath = normalizeTargetPath(baseDir, requestedPath, hostHome);
        const telemetry = await telemetryFor(context.sessionID);
        const run = (): Promise<string> =>
          executeStrReplaceEditor(
            validation.data,
            context.sessionID,
            fileCache,
            telemetry,
            (u) => context.progress(u),
            baseDir,
            hostHome,
          );
        const output = await requestFileEffect(
          context,
          baseDir,
          projectRoot,
          validation.data.command === "view" ? "read" : "edit",
          [targetPath],
          "str_replace_editor",
          run,
        );
        return nativeResult(output);
      },
    },
  };

  const handlers: HashlineEditHandlers = {
    tools,
    recordModel(event) {
      const model = modelOf(event.model);
      if (model !== undefined) modelCache.set(event.sessionID, model);
    },
    recordModelRequest(event) {
      const model = modelOf(event.model);
      if (model !== undefined) modelCache.set(event.sessionID, model);
    },
    async sessionContext(event) {
      const model = modelOf(event.model);
      if (model !== undefined) modelCache.set(event.sessionID, model);
      const tools = event.tools;
      if (tools === undefined) return;
      // Capture whichever genuine native definitions this session exposes before
      // any mutation, so a host gate that removed one can still be overridden.
      for (const name of NATIVE_TOOL_NAMES) {
        const value = tools[name];
        if (isNativeToolDefinition(value)) nativeDefinitions.set(name, value);
      }
      const settings = await deps.settingsFor(event.sessionID);
      if (settings === undefined || !settings.enabled) {
        // Disabled/unbound: never force an edit mode; hide only the owned tools
        // and leave the host gate's native decision in place (including write).
        delete tools.hashline_edit;
        delete tools.str_replace_editor;
        return;
      }
      const mode = resolveMode(event.sessionID, settings);
      const desired = new Set(visibleToolsForMode(mode));
      for (const toolName of HIDDEN_MODE_TOOLS) {
        if (!desired.has(toolName)) delete tools[toolName];
      }
      // Ensure every desired tool is present; native write is restored for
      // creation when the host gate removed it, never fabricated.
      for (const toolName of desired) {
        if (tools[toolName] !== undefined) continue;
        const captured = nativeDefinitions.get(toolName);
        if (captured === undefined) {
          throw new Error(
            `hashline-edit: cannot expose native tool ${toolName} for edit mode ${mode}: no genuine native definition was observed.`,
          );
        }
        tools[toolName] = captured;
      }
    },
    async before(event) {
      if (isEditTypeTool(event.tool)) {
        // Visibility denial stays first: a tool this session's model must not use
        // is refused without exposing argument-level detail.
        await assertVisible(event.tool, event.sessionID);
        const validation =
          event.tool === "hashline_edit"
            ? validateHashlineEditToolInput(event.input)
            : validateStrReplaceEditorToolInput(event.input);
        if (!validation.ok) {
          throw new ContractInputError(event.tool, validation.issues);
        }
        return;
      }
      if (!MANAGED_NATIVE_TOOLS.has(event.tool)) return;
      const settings = await deps.settingsFor(event.sessionID);
      if (settings === undefined || !settings.enabled) return;
      const mode = resolveMode(event.sessionID, settings);
      if (!visibleToolsForMode(mode).includes(event.tool)) {
        throw new Error(
          `${event.tool} is not available for this session's model (edit mode: ${mode}); the session routing exposes a different edit tool.`,
        );
      }
    },
    async after(event) {
      // V2 triggers execute.after on errors too: a denied or failed native read
      // must not stat an unapproved file, establish freshness, or reread content.
      if (!isReadTool(event.tool)) return;
      if (event.status !== "completed" || event.result === undefined) return;
      const baseDir = await requireLocation(event.sessionID);
      const rawPath = readArgFilePath(event.input);
      const targetPath =
        baseDir !== undefined && rawPath !== undefined
          ? normalizeTargetPath(baseDir, rawPath, deps.hostHome())
          : undefined;
      // A successful native read always establishes freshness (needed by the
      // str_replace editor); anchoring additionally requires hashline mode.
      if (targetPath !== undefined) {
        const snapshot = await statSnapshot(targetPath);
        if (snapshot) fileCache.record(event.sessionID, targetPath, snapshot);
      }
      const settings = await deps.settingsFor(event.sessionID);
      if (settings === undefined || !settings.enabled) return;
      if (resolveMode(event.sessionID, settings) !== "hashline_edit") return;
      const sourceLines =
        targetPath === undefined ? undefined : await readSourceLinesAt(targetPath);
      const content = event.result.content;
      // Native Tool.Result.content is normalized to an array before execute.after.
      if (typeof content === "string") {
        if (isHashlineEligibleReadOutput(content)) {
          event.result.content = transformReadOutput(content, sourceLines);
        }
        return;
      }
      if (!Array.isArray(content)) return;
      let changed = false;
      const next = content.map((part) => {
        if (part === null || typeof part !== "object") return part;
        const record = part as { type?: unknown; text?: unknown };
        if (record.type !== "text" || typeof record.text !== "string") return part;
        if (!isHashlineEligibleReadOutput(record.text)) return part;
        changed = true;
        return { ...record, text: transformReadOutput(record.text, sourceLines) };
      });
      if (changed) event.result.content = next;
    },
  };

  return {
    handlers,
    dispose() {
      modelCache.clear();
      fileCache.clear();
    },
  };
}
// END_BLOCK_HANDLERS

// START_BLOCK_PLUGIN_ENTRY
/** Resolve captured per-family hashline-edit settings; unbound/disabled fails closed. */
async function resolveSettings(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<HashlineEditPluginSettings | undefined> {
  let capture: FamilyCapture | undefined;
  try {
    capture = await runtime.snapshots.configFor(sessionID);
  } catch {
    capture = undefined;
  }
  if (capture === undefined) {
    try {
      await runtime.snapshots.accept({ sessionID });
    } catch {
      // fall through to the second read
    }
    try {
      capture = await runtime.snapshots.configFor(sessionID);
    } catch {
      capture = undefined;
    }
  }
  if (capture === undefined) return undefined;
  try {
    return parseHashlineEditPluginEntry(capture.vvoc.plugins?.["hashline-edit"]);
  } catch {
    return undefined;
  }
}

function createConsoleLog(): HashlineEditDependencies["log"] {
  return (event) => {
    if (event.level === "info") return;
    console.error(
      `[hashline-edit][${event.level}] ${event.message}${
        event.extra === undefined ? "" : ` ${JSON.stringify(event.extra)}`
      }`.slice(0, 1000),
    );
  };
}

/** Narrow native client surface used only to read the trusted session location. */
interface HashlineLocationClient {
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<unknown>;
  };
}

export interface HashlineEditPluginOptions {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
}

/** Native hashline-edit plugin factory; the default export uses the real shared runtime. */
export function createHashlineEditPlugin(options: HashlineEditPluginOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.hashline-edit",
    setup: async (ctx) => {
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
      // Capture the genuine activated native tool definitions BEFORE any
      // per-session visibility gate runs, so a cold GPT->edit override can
      // restore the real native edit/write schema without a prior request.
      const seededNativeDefinitions = new Map<string, NativeToolDefinition>();
      try {
        captureNativeToolDefinitions(await ctx.tool.list(), seededNativeDefinitions);
      } catch {
        // A registry read failure leaves the map empty; visibility then refuses
        // (honest incompatibility) rather than fabricating a schema.
      }
      // The trusted invocation location is the host session's location; the
      // plugin's own location is only a fallback when the session cannot be read.
      let clientPromise: Promise<unknown> | undefined;
      const locationFor = async (sessionID: string): Promise<string | undefined> => {
        try {
          const client = (await (clientPromise ??=
            runtime.client())) as unknown as HashlineLocationClient;
          const info = (await client.session.get({ sessionID })) as {
            location?: { directory?: unknown };
          };
          const directory = info?.location?.directory;
          if (typeof directory === "string" && directory.length > 0) return directory;
        } catch {
          // fall through to the plugin location
        }
        return ctx.location?.directory;
      };
      const registration = createHashlineEditHandlers(
        {
          settingsFor: (sessionID) => resolveSettings(runtime, sessionID),
          locationFor,
          projectRootFor: async () => ctx.location?.project?.directory ?? ctx.location?.directory,
          hostHome: () => process.env.OPENCODE_TEST_HOME ?? homedir(),
          permission: runtime.permissions,
          log: createConsoleLog(),
        },
        { nativeDefinitions: seededNativeDefinitions },
      );
      const h = registration.handlers;
      const toolRegistration = await ctx.tool.transform((editor) => {
        editor.add(h.tools.hashline_edit);
        editor.add(h.tools.str_replace_editor);
      });
      const beforeRegistration = await ctx.tool.hook("execute.before", (event) =>
        h.before(event as never),
      );
      const afterRegistration = await ctx.tool.hook("execute.after", (event) =>
        h.after(event as never),
      );
      const contextRegistration = await ctx.session.hook("context", (event) =>
        h.sessionContext(event as never),
      );
      const compactionRegistration = await ctx.session.hook("compaction", (event) =>
        h.sessionContext(event as never),
      );
      const generateRegistration = await ctx.session.hook("generate", (event) =>
        h.sessionContext(event as never),
      );
      const modelRegistration = await ctx.session.hook("model.request", (event) =>
        h.recordModelRequest(event as never),
      );
      return async () => {
        await modelRegistration.dispose();
        await generateRegistration.dispose();
        await compactionRegistration.dispose();
        await contextRegistration.dispose();
        await afterRegistration.dispose();
        await beforeRegistration.dispose();
        await toolRegistration.dispose();
        registration.dispose();
        await runtime.release();
      };
    },
  });
}

export const HashlineEditPlugin: Plugin.Plugin = createHashlineEditPlugin();
export default HashlineEditPlugin;
// END_BLOCK_PLUGIN_ENTRY
