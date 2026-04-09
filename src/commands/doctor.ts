// FILE: src/commands/doctor.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Diagnose vv-opencode installation problems and surface actionable failures.
//   SCOPE: Global installation inspection, warning/problem reporting, and non-zero exit signaling for OpenCode plus the canonical vvoc.json config.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Doctor command definition for vvoc installation diagnostics.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Simplified doctor diagnostics to the canonical global config layout.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { inspectInstallation, resolvePaths } from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose vv-opencode installation issues.",
  },
  async run() {
    // START_BLOCK_PRINT_DIAGNOSTIC_REPORT
    const paths = await resolvePaths();
    const inspection = await inspectInstallation(paths);

    console.log(`OpenCode config: ${inspection.opencode.path}`);
    console.log(
      `OpenCode config parse: ${inspection.opencode.parseError ? inspection.opencode.parseError : "ok"}`,
    );
    console.log(
      `Configured plugins: ${inspection.opencode.plugins.length > 0 ? inspection.opencode.plugins.join(", ") : "<none>"}`,
    );
    console.log(`vvoc config: ${inspection.vvoc.path}`);
    console.log(
      `vvoc config parse: ${inspection.vvoc.parseError ? inspection.vvoc.parseError : inspection.vvoc.exists ? "ok" : "missing"}`,
    );
    console.log(`vvoc schema: ${inspection.vvoc.schema ?? "missing"}`);
    console.log(`vvoc version: ${inspection.vvoc.version ?? "missing"}`);
    console.log(
      `Guardian model: ${inspection.guardian.config ? (inspection.guardian.config.model ?? "default") : "unknown"}`,
    );
    console.log(
      `Memory enabled: ${inspection.memory.config ? (inspection.memory.config.enabled ? "yes" : "no") : "unknown"}`,
    );
    console.log(
      `Secrets Redaction enabled: ${inspection.secretsRedaction.config ? (inspection.secretsRedaction.config.enabled ? "yes" : "no") : "unknown"}`,
    );

    if (inspection.warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of inspection.warnings) {
        console.log(`- ${warning}`);
      }
    }

    if (inspection.problems.length > 0) {
      console.error("Problems:");
      for (const problem of inspection.problems) {
        console.error(`- ${problem}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("Doctor: ok");
    // END_BLOCK_PRINT_DIAGNOSTIC_REPORT
  },
});
