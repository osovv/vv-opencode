// FILE: src/plugins/tool-history-compaction/transform.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply tool-history compaction to the native provider-context message list the model is about to receive: compute an absolute recent-message window from correlated native message recency times, walk messages newest-first, dispatch retained/read/other tools to the right compaction layer, persist full pruned outputs for recoverable markers, and rewrite only eligible completed textual tool results.
//   SCOPE: Recency-time window computation over native AI messages with preceding-message inheritance, completed textual tool-result detection, per-call protection accounting outside the window, retention dispatch, read-slim and prune application, optional disk-backed prune recovery, and idempotent in-place result rewrites that never touch stored storage, inputs, structure, order, opaque/media/JSON result fields, or non-textual results.
//   DEPENDS: [@opencode/ai, src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/retention.ts, src/plugins/tool-history-compaction/prune.ts, src/plugins/tool-history-compaction/read-slim.ts, src/plugins/tool-history-compaction/saved-output.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION, V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TransformMessage - Structural mutable view of one native AI message used for in-place rewriting.
//   TransformContentPart - Structural mutable view of one native content part inspected by the transform.
//   TransformToolResultPart - Structural mutable view of one native completed textual tool result.
//   recentMessageIndexes - Indices of the newest native messages by correlated recency time (preceding-message inheritance and array-position fallback).
//   compactMessages - Deterministically rewrite eligible native tool result text in place.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 - Ported the V1 experimental.chat.messages.transform over SDK parts to native @opencode/ai Message/ToolResultPart content, rewriting only completed textual tool results and correlating stored message recency by native message id.]
// END_CHANGE_SUMMARY

import type { Message } from "@opencode/ai";
import type { ToolHistoryCompactionConfig } from "./config.js";
import { pruneOutput } from "./prune.js";
import { slimReadOutput } from "./read-slim.js";
import { isRetainedTool } from "./retention.js";
import { savePrunedOutputOnce } from "./saved-output.js";

// START_BLOCK_TYPES
/**
 * Structural mutable view of one native AI message. The native hook delivers
 * `@opencode/ai` `Message` instances whose schema-derived types are readonly;
 * the event contract is to mutate them in place, so the transform works on this
 * documented structural view and never changes structure or ordering.
 */
export interface TransformMessage {
  id?: string | undefined;
  content: TransformContentPart[];
}

/** Structural mutable view of one native content part; only tool-call/tool-result parts are inspected. */
export interface TransformContentPart {
  type: string;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  result?: unknown;
}

/** Structural mutable view of one native completed textual tool result. */
export interface TransformToolResultPart extends TransformContentPart {
  type: "tool-result";
  id: string;
  name: string;
  result: { type: "text"; value: unknown } & Record<string, unknown>;
}
// END_BLOCK_TYPES

// START_BLOCK_GUARDS
function asMessages(messages: Message[]): TransformMessage[] {
  // The native hook hands mutable instances; the readonly schema view is a
  // type-level constraint only. No structure is changed by this view.
  return messages as unknown as TransformMessage[];
}

function isToolResult(part: TransformContentPart): part is TransformToolResultPart {
  if (part.type !== "tool-result") return false;
  if (typeof part.id !== "string" || typeof part.name !== "string") return false;
  const result = part.result;
  if (typeof result !== "object" || result === null) return false;
  const record = result as { type?: unknown; value?: unknown };
  return record.type === "text" && typeof record.value === "string";
}

interface ToolCallInfo {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Index every native tool-call input by call id. Native tool-result parts do
 * not carry the call input, so read-slim recovers the file from the matching
 * tool-call part within the same dispatched context.
 */
function indexToolCalls(messages: TransformMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      if (typeof part.id !== "string" || typeof part.name !== "string") continue;
      calls.set(part.id, { name: part.name, input: part.input });
    }
  }
  return calls;
}

function isReadTool(tool: string): boolean {
  return tool.toLowerCase() === "read";
}
// END_BLOCK_GUARDS

// START_BLOCK_LOGICAL_GROUPS
interface LogicalMessageGroup {
  readonly key: string;
  readonly indices: number[];
  recency: number;
  maxIndex: number;
}

/** Native call/result ids carried by one content row. */
function extractCallIds(message: TransformMessage): string[] {
  const ids: string[] = [];
  if (!Array.isArray(message.content)) return ids;
  for (const part of message.content) {
    if (part.type !== "tool-call" && part.type !== "tool-result") continue;
    if (typeof part.id === "string" && part.id.length > 0) ids.push(part.id);
  }
  return ids;
}

/**
 * Collapse physical protocol rows into logical source messages. The pinned host
 * translator emits one id-bearing assistant row containing tool calls followed
 * by separate id-less `Message.tool(result)` children, so children are joined to
 * their source row by the native tool call/result id. Rows whose source identity
 * cannot be established are reported as unknown and are never compacted
 * (fail-safe: an unrecognized row may still be protected knowledge).
 */
