// FILE: src/plugins/secrets-redaction/stream.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Restore placeholders that arrive split across streamed provider text deltas while preserving opaque, binary and tool-protocol frames byte-for-byte.
//   SCOPE: Bounded carry-aware text restoration, SSE `data:` event decoding for recognized OpenAI chat/Responses, Anthropic and Gemini text shapes (streaming and non-streaming), per-lane carries scoped by response/choice/block/item/channel identity, lane-scoped terminal handling (block/choice/item end flushes only that lane; [DONE]/response.completed/message_stop ends the response), minimal single-lane carry synthesis that never duplicates sibling lanes, bounded line/lane/pending buffers, WebSocket TEXT-frame restoration that shares one long-lived line stream across frames (a partial line, event or lane carry survives frame boundaries; reset only on a recognized global terminal), and safe buffered restoration for non-SSE JSON/text responses. Unknown or unrecognized frames and original separators pass through unchanged; the module never regex-rewrites a whole JSON document and never appends free text to a protocol stream.
//   DEPENDS: [src/plugins/secrets-redaction/session.ts, src/plugins/secrets-redaction/restore.ts]
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION, DF-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLACEHOLDER_PREFIX_TOKEN - Placeholder prefix used to detect split placeholders.
//   TextDeltaRestorer - Carry-aware text restorer that withholds an incomplete placeholder tail.
//   SseRestoreStream - Line-buffered SSE transformer with lane-scoped carries and terminals.
//   createSseRestoreStream - Build an SSE restore transformer for one session's mapping.
//   restoreNonSseBody - Restore recognized text in a complete non-SSE JSON/text body.
//   createResponseByteTransform - Pick SSE or buffered JSON/text restoration by content type.
//   FrameRestoreState - Persistent per-connection frame carries reset only on a recognized terminal.
//   createFrameRestoreState - Build per-connection frame restore state.
//   restoreProviderFrame - Restore one WebSocket TEXT frame over a long-lived line/lane carry.
//   createSseByteTransform - Byte-level SSE transform stream restoring split placeholders.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE wi-7 - WebSocket TEXT frames now share one long-lived line stream: a partial line/event/lane carry survives frame boundaries and is reset only on a recognized global terminal, so a placeholder split across frames restores and no newline is injected into a mid-line frame; a complete unterminated `data:` JSON line is re-serialized with its canonical newline.]
// END_CHANGE_SUMMARY

import { restoreText } from "./restore.js";
import type { PlaceholderSession } from "./session.js";

/** Placeholder prefix used to detect split placeholders. */
export const PLACEHOLDER_PREFIX_TOKEN = "__VVOC_SECRET_";

const MAX_CARRY_CHARS = 96;
const MAX_LINE_BUFFER_CHARS = 64 * 1024;
const MAX_PENDING_TERMINAL_CHARS = 64 * 1024;
const MAX_LANES = 64;
const MAX_BUFFERED_RESPONSE_CHARS = 8 * 1024 * 1024;
const COMPLETE_PLACEHOLDER_RE = /^__VVOC_SECRET_[A-Z_]+_[0-9a-f]{12}(?:_\d+)?__$/;
const PARTIAL_PLACEHOLDER_RE = /^__VVOC_SECRET_[A-Z_]*(?:_[0-9a-f]{0,12}(?:_\d{0,6})?_{0,2})?$/;
const GLOBAL_PLACEHOLDER_RE = /__VVOC_SECRET_[A-Z_]+_[0-9a-f]{12}(?:_\d+)?__/g;

// START_BLOCK_TEXT_RESTORER
/** True when `value` is a non-empty, incomplete prefix of a valid placeholder. */
function isPlaceholderFragment(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CARRY_CHARS) return false;
  if (COMPLETE_PLACEHOLDER_RE.test(value)) return false;
  if (PLACEHOLDER_PREFIX_TOKEN.startsWith(value)) return true;
  if (!value.startsWith(PLACEHOLDER_PREFIX_TOKEN)) return false;
  return PARTIAL_PLACEHOLDER_RE.test(value);
}

