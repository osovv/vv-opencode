#!/usr/bin/env bun

// FILE: src/cli.ts
// VERSION: 0.2.9
// START_MODULE_CONTRACT
//   PURPOSE: Assemble and run the vvoc CLI entrypoint.
//   SCOPE: Package version lookup, top-level command registration, and main command execution.
//   INPUTS: Process argv plus command metadata from registered subcommands.
//   OUTPUTS: The executed vvoc command tree.
//   DEPENDS: [citty, src/commands/install.ts, src/commands/preset.ts, src/commands/role.ts, src/commands/sync.ts, src/commands/status.ts, src/commands/doctor.ts, src/commands/guardian.ts, src/commands/patch-provider.ts, src/commands/version.ts, src/lib/package.ts]
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
//   LAST_CHANGE: [v0.2.9 - Replaced the public agent command with role in the CLI command tree.]
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
    description: "Install and sync vv-opencode plugins for OpenCode.",
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
