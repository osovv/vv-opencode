// FILE: src/plugins/hashline-edit/index.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Override OpenCode's default `edit` tool with a hash-anchored edit implementation and hash-aware read output with context-anchored hash references.
//   SCOPE: Hashline-backed edit tool registration, read-output transformation with anchor hashes, anchor validation, file mutation execution, and success metadata emission.
//   DEPENDS: [@opencode-ai/plugin, src/plugins/hashline-edit/edit-operations.ts, src/plugins/hashline-edit/file-text-canonicalization.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/normalize-edits.ts, src/plugins/hashline-edit/tool-description.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HashlineEditPlugin - Registers the hash-anchored `edit` tool override and post-read output enhancer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Read output now emits context-anchored hashes (line#hash#anchor|content) for collision-resistant edit anchors.]
// END_CHANGE_SUMMARY

import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin";
import { applyHashlineEditsWithReport } from "./edit-operations.js";
import { canonicalizeFileText, restoreFileText } from "./file-text-canonicalization.js";
import { formatHashAnchoredLine } from "./hash-computation.js";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./normalize-edits.js";
import { HASHLINE_EDIT_DESCRIPTION } from "./tool-description.js";
import type { HashlineEdit } from "./types.js";
import { HashlineMismatchError } from "./validation.js";

const z = tool.schema;
const CONTENT_OPEN_TAG = "<content>";
const CONTENT_CLOSE_TAG = "</content>";
const FILE_OPEN_TAG = "<file>";
const FILE_CLOSE_TAG = "</file>";
const OPENCODE_LINE_TRUNCATION_SUFFIX = "... (line truncated to 2000 chars)";
const COLON_READ_LINE_PATTERN = /^\s*(\d+): ?(.*)$/;
const PIPE_READ_LINE_PATTERN = /^\s*(\d+)\| ?(.*)$/;

type HashlineEditArgs = {
  filePath: string;
  edits: RawHashlineEdit[];
  delete?: boolean;
  rename?: string;
};

function canCreateFromMissingFile(edits: HashlineEdit[]): boolean {
  if (edits.length === 0) {
    return false;
  }
  return edits.every(
    (edit) => (edit.op === "append" || edit.op === "prepend") && edit.pos === undefined,
  );
}

function findFirstChangedLine(beforeContent: string, afterContent: string): number | undefined {
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) {
      return index + 1;
    }
  }
  return undefined;
}

function publishSuccessMetadata(args: {
  context: ToolContext;
  filePath: string;
  beforeContent: string;
  afterContent: string;
  noopEdits: number;
  deduplicatedEdits: number;
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

function formatReadLines(parsedLines: ParsedReadLine[], rawLines: string[]): string[] {
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

    const prevContent = parsedIndex > 0 ? parsedLines[parsedIndex - 1]?.content : undefined;
    const nextContent =
      parsedIndex + 1 < parsedLines.length ? parsedLines[parsedIndex + 1]?.content : undefined;
    result.push(
      formatHashAnchoredLine(parsed.lineNumber, parsed.content, prevContent, nextContent),
    );
    parsedIndex += 1;
  }

  return result;
}

function transformReadOutput(output: string): string {
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
    const result = formatReadLines(parsedLines, fileLines);

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
  const result = formatReadLines(parsedLines, lines);
  return result.join("\n");
}

async function executeHashlineEdit(args: HashlineEditArgs, context: ToolContext): Promise<string> {
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
    await Bun.write(filePath, writeContent);

    if (rename && rename !== filePath) {
      await Bun.write(rename, writeContent);
      await Bun.file(filePath).delete();
    }

    const effectivePath = rename && rename !== filePath ? rename : filePath;
    publishSuccessMetadata({
      context,
      filePath: effectivePath,
      beforeContent: oldEnvelope.content,
      afterContent: canonicalNewContent,
      noopEdits: applyResult.noopEdits,
      deduplicatedEdits: applyResult.deduplicatedEdits,
    });

    return rename && rename !== filePath
      ? `Moved ${filePath} to ${rename}`
      : `Updated ${effectivePath}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HashlineMismatchError) {
      return `Error: hash mismatch - ${message}\nTip: reuse LINE#ID entries from the latest read output or mismatch snippet, or batch related edits in one call.`;
    }
    return `Error: ${message}`;
  }
}

export const HashlineEditPlugin: Plugin = async () => {
  return {
    "tool.execute.after": async (input, output) => {
      if (!isReadTool(input.tool) || typeof output.output !== "string") {
        return;
      }
      output.output = transformReadOutput(output.output);
    },
    tool: {
      edit: tool({
        description: HASHLINE_EDIT_DESCRIPTION,
        args: {
          filePath: z.string().describe("Absolute path to the file to edit"),
          delete: z.boolean().optional().describe("Delete the file instead of editing it"),
          rename: z.string().optional().describe("Rename the file after edits are applied"),
          edits: z
            .array(
              z.object({
                op: z.enum(["replace", "append", "prepend"]),
                pos: z.string().optional().describe("Primary anchor in LINE#HASH format"),
                end: z.string().optional().describe("Inclusive range end in LINE#HASH format"),
                lines: z
                  .union([z.array(z.string()), z.string(), z.null()])
                  .describe("Replacement or inserted lines as plain text content"),
              }),
            )
            .describe("Hash-anchored edit operations to apply to the file"),
        },
        execute: (args, context) => executeHashlineEdit(args, context),
      }),
    },
  };
};