/** End index of the last complete placeholder in `value`, or 0. */
function lastCompletePlaceholderEnd(value: string): number {
  let end = 0;
  GLOBAL_PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GLOBAL_PLACEHOLDER_RE.exec(value)) !== null) {
    end = match.index + match[0].length;
  }
  return end;
}

/**
 * Longest suffix that is an incomplete placeholder fragment, scanning only past
 * the last complete placeholder so the closing `__` of a complete placeholder is
 * never mistaken for a new partial prefix.
 */
function findCarryStart(value: string): number | undefined {
  const from = lastCompletePlaceholderEnd(value);
  for (let index = from; index < value.length; index += 1) {
    if (value.length - index > MAX_CARRY_CHARS) continue;
    if (isPlaceholderFragment(value.slice(index))) return index;
  }
  return undefined;
}

/**
 * Carry-aware text restorer. Emits restored text up to the longest safe
 * boundary and retains an incomplete trailing placeholder prefix until the next
 * push (or flush) completes or abandons it. A complete trailing placeholder is
 * always emitted restored, never carried.
 */
export class TextDeltaRestorer {
  private carry = "";

  constructor(private readonly session: PlaceholderSession) {}

  push(text: string): string {
    const combined = this.carry + text;
    const start = findCarryStart(combined);
    if (start === undefined) {
      this.carry = "";
      return restoreText(combined, this.session);
    }
    this.carry = combined.slice(start);
    return restoreText(combined.slice(0, start), this.session);
  }

  flush(): string {
    if (this.carry === "") return "";
    const pending = restoreText(this.carry, this.session);
    this.carry = "";
    return pending;
  }

  get pending(): boolean {
    return this.carry !== "";
  }
}
// END_BLOCK_TEXT_RESTORER

// START_BLOCK_RECOGNIZERS
type JsonObject = Record<string, unknown>;
type PathSegment = string | number;

interface TextTarget {
  readonly lane: string;
  readonly path: ReadonlyArray<PathSegment>;
  /** Build a minimal single-lane frame carrying only this lane's text delta. */
  readonly makeFrame: (text: string) => JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Drop undefined fields so a synthesized frame carries only real protocol fields. */
function compact(value: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function setByPath(root: unknown, path: ReadonlyArray<PathSegment>, value: string): void {
  let cursor: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (cursor === null || typeof cursor !== "object") return;
    cursor = (cursor as Record<PathSegment, unknown>)[path[index]!];
  }
  if (cursor === null || typeof cursor !== "object") return;
  (cursor as Record<PathSegment, unknown>)[path[path.length - 1]!] = value;
}

function getByPath(root: unknown, path: ReadonlyArray<PathSegment>): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<PathSegment, unknown>)[segment];
  }
  return cursor;
}

