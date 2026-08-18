// FILE: src/plugins/tool-history-compaction/transform.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply tool-history compaction to the in-memory message list the model is about to receive: walk messages newest-first, protect the recent tail, dispatch retained/read/other tools to the right compaction layer, and mutate only completed tool part outputs.
//   SCOPE: Completed-tool-part detection, protected-tail accounting, retention dispatch, read-slim and prune application, and idempotent in-place output rewrites.
//   DEPENDS: [src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/retention.ts, src/plugins/tool-history-compaction/prune.ts, src/plugins/tool-history-compaction/read-slim.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TransformMessage - One message entry in the transform hook output.
//   compactMessages - Deterministically rewrite eligible tool part outputs in place.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established the transform core with protected tail, retention dispatch, and idempotence.]
// END_CHANGE_SUMMARY

import type { Part } from "@opencode-ai/sdk";
import type { ToolHistoryCompactionConfig } from "./config.js";
import { pruneOutput } from "./prune.js";
import { slimReadOutput } from "./read-slim.js";
import { isRetainedTool } from "./retention.js";

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
  let remainingProtection = config.protectLastCalls;
  let firstMessage = true;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;

    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (!part || part.type !== "tool") continue;
      if (!isCompletedToolPart(part)) continue;
      if (isCompactedByOpencode(part)) continue;

      const withinTail = firstMessage || remainingProtection > 0;
      if (withinTail) {
        if (!firstMessage) remainingProtection -= 1;
        continue;
      }

      if (isRetainedTool(part.tool, config.retainTools)) continue;

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
        const pruned = pruneOutput(output, config);
        if (pruned) rewritten = pruned.output;
      }

      if (rewritten !== undefined && rewritten !== output) {
        part.state.output = rewritten;
      }
    }

    if (firstMessage) firstMessage = false;
  }
}
// END_BLOCK_COMPACT
