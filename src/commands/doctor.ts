// FILE: src/commands/doctor.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Diagnose vv-opencode installation problems and surface actionable failures.
//   SCOPE: Read-scope parsing, layered source-aware installation inspection, OpenCode host compatibility, warning/problem reporting, and non-zero exit signaling for OpenCode runtime/TUI plus vvoc config.
//   DEPENDS: [citty, src/lib/config-layers.ts, src/lib/opencode.ts]
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
//   LAST_CHANGE: [v1.1.2 - Added installed OpenCode version and managed TUI compatibility diagnostics.]
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added TUI source, parse, plugin inventory, and registration diagnostics.]
//   LAST_CHANGE: [v0.5.0 - Added global/project/effective diagnostic scopes with selected source reporting.]
//   LAST_CHANGE: [v0.4.0 - Added canonical role inventory output while keeping unresolved role-reference failures in Problems diagnostics.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import type { ConfigReadScope } from "../lib/config-layers.js";
import { inspectInstallationForScope } from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose vv-opencode installation issues.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project", "effective"],
      default: "effective",
      description: "Inspect global, project-local, or effective layered config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
  },
  async run({ args }) {
    // START_BLOCK_PRINT_DIAGNOSTIC_REPORT
    const scope = resolveReadScope(args.scope);
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const inspection = await inspectInstallationForScope({ scope, cwd: process.cwd(), configDir });

    console.log(`Scope: ${inspection.scope}`);
    console.log(
      `OpenCode source: ${inspection.opencodeSource.kind}${inspection.opencodeSource.path ? ` ${inspection.opencodeSource.path}` : ""}`,
    );
    console.log(
      `OpenCode TUI source: ${inspection.opencodeTuiSource.kind}${inspection.opencodeTuiSource.path ? ` ${inspection.opencodeTuiSource.path}` : ""}`,
    );
    console.log(
      `vvoc source: ${inspection.vvocSource.kind}${inspection.vvocSource.path ? ` ${inspection.vvocSource.path}` : ""}`,
    );
    console.log(`OpenCode version: ${inspection.runtime.version ?? "unavailable"}`);
    console.log(`OpenCode TUI minimum: ${inspection.runtime.minimumTuiVersion}`);
    console.log(
      `OpenCode TUI compatible: ${inspection.runtime.tuiCompatible === undefined ? "unknown" : inspection.runtime.tuiCompatible ? "yes" : "no"}`,
    );
    console.log(`OpenCode config: ${inspection.opencode.path}`);
    console.log(
      `OpenCode config parse: ${inspection.opencode.parseError ? inspection.opencode.parseError : "ok"}`,
    );
    console.log(
      `Configured plugins: ${inspection.opencode.plugins.length > 0 ? inspection.opencode.plugins.join(", ") : "<none>"}`,
    );
    console.log(`OpenCode TUI config: ${inspection.tui.path}`);
    console.log(
      `OpenCode TUI config parse: ${inspection.tui.parseError ? inspection.tui.parseError : inspection.tui.exists ? "ok" : "missing"}`,
    );
    console.log(
      `Configured TUI plugins: ${inspection.tui.plugins.length > 0 ? inspection.tui.plugins.map((entry) => (typeof entry === "string" ? entry : entry[0])).join(", ") : "<none>"}`,
    );
    console.log(`TUI package configured: ${inspection.tui.pluginConfigured ? "yes" : "no"}`);
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
      `Secrets Redaction config: ${inspection.secretsRedaction.config ? "present" : "unknown"}`,
    );
    console.log("Roles:");
    if (inspection.roles.assignments.length === 0) {
      console.log("  <none>");
    } else {
      for (const role of inspection.roles.assignments) {
        console.log(`  ${role.roleId}: ${role.model}`);
      }
    }

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

function resolveReadScope(value: unknown): ConfigReadScope {
  return value === "global" || value === "project" ? value : "effective";
}