/** Collect recognized provider text fields with a lane-scoped path and minimal frame builder. */
function collectTextTargets(obj: JsonObject): TextTarget[] {
  const targets: TextTarget[] = [];
  const type = obj.type;

  // OpenAI Responses streaming and event shapes.
  if (typeof type === "string" && type.startsWith("response.") && typeof obj.delta === "string") {
    const identity = asString(obj.item_id) ?? asString(obj.output_index) ?? "";
    const content = asString(obj.content_index) ?? "";
    targets.push({
      lane: `responses:${identity}:${content}:${type}`,
      path: ["delta"],
      makeFrame: (text) =>
        compact({
          type,
          item_id: obj.item_id,
          output_index: obj.output_index,
          content_index: obj.content_index,
          delta: text,
        }),
    });
  }
  // OpenAI Responses non-streaming output array.
  if (isArray(obj.output)) {
    obj.output.forEach((item, itemIndex) => {
      if (!isObject(item) || !isArray(item.content)) return;
      item.content.forEach((part, partIndex) => {
        if (!isObject(part) || typeof part.text !== "string") return;
        targets.push({
          lane: `responses-out:${itemIndex}:${partIndex}`,
          path: ["output", itemIndex, "content", partIndex, "text"],
          makeFrame: (text) => ({
            output: [{ content: [{ type: "output_text", text }] }],
          }),
        });
      });
    });
  }

  // OpenAI chat streaming deltas and non-streaming messages.
  if (isArray(obj.choices)) {
    obj.choices.forEach((choice, choiceIndex) => {
      if (!isObject(choice)) return;
      const delta = choice.delta;
      if (isObject(delta)) {
        if (typeof delta.content === "string") {
          targets.push({
            lane: `chat:${choiceIndex}:content`,
            path: ["choices", choiceIndex, "delta", "content"],
            makeFrame: (text) =>
              compact({
                id: obj.id,
                object: obj.object,
                created: obj.created,
                model: obj.model,
                choices: [{ index: choiceIndex, delta: { content: text }, finish_reason: null }],
              }),
          });
        }
        if (typeof delta.reasoning_content === "string") {
          targets.push({
            lane: `chat:${choiceIndex}:reasoning`,
            path: ["choices", choiceIndex, "delta", "reasoning_content"],
            makeFrame: (text) =>
              compact({
                id: obj.id,
                object: obj.object,
                created: obj.created,
                model: obj.model,
                choices: [
                  { index: choiceIndex, delta: { reasoning_content: text }, finish_reason: null },
                ],
              }),
          });
        }
      }
      const message = choice.message;
      if (isObject(message)) {
        if (typeof message.content === "string") {
          targets.push({
            lane: `chat-msg:${choiceIndex}:content`,
            path: ["choices", choiceIndex, "message", "content"],
            makeFrame: (text) =>
              compact({
                id: obj.id,
                object: obj.object,
                created: obj.created,
                model: obj.model,
                choices: [
                  {
                    index: choiceIndex,
                    message: { role: asString(message.role) ?? "assistant", content: text },
                    finish_reason: asString(choice.finish_reason) ?? "stop",
                  },
                ],
              }),
          });
        }
        if (typeof message.reasoning_content === "string") {
          targets.push({
            lane: `chat-msg:${choiceIndex}:reasoning`,
            path: ["choices", choiceIndex, "message", "reasoning_content"],
            makeFrame: (text) =>
              compact({
                id: obj.id,
                object: obj.object,
                created: obj.created,
                model: obj.model,
                choices: [
                  {
                    index: choiceIndex,
                    message: {
                      role: asString(message.role) ?? "assistant",
                      reasoning_content: text,
                    },
                    finish_reason: asString(choice.finish_reason) ?? "stop",
                  },
                ],
              }),
          });
        }
      }
    });
  }

  // Anthropic streaming content_block_delta and non-streaming content blocks.
  const delta = obj.delta;
  if (isObject(delta)) {
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      targets.push({
        lane: `anthropic:${asString(obj.index) ?? "0"}:text`,
        path: ["delta", "text"],
        makeFrame: (text) => ({
          type: "content_block_delta",
          index: obj.index,
          delta: { type: "text_delta", text },
        }),
      });
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      targets.push({
        lane: `anthropic:${asString(obj.index) ?? "0"}:thinking`,
        path: ["delta", "thinking"],
        makeFrame: (text) => ({
          type: "content_block_delta",
          index: obj.index,
          delta: { type: "thinking_delta", thinking: text },
        }),
      });
    }
  }
  if (isArray(obj.content)) {
    obj.content.forEach((block, blockIndex) => {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return;
      targets.push({
        lane: `anthropic-msg:${blockIndex}`,
        path: ["content", blockIndex, "text"],
        makeFrame: (text) => ({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        }),
      });
    });
  }

  // Gemini streaming and non-streaming candidates.
  if (isArray(obj.candidates)) {
    obj.candidates.forEach((candidate, candidateIndex) => {
      if (
        !isObject(candidate) ||
        !isObject(candidate.content) ||
        !isArray(candidate.content.parts)
      ) {
        return;
      }
      candidate.content.parts.forEach((part, partIndex) => {
        if (!isObject(part) || typeof part.text !== "string") return;
        targets.push({
          lane: `gemini:${candidateIndex}:${partIndex}`,
          path: ["candidates", candidateIndex, "content", "parts", partIndex, "text"],
          makeFrame: (text) => ({
            candidates: [{ content: { parts: [{ text }] } }],
          }),
        });
      });
    });
  }

  return targets;
}

