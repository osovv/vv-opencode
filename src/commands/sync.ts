// FILE: src/commands/sync.ts
// VERSION: 0.2.6
// START_MODULE_CONTRACT
//   PURPOSE: Sync managed vvoc config files and keep the OpenCode plugin specifier current.
//   SCOPE: Scope parsing, path resolution, pinned plugin sync, managed agent prompt sync, and managed Guardian/Memory config rewrites.
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
//   LAST_CHANGE: [v0.2.6 - Added managed subagent registration plus guardian/memory-reviewer prompt syncing to vvoc sync.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  resolvePaths,
  syncManagedAgentPrompts,
  syncManagedSubagentRegistrations,
  syncGuardianConfig,
  syncMemoryConfig,
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "sync",
    description: "Sync managed vv-opencode config files.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Sync global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
    force: {
      type: "boolean",
      description: "Allow rewriting unmanaged vvoc config files.",
    },
  },
  async run({ args }) {
    // START_BLOCK_APPLY_SYNC_COMMAND
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({
      scope: scope as Scope,
      cwd: process.cwd(),
      configDir,
    });
    const opencode = await ensurePackageInstalled(paths);
    const managedSubagents = await syncManagedSubagentRegistrations(paths);
    const managedPrompts = await syncManagedAgentPrompts(paths, { force: Boolean(args.force) });
    const guardian = await syncGuardianConfig(paths, { force: Boolean(args.force) });
    const memory = await syncMemoryConfig(paths, { force: Boolean(args.force) });

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
    console.log(
      `${managedSubagents.changed ? "Updated" : "Kept"} ${managedSubagents.path} (managed subagents)`,
    );
    for (const result of managedPrompts) {
      console.log(describeWriteResult(result));
    }
    console.log(describeWriteResult(guardian));
    console.log(describeWriteResult(memory));
    // END_BLOCK_APPLY_SYNC_COMMAND
  },
});
