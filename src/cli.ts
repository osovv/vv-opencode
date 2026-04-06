#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import doctor from "./commands/doctor.js";
import guardian from "./commands/guardian.js";
import install from "./commands/install.js";
import status from "./commands/status.js";
import sync from "./commands/sync.js";

const main = defineCommand({
  meta: {
    name: "vvoc",
    version: "0.1.0",
    description: "Install and sync vv-opencode plugins for OpenCode.",
  },
  subCommands: {
    install,
    sync,
    status,
    doctor,
    guardian,
  },
});

await runMain(main);