/** Lane keys ended by a non-global block/choice/item terminal frame. */
function endedLaneKeys(obj: JsonObject): string[] {
  const lanes: string[] = [];
  if (obj.type === "content_block_stop") {
    const index = asString(obj.index) ?? "0";
    lanes.push(`anthropic:${index}:text`, `anthropic:${index}:thinking`);
  }
  if (isArray(obj.choices)) {
    obj.choices.forEach((choice, choiceIndex) => {
      if (
        !isObject(choice) ||
        choice.finish_reason === null ||
        choice.finish_reason === undefined
      ) {
        return;
      }
      lanes.push(
        `chat:${choiceIndex}:content`,
        `chat:${choiceIndex}:reasoning`,
        `chat-msg:${choiceIndex}:content`,
        `chat-msg:${choiceIndex}:reasoning`,
      );
    });
  }
  if (obj.type === "response.output_text.done" || obj.type === "response.content_part.done") {
    const identity = asString(obj.item_id) ?? asString(obj.output_index) ?? "";
    const content = asString(obj.content_index) ?? "";
    lanes.push(`responses:${identity}:${content}:response.output_text.delta`);
  }
  return lanes;
}

/** True when a recognized provider JSON object terminates the whole response. */
function isGlobalTerminalObject(obj: JsonObject): boolean {
  const type = obj.type;
  return type === "response.completed" || type === "message_stop";
}

/** Restore every recognized text field in a complete (non-streaming) JSON body. */
function restoreCompleteJson(obj: JsonObject, session: PlaceholderSession): boolean {
  let changed = false;
  for (const target of collectTextTargets(obj)) {
    const value = getByPath(obj, target.path);
    if (typeof value !== "string") continue;
    const restored = restoreText(value, session);
    if (restored !== value) {
      setByPath(obj, target.path, restored);
      changed = true;
    }
  }
  return changed;
}
// END_BLOCK_RECOGNIZERS

// START_BLOCK_SSE_STREAM
interface LaneTemplate {
  readonly eventName?: string;
  readonly makeFrame: (text: string) => JsonObject;
}

/**
 * Line-buffered SSE transform. Only recognized `data:` JSON events are
 * re-serialized with restored text; every other line (event names, ids,
 * comments, opaque or malformed payloads) is emitted with its original bytes
 * and separator. Carries are scoped by lane identity. A block/choice/item end
 * flushes only that lane as a minimal single-lane delta before the terminal
 * frame; only `[DONE]`/`response.completed`/`message_stop` ends the response and
 * holds a bounded tail. No free text is ever appended to the protocol stream.
 */
export class SseRestoreStream {
  private lineBuffer = "";
  private pendingTerminal = "";
  private pendingEventLine: string | undefined;
  private terminalSeen = false;
  private currentEventName: string | undefined;
  private readonly restorers = new Map<string, TextDeltaRestorer>();
  private readonly templates = new Map<string, LaneTemplate>();

  constructor(private readonly session: PlaceholderSession) {}

  private restorerFor(lane: string): TextDeltaRestorer {
    let restorer = this.restorers.get(lane);
    if (restorer === undefined) {
      restorer = new TextDeltaRestorer(this.session);
      this.restorers.set(lane, restorer);
    }
    return restorer;
  }

