// FILE: src/plugins/tool-history-compaction/index.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the tool-history-compaction plugin: load vvoc config, gate on the enabled toggle, and rewrite only the in-memory message copy the model is about to receive via experimental.chat.messages.transform.
//   SCOPE: Plugin entry point, config loading, transform hook registration, and disabled no-op.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/transform.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ToolHistoryCompactionPlugin - OpenCode plugin that compacts old tool outputs in the replay without touching storage or inputs.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established the transform-only compaction plugin with retention classification and DSH-style pruning.]
// END_CHANGE_SUMMARY

import { type Plugin } from "@opencode-ai/plugin";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { parseToolHistoryCompactionEntry } from "./config.js";
import { compactMessages } from "./transform.js";

// START_BLOCK_PLUGIN
export const ToolHistoryCompactionPlugin: Plugin = async ({ directory }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  const entry = parseToolHistoryCompactionEntry(vvoc.config.plugins?.["tool-history-compaction"]);
  if (!entry.enabled) return {};

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      compactMessages(output.messages, entry.config);
    },
  };
};
// END_BLOCK_PLUGIN
