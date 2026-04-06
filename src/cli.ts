#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import doctor from "./commands/doctor.js";
import guardian from "./commands/guardian.js";
import install from "./commands/install.js";
import status from "./commands/status.js";
import sync from "./commands/sync.js";
import version from "./commands/version.js";
import { getPackageVersion } from "./lib/package.js";

const packageVersion = await getPackageVersion();

const main = defineCommand({
  meta: {
    name: "vvoc",
    version: packageVersion,
    description: "Install and sync vv-opencode plugins for OpenCode.",
  },
  subCommands: {
    install,
    sync,
    status,
    doctor,
    guardian,
    version,
  },
});

await runMain(main);