  private flushLane(lane: string): string {
    const restorer = this.restorers.get(lane);
    const template = this.templates.get(lane);
    if (restorer === undefined || template === undefined || !restorer.pending) return "";
    const pending = restorer.flush();
    if (pending === "") return "";
    const prefix = template.eventName === undefined ? "" : `event: ${template.eventName}\n`;
    return `${prefix}data: ${JSON.stringify(template.makeFrame(pending))}\n\n`;
  }

  private flushLanes(keys: Iterable<string>): string {
    let output = "";
    for (const lane of keys) output += this.flushLane(lane);
    return output;
  }

  private flushLanesByPrefix(prefix: string): string {
    let output = "";
    for (const lane of this.restorers.keys()) {
      if (lane.startsWith(prefix)) output += this.flushLane(lane);
    }
    return output;
  }

  private flushAllLanes(): string {
    return this.flushLanes(this.restorers.keys());
  }

  private evictLanesIfNeeded(): string {
    if (this.restorers.size < MAX_LANES) return "";
    // Flush pending suffixes before eviction so no ordinary text is dropped.
    return this.flushAllLanes();
  }

  private transformDataLine(line: string, terminator: string): { prefix: string; output: string } {
    const match = /^(data:(?: )?)(.*)$/.exec(line);
    const unchanged = { prefix: "", output: `${line}${terminator}` };
    if (match === null) return unchanged;
    const payload = match[2] ?? "";
    if (payload === "" || payload === "[DONE]") return unchanged;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return unchanged;
    }
    if (!isObject(parsed)) return unchanged;

    const targets = collectTextTargets(parsed);
    const ended = endedLaneKeys(parsed);
    let prefix = ended.length === 0 ? "" : this.flushLanes(ended);
    if (targets.length === 0) return { prefix, output: `${line}${terminator}` };

