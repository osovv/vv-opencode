// FILE: src/commands/sync.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Sync the canonical vvoc.json config file, managed prompts, and keep the OpenCode plugin specifier current.
//   SCOPE: Global path resolution, pinned plugin sync, managed OpenCode agent sync, managed agent prompt sync, and canonical vvoc config rewrite.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Sync command definition for vvoc-managed config files.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Simplified sync to refresh the canonical global OpenCode and vvoc config paths only.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  resolvePaths,
  syncManagedAgentPrompts,
  syncManagedAgentRegistrations,
  syncVvocConfig,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "sync",
    description: "Sync managed global vv-opencode config files.",
  },
  args: {
    force: {
      type: "boolean",
      description: "Allow rewriting unmanaged managed-prompt files.",
    },
  },
  async run({ args }) {
    // START_BLOCK_APPLY_SYNC_COMMAND
    const paths = await resolvePaths();
    const opencode = await ensurePackageInstalled(paths);
    const managedAgents = await syncManagedAgentRegistrations(paths);
    const managedPrompts = await syncManagedAgentPrompts(paths, { force: Boolean(args.force) });
    const vvocConfig = await syncVvocConfig(paths);

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
    console.log(
      `${managedAgents.changed ? "Updated" : "Kept"} ${managedAgents.path} (managed agents)`,
    );
    for (const result of managedPrompts) {
      console.log(describeWriteResult(result));
    }
    console.log(describeWriteResult(vvocConfig));
    // END_BLOCK_APPLY_SYNC_COMMAND
  },
});