function buildLogicalGroups(
  messages: TransformMessage[],
  times?: ReadonlyMap<string, number> | undefined,
): { groups: LogicalMessageGroup[]; unknown: Set<number> } {
  const groups = new Map<string, LogicalMessageGroup>();
  const callToKey = new Map<string, string>();
  const pending: Array<{ index: number; callIds: string[] }> = [];
  const unknown = new Set<number>();

  const ensure = (key: string): LogicalMessageGroup => {
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const created: LogicalMessageGroup = {
      key,
      indices: [],
      recency: Number.NEGATIVE_INFINITY,
      maxIndex: -1,
    };
    groups.set(key, created);
    return created;
  };

  messages.forEach((message, index) => {
    const callIds = extractCallIds(message);
    const id = message.id;
    if (typeof id === "string") {
      const key = `msg:${id}`;
      const group = ensure(key);
      group.indices.push(index);
      group.maxIndex = Math.max(group.maxIndex, index);
      const time = times?.get(id);
      if (typeof time === "number" && Number.isFinite(time)) {
        group.recency = Math.max(group.recency, time);
      }
      for (const callId of callIds) callToKey.set(callId, key);
      return;
    }
    pending.push({ index, callIds });
  });

  for (const { index, callIds } of pending) {
    let key: string | undefined;
    for (const callId of callIds) {
      const found = callToKey.get(callId);
      if (found !== undefined) {
        key = found;
        break;
      }
    }
    if (key === undefined) {
      // No id and no resolvable source call: unknown identity, never compacted.
      unknown.add(index);
      continue;
    }
    const group = ensure(key);
    group.indices.push(index);
    group.maxIndex = Math.max(group.maxIndex, index);
  }

  return { groups: [...groups.values()], unknown };
}
// END_BLOCK_LOGICAL_GROUPS

// START_BLOCK_WINDOW
/**
 * Compute the physical indices of the newest `count` logical source messages by
 * correlated recency time. Each id-bearing native row is one logical source
 * message; id-less tool-result children join their source row by the real native
 * call id, so a turn with multiple results counts once and all of its physical
 * rows are protected together. Groups without a correlated time fall back to
 * array-position ordering (later source row wins) so the newest entries are
 * still selected deterministically. Rows with no resolvable source identity are
 * always protected. Never fabricates a time.
 * @param messages - the native hook's message list.
 * @param count - how many newest logical messages to protect; 0 or negative disables the window.
 * @param times - native source message id to recency time in epoch milliseconds.
 * @returns the set of protected physical message indices.
 */
export function recentMessageIndexes(
  messages: Message[] | TransformMessage[],
  count: number,
  times?: ReadonlyMap<string, number> | undefined,
): Set<number> {
  const result = new Set<number>();
  if (count <= 0 || messages.length === 0) return result;

  const { groups, unknown } = buildLogicalGroups(messages as TransformMessage[], times);
  for (const index of unknown) result.add(index);

  const ranked = groups.slice().sort((a, b) => {
    if (b.recency !== a.recency) return b.recency - a.recency;
    return b.maxIndex - a.maxIndex;
  });

  const take = Math.min(count, ranked.length);
  for (let k = 0; k < take; k++) {
    const group = ranked[k];
    if (!group) continue;
    for (const index of group.indices) result.add(index);
  }
  return result;
}
// END_BLOCK_WINDOW

// START_BLOCK_COMPACT
/**
 * Deterministically rewrite eligible native tool result text in place.
 * Model-agnostic: the current model is not needed. Non-destructive to inputs,
 * content structure, part ordering, and non-textual or already-compacted
 * results. Idempotent: marker-carrying text is skipped, so a second pass is a
 * no-op.
 * @param messages - the native context hook's in-memory message list.
 * @param config - resolved compaction config.
 * @param times - native message id to recency time in epoch milliseconds.
 */
export function compactMessages(
  messages: Message[],
  config: ToolHistoryCompactionConfig,
  times?: ReadonlyMap<string, number> | undefined,
): void {
  const view = asMessages(messages);
  const calls = indexToolCalls(view);
  // The newest message is always protected; protectRecentMessages widens the window.
  const windowSize = Math.max(1, config.protectRecentMessages);
  const protectedMessages = recentMessageIndexes(view, windowSize, times);
  let remainingProtection = config.protectLastCalls;

  for (let i = view.length - 1; i >= 0; i--) {
    const message = view[i];
    if (!message || !Array.isArray(message.content)) continue;
    const withinWindow = protectedMessages.has(i);

    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (!part || !isToolResult(part)) continue;

      // Absolute recent-message window: nothing inside the newest messages is rewritten.
      if (withinWindow) continue;

      // Retained tools are never compacted and do not consume the per-call budget.
      if (isRetainedTool(part.name, config.retainTools)) continue;

      // Per-call protection budget applies only to compaction-eligible parts outside the window.
      if (remainingProtection > 0) {
        remainingProtection -= 1;
        continue;
      }

      const output = part.result.value as string;
      const input = calls.get(part.id)?.input;
      let rewritten: string | undefined;

      if (config.readSlim && isReadTool(part.name)) {
        const slim = slimReadOutput(input, output, config);
        if (slim) {
          rewritten = slim.output;
        } else {
          const pruned = pruneOutput(output, config);
          if (pruned) rewritten = pruned.output;
        }
      } else {
        const basePruned = pruneOutput(output, config);
        if (basePruned) {
          if (config.savePrunedOutput) {
            const savedPath = savePrunedOutputOnce(output, part.id);
            if (savedPath) {
              const recoverable = pruneOutput(output, config, savedPath);
              rewritten = recoverable ? recoverable.output : basePruned.output;
            } else {
              rewritten = basePruned.output;
            }
          } else {
            rewritten = basePruned.output;
          }
        }
      }

      if (rewritten !== undefined && rewritten !== output) {
        // Rewrite only the textual result value; structure, id, name, input,
        // ordering, and every opaque/media/JSON field stay untouched.
        part.result.value = rewritten;
      }
    }
  }
}
// END_BLOCK_COMPACT