    prefix += this.evictLanesIfNeeded();
    for (const target of targets) {
      const value = getByPath(parsed, target.path);
      if (typeof value !== "string") continue;
      setByPath(parsed, target.path, this.restorerFor(target.lane).push(value));
      this.templates.set(target.lane, {
        eventName: this.currentEventName,
        makeFrame: target.makeFrame,
      });
    }
    return { prefix, output: `${match[1]}${JSON.stringify(parsed)}${terminator}` };
  }

  /** Emit a held `event:` line so it stays adjacent to its own `data:` line. */
  private takePendingEventLine(): string {
    if (this.pendingEventLine === undefined) return "";
    const line = `${this.pendingEventLine}\n`;
    this.pendingEventLine = undefined;
    return line;
  }

  private isGlobalTerminalLine(line: string): boolean {
    if (line.startsWith("event: message_stop")) return true;
    const match = /^data:(?: )?(.*)$/.exec(line);
    if (match === null) return false;
    const payload = match[1] ?? "";
    if (payload === "[DONE]") return true;
    try {
      const parsed = JSON.parse(payload);
      return isObject(parsed) && isGlobalTerminalObject(parsed);
    } catch {
      return false;
    }
  }

  push(chunk: string): string {
    this.lineBuffer += chunk;
    let output = "";
    for (;;) {
      const newlineIndex = this.lineBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const rawLine = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      const terminator = rawLine.endsWith("\r") ? "\r\n" : "\n";
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (this.terminalSeen) {
        this.pendingTerminal += `${rawLine}\n`;
        continue;
      }
      if (this.isGlobalTerminalLine(line)) {
        // Emit every lane's carry before holding the bounded response tail.
        output += this.flushAllLanes();
        this.terminalSeen = true;
        this.pendingTerminal += `${rawLine}\n`;
        continue;
      }
      if (/^event:(?: |$)/.test(line)) {
        output += this.takePendingEventLine();
        this.pendingEventLine = rawLine;
        this.currentEventName = line.slice(line.indexOf(":") + 1).trim() || undefined;
        continue;
      }
      if (line === "") {
        output += this.takePendingEventLine();
        this.currentEventName = undefined;
        output += `${rawLine}\n`;
        continue;
      }
      if (/^data:(?: |$)/.test(line)) {
        const transformed = this.transformDataLine(line, terminator);
        output += transformed.prefix;
        output += this.takePendingEventLine();
        output += transformed.output;
        continue;
      }
      output += this.takePendingEventLine();
      output += `${rawLine}\n`;
    }
    if (this.lineBuffer.length > MAX_LINE_BUFFER_CHARS) {
      output += this.lineBuffer;
      this.lineBuffer = "";
    }
    if (this.pendingTerminal.length > MAX_PENDING_TERMINAL_CHARS) {
      output += this.pendingTerminal;
      this.pendingTerminal = "";
    }
    return output;
  }

  /** True once a global response terminal (`[DONE]`/completed/message_stop) was seen. */
  get terminal(): boolean {
    return this.terminalSeen;
  }

  /**
   * Process the trailing buffered line only when it is already a complete,
   * recognized `data:` payload. Used by frame-oriented transports (WebSocket)
   * where a complete JSON line may arrive without a terminating newline; the
   * line is re-serialized with its canonical newline, never with raw bytes
   * spliced into a mid-line frame. Incomplete or unrecognized buffers are left
   * untouched so streaming carry survives until the real terminal/end.
   */
  drainUnterminatedLine(): string {
    if (this.terminalSeen) return "";
    const line = this.lineBuffer;
    if (line === "" || line.includes("\n")) return "";
    const match = /^data:(?: )?(.*)$/.exec(line);
    if (match === null) return "";
    const payload = match[1] ?? "";
    if (payload !== "[DONE]") {
      try {
        if (!isObject(JSON.parse(payload))) return "";
      } catch {
        return "";
      }
    }
    this.lineBuffer = "";
    if (this.isGlobalTerminalLine(line)) {
      const output = this.flushAllLanes();
      this.terminalSeen = true;
      this.pendingTerminal += `${line}\n`;
      return output;
    }
    const transformed = this.transformDataLine(line, "\n");
    return transformed.prefix + this.takePendingEventLine() + transformed.output;
  }

  flush(): string {
    let output = this.flushAllLanes();
    output += this.takePendingEventLine();
    output += this.pendingTerminal;
    this.pendingTerminal = "";
    if (this.lineBuffer !== "") {
      output += this.lineBuffer;
      this.lineBuffer = "";
    }
    this.templates.clear();
    this.restorers.clear();
    this.terminalSeen = false;
    this.currentEventName = undefined;
    return output;
  }
}

/** Build a line-buffered SSE restore stream for one session's placeholder mapping. */
export function createSseRestoreStream(session: PlaceholderSession): SseRestoreStream {
  return new SseRestoreStream(session);
}

/** Build a byte-level SSE transform stream that restores split placeholders. */
export function createSseByteTransform(
  session: PlaceholderSession,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const stream = new SseRestoreStream(session);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) controller.enqueue(encoder.encode(stream.push(text)));
    },
    flush(controller) {
      const tail = decoder.decode();
      const text = tail.length > 0 ? stream.push(tail) : "";
      const flushed = stream.flush();
      const combined = `${text}${flushed}`;
      if (combined.length > 0) controller.enqueue(encoder.encode(combined));
    },
  });
}

/**
 * Restore a non-SSE response body. JSON bodies are parsed and recognized text
 * fields rewritten; plain text bodies are restored directly; anything else
 * (binary, oversized, malformed) is returned byte-for-byte unchanged.
 */
export function restoreNonSseBody(session: PlaceholderSession, body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (isObject(parsed)) {
        return restoreCompleteJson(parsed, session) ? JSON.stringify(parsed) : body;
      }
      if (Array.isArray(parsed)) {
        let changed = false;
        for (const entry of parsed) {
          if (isObject(entry) && restoreCompleteJson(entry, session)) changed = true;
        }
        return changed ? JSON.stringify(parsed) : body;
      }
      return body;
    } catch {
      return body;
    }
  }
  if (body.includes("\u0000")) return body;
  return restoreText(body, session);
}

