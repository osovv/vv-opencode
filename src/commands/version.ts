// FILE: src/commands/version.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Print the current vv-opencode package version.
//   SCOPE: Package identity lookup and CLI version output.
//   DEPENDS: [citty, src/lib/package.ts]
//   LINKS: [M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Version command definition.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.5 - Added GRACE command markup around version reporting.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { getPackageVersion, PACKAGE_NAME } from "../lib/package.js";

export default defineCommand({
  meta: {
    name: "version",
    description: "Show vvoc package version.",
  },
  async run() {
    console.log(`${PACKAGE_NAME} ${await getPackageVersion()}`);
  },
});
