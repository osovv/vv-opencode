// FILE: src/commands/sync.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Sync the canonical vvoc.json config file, managed prompts, and keep the OpenCode plugin specifier current.
//   SCOPE: Scope parsing, path resolution, pinned plugin sync, managed OpenCode agent sync, managed agent prompt sync, managed plan directory sync, and canonical vvoc config rewrite.
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
//   LAST_CHANGE: [v0.4.0 - Ensured the project-local managed planning artifact directory exists during project-scope sync.]
//   LAST_CHANGE: [v0.3.0 - Replaced per-feature vvoc config syncing with canonical vvoc.json refresh.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensureManagedPlanDirectory,
  ensurePackageInstalled,
  resolvePaths,
  syncManagedAgentPrompts,
  syncManagedAgentRegistrations,
  syncVvocConfig,
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
      description: "Allow rewriting unmanaged managed-prompt files.",
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
    const managedAgents = await syncManagedAgentRegistrations(paths);
    const managedPrompts = await syncManagedAgentPrompts(paths, { force: Boolean(args.force) });
    const managedPlans =
      paths.scope === "project" ? await ensureManagedPlanDirectory(paths) : undefined;
    const vvocConfig = await syncVvocConfig(paths);

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
    console.log(
      `${managedAgents.changed ? "Updated" : "Kept"} ${managedAgents.path} (managed agents)`,
    );
    for (const result of managedPrompts) {
      console.log(describeWriteResult(result));
    }
    if (managedPlans) {
      console.log(describeWriteResult(managedPlans));
    }
    console.log(describeWriteResult(vvocConfig));
    // END_BLOCK_APPLY_SYNC_COMMAND
  },
});
