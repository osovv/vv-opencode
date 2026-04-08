// FILE: src/commands/install.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Install vv-opencode into OpenCode config and bootstrap the canonical vvoc.json config plus managed prompts.
//   SCOPE: Scope parsing, path resolution, pinned plugin registration, managed OpenCode agent registration, managed agent prompt scaffolding, and canonical vvoc config creation.
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
//   LAST_CHANGE: [v0.3.0 - Replaced per-feature vvoc config scaffolding with canonical vvoc.json creation.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  installManagedAgentPrompts,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "install",
    description: "Install vv-opencode into OpenCode config.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write to global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
    force: {
      type: "boolean",
      description: "Allow overwriting managed prompt files when needed.",
    },
  },
  async run({ args }) {
    // START_BLOCK_APPLY_INSTALL_COMMAND
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({
      scope: scope as Scope,
      cwd: process.cwd(),
      configDir,
    });
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
