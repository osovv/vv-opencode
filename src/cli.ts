#!/usr/bin/env bun

// FILE: src/cli.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Assemble and run the vvoc CLI entrypoint.
//   SCOPE: Package version lookup, top-level command registration, and main command execution.
//   DEPENDS: [citty, src/commands/install.ts, src/commands/sync.ts, src/commands/status.ts, src/commands/doctor.ts, src/commands/guardian.ts, src/commands/version.ts, src/lib/package.ts]
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
//   LAST_CHANGE: [v0.2.5 - Added GRACE script markup so the vvoc entrypoint and command tree can be navigated quickly.]
// END_CHANGE_SUMMARY

import { defineCommand, runMain } from "citty";
import agent from "./commands/agent.js";
import completion from "./commands/completion.js";
import config from "./commands/config.js";
import doctor from "./commands/doctor.js";
import guardian from "./commands/guardian.js";
import init from "./commands/init.js";
import install from "./commands/install.js";
import plugin from "./commands/plugin.js";
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
    agent,
    completion,
    config,
    doctor,
    guardian,
    init,
    install,
    plugin,
    status,
    sync,
    upgrade,
    version,
  },
});
// END_BLOCK_BUILD_CLI_METADATA

await runMain(main);
