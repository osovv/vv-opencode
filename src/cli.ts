#!/usr/bin/env bun

// FILE: src/cli.ts
// VERSION: 0.2.10
// START_MODULE_CONTRACT
//   PURPOSE: Assemble and run the vvoc CLI entrypoint.
//   SCOPE: Package version lookup, top-level command registration, and main command execution.
//   DEPENDS: [citty, src/commands/completion.ts, src/commands/config.ts, src/commands/doctor.ts, src/commands/guardian.ts, src/commands/init.ts, src/commands/install.ts, src/commands/patch-provider.ts, src/commands/preset.ts, src/commands/plugin.ts, src/commands/role.ts, src/commands/status.ts, src/commands/sync.ts, src/commands/upgrade.ts, src/commands/version.ts, src/lib/package.ts]
//   LINKS: [M-CLI-COMMANDS]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   packageVersion - Resolved package version used in CLI metadata.
//   main - Top-level vvoc command tree.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.11 - Aligned meta description with package.json, README, and GitHub repo; license and badge polish.]
// END_CHANGE_SUMMARY

import { defineCommand, runMain } from "citty";
import completion from "./commands/completion.js";
import config from "./commands/config.js";
import doctor from "./commands/doctor.js";
import guardian from "./commands/guardian.js";
import init from "./commands/init.js";
import install from "./commands/install.js";
import patchProvider from "./commands/patch-provider.js";
import preset from "./commands/preset.js";
import plugin from "./commands/plugin.js";
import role from "./commands/role.js";
import status from "./commands/status.js";
import sync from "./commands/sync.js";
import upgrade from "./commands/upgrade.js";
import version from "./commands/version.js";
import { getPackageVersion } from "./lib/package.js";

// START_BLOCK_BUILD_CLI_METADATA
const packageVersion = await getPackageVersion();

const main = defineCommand({
  meta: {
    name: "vvoc",
    version: packageVersion,
    description:
      "Portable OpenCode workflow toolkit — 6 plugins, managed agents & skills, a spec-to-code pipeline, security, and the vvoc CLI.",
  },
  subCommands: {
    completion,
    config,
    doctor,
    guardian,
    init,
    install,
    "patch-provider": patchProvider,
    preset,
    plugin,
    role,
    status,
    sync,
    upgrade,
    version,
  },
});
// END_BLOCK_BUILD_CLI_METADATA

await runMain(main);