/** Pick SSE or buffered JSON/text restoration for one HTTP response body. */
export function createResponseByteTransform(
  session: PlaceholderSession,
  contentType: string,
): TransformStream<Uint8Array, Uint8Array> {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return createSseByteTransform(session);
  }
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  let buffer = "";
  let overflowed = false;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (overflowed) {
        controller.enqueue(chunk);
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_BUFFERED_RESPONSE_CHARS) {
        overflowed = true;
        controller.enqueue(encoder.encode(buffer));
        buffer = "";
      }
    },
    flush(controller) {
      if (overflowed) {
        const tail = decoder.decode();
        if (tail.length > 0) controller.enqueue(encoder.encode(tail));
        return;
      }
      const tail = decoder.decode();
      const body = `${buffer}${tail}`;
      controller.enqueue(encoder.encode(restoreNonSseBody(session, body)));
    },
  });
}
// END_BLOCK_SSE_STREAM

// START_BLOCK_FRAME_RESTORE
/** Persistent per-connection frame carries with terminal-boundary reset. */
export interface FrameRestoreState {
  sse: SseRestoreStream | null;
  text: TextDeltaRestorer;
  readonly restorers: Map<string, TextDeltaRestorer>;
}

/** Build persistent frame restore state for one socket connection. */
export function createFrameRestoreState(session: PlaceholderSession): FrameRestoreState {
  return { sse: null, text: new TextDeltaRestorer(session), restorers: new Map() };
}

function resetFrameState(state: FrameRestoreState, session: PlaceholderSession): void {
  state.sse = null;
  state.text = new TextDeltaRestorer(session);
  state.restorers.clear();
}

/**
 * Restore one WebSocket TEXT frame. Recognized JSON deltas restore by lane with
 * a persistent carry so a placeholder split across frames completes; SSE-framed
 * text reuses one long-lived line stream so a partial line, event, or lane
 * carry survives every frame boundary until the actual terminal/end. State is
 * reset only on a recognized global terminal, never per frame, so a split
 * placeholder is never abandoned or re-decoded against a reset carry and no
 * bytes (including a missing newline) are injected into a mid-line frame.
 * Frames that match no recognized protocol shape are returned unchanged,
 * preserving opaque/binary/tool-protocol frames.
 */
export function restoreProviderFrame(
  session: PlaceholderSession,
  frame: string,
  state: FrameRestoreState,
): string {
  // A frame that opens an SSE-over-WS stream, or any continuation frame while
  // one is active, is fed to the single long-lived line stream. The stream is
  // only left on a recognized global terminal, so a split line/event/carry
  // survives frame boundaries instead of being reset per frame.
  if (state.sse !== null || /^data:(?: |$)/m.test(frame)) {
    state.sse ??= new SseRestoreStream(session);
    let output = state.sse.push(frame);
    output += state.sse.drainUnterminatedLine();
    if (state.sse.terminal) {
      output += state.sse.flush();
      resetFrameState(state, session);
    }
    return output;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    parsed = undefined;
  }
  if (isObject(parsed)) {
    let changed = false;
    for (const target of collectTextTargets(parsed)) {
      const value = getByPath(parsed, target.path);
      if (typeof value !== "string") continue;
      let restorer = state.restorers.get(target.lane);
      if (restorer === undefined) {
        restorer = new TextDeltaRestorer(session);
        state.restorers.set(target.lane, restorer);
      }
      setByPath(parsed, target.path, restorer.push(value));
      changed = true;
    }
    for (const lane of endedLaneKeys(parsed)) state.restorers.delete(lane);
    const terminal = isGlobalTerminalObject(parsed);
    const result = changed ? JSON.stringify(parsed) : frame;
    if (terminal) resetFrameState(state, session);
    return result;
  }

  // Plain text frame: restore recognized placeholders with a persistent carry.
  if (frame.includes("\u0000")) return frame;
  return state.text.push(frame);
}
// END_BLOCK_FRAME_RESTORE
