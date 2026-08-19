// FILE: src/plugins/tool-history-compaction/transform.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply tool-history compaction to the in-memory message list the model is about to receive: compute an absolute recent-message window from message recency times, walk messages newest-first, dispatch retained/read/other tools to the right compaction layer, persist full pruned outputs for recoverable markers, and mutate only completed tool part outputs.
//   SCOPE: Recency-time window computation, completed-tool-part detection, per-call protection accounting outside the window, retention dispatch, read-slim and prune application, optional disk-backed prune recovery, and idempotent in-place output rewrites.
//   DEPENDS: [src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/retention.ts, src/plugins/tool-history-compaction/prune.ts, src/plugins/tool-history-compaction/read-slim.ts, src/plugins/tool-history-compaction/saved-output.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TransformMessage - One message entry in the transform hook output.
//   recentMessageIndexes - Indices of the newest messages by recency time (array-position tie-break and fallback).
//   compactMessages - Deterministically rewrite eligible tool part outputs in place.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added recency-time recent-message window, fixed retained-tool budget leak, and added recoverable disk-backed pruning.]
// END_CHANGE_SUMMARY

import type { Part } from "@opencode-ai/sdk";
import type { ToolHistoryCompactionConfig } from "./config.js";
import { pruneOutput } from "./prune.js";
import { slimReadOutput } from "./read-slim.js";
import { isRetainedTool } from "./retention.js";
import { savePrunedOutputOnce } from "./saved-output.js";

// START_BLOCK_TYPES
export interface TransformMessage {
  info: unknown;
  parts: Part[];
}
// END_BLOCK_TYPES

// START_BLOCK_GUARDS
type CompletedToolPart = Part & {
  type: "tool";
  state: {
    status: "completed";
    input: unknown;
    output: string;
    time?: { compacted?: number };
  };
};

function isCompletedToolPart(part: Part): part is CompletedToolPart {
  return part.type === "tool" && part.state.status === "completed";
}

function isCompactedByOpencode(part: CompletedToolPart): boolean {
  const time = part.state.time;
  return (
    typeof time === "object" && time !== null && "compacted" in time && time.compacted !== undefined
  );
}

function isReadTool(tool: string): boolean {
  return tool.toLowerCase() === "read";
}
// END_BLOCK_GUARDS

// START_BLOCK_WINDOW
interface MessageWithTime {
  time?: { completed?: number; created?: number };
}

function messageRecencyTime(message: TransformMessage | undefined): number {
  const info = message?.info as MessageWithTime | undefined;
  const time = info?.time;
  return time?.completed ?? time?.created ?? Number.NEGATIVE_INFINITY;
}

/**
 * Compute the indices of the newest `count` messages by recency time.
 * Ties are broken by array position (later index wins); messages without
 * usable times fall back to array-position ordering so the newest entries are
 * still selected deterministically.
 * @param messages - the transform hook's message list.
 * @param count - how many newest messages to protect; 0 or negative disables the window.
 * @returns the set of protected message indices.
 */
export function recentMessageIndexes(messages: TransformMessage[], count: number): Set<number> {
  const result = new Set<number>();
  if (count <= 0 || messages.length === 0) return result;

  const ranked = messages
    .map((message, index) => ({ index, recency: messageRecencyTime(message) }))
    .sort((a, b) => {
      if (b.recency !== a.recency) return b.recency - a.recency;
      return b.index - a.index;
    });

  const take = Math.min(count, ranked.length);
  for (let k = 0; k < take; k++) {
    const entry = ranked[k];
    if (entry) result.add(entry.index);
  }
  return result;
}
// END_BLOCK_WINDOW

// START_BLOCK_COMPACT
/**
 * Deterministically rewrite eligible tool part outputs in place.
 * Model-agnostic: the current model is not needed. Non-destructive to inputs,
 * part structure, and ordering. Idempotent: already-compacted parts are skipped
 * by their markers, so a second pass is a no-op.
 * @param messages - the transform hook's in-memory message list.
 * @param config - resolved compaction config.
 */
export function compactMessages(
  messages: TransformMessage[],
  config: ToolHistoryCompactionConfig,
): void {
  // The newest message is always protected; protectRecentMessages widens the window.
  const windowSize = Math.max(1, config.protectRecentMessages);
  const protectedMessages = recentMessageIndexes(messages, windowSize);
  let remainingProtection = config.protectLastCalls;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const withinWindow = protectedMessages.has(i);

    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (!part || part.type !== "tool") continue;
      if (!isCompletedToolPart(part)) continue;
      if (isCompactedByOpencode(part)) continue;

      // Absolute recent-message window: nothing inside the newest messages is rewritten.
      if (withinWindow) continue;

      // Retained tools are never compacted and do not consume the per-call budget.
      if (isRetainedTool(part.tool, config.retainTools)) continue;

      // Per-call protection budget applies only to compaction-eligible parts outside the window.
      if (remainingProtection > 0) {
        remainingProtection -= 1;
        continue;
      }

      const output = part.state.output;
      let rewritten: string | undefined;

      if (config.readSlim && isReadTool(part.tool)) {
        const slim = slimReadOutput(part.state.input, output, config);
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
            const savedPath = savePrunedOutputOnce(output, part.callID);
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
        part.state.output = rewritten;
      }
    }
  }
}
// END_BLOCK_COMPACT
