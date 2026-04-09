// FILE: src/commands/install.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Install vv-opencode into OpenCode config and bootstrap the canonical vvoc.json config plus managed prompts.
//   SCOPE: Global path resolution, pinned plugin registration, managed OpenCode agent registration, managed agent prompt scaffolding, and canonical vvoc config creation.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Install command definition for plugin registration and vvoc config bootstrap.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Simplified install to target the canonical global OpenCode and vvoc config paths only.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  installManagedAgentPrompts,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "install",
    description: "Install vv-opencode into global OpenCode config.",
  },
  args: {
    force: {
      type: "boolean",
      description: "Allow overwriting managed prompt files when needed.",
    },
  },
  async run({ args }) {
    // START_BLOCK_APPLY_INSTALL_COMMAND
    const paths = await resolvePaths();
    const opencode = await ensurePackageInstalled(paths);
    const managedAgents = await syncManagedAgentRegistrations(paths);

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
    console.log(
      `${managedAgents.changed ? "Updated" : "Kept"} ${managedAgents.path} (managed agents)`,
    );

    for (const result of await installManagedAgentPrompts(paths, {
      force: Boolean(args.force),
    })) {
      console.log(describeWriteResult(result));
    }

    const vvocConfig = await installVvocConfig(paths);
    console.log(describeWriteResult(vvocConfig));
    // END_BLOCK_APPLY_INSTALL_COMMAND
  },
});
