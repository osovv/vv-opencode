import { defineCommand } from "citty";
import { inspectInstallation, resolvePaths, type Scope } from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose vv-opencode installation issues.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Inspect global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
  },
  async run({ args }) {
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({
      scope: scope as Scope,
      cwd: process.cwd(),
      configDir,
    });
    const inspection = await inspectInstallation(paths);

    console.log(`Scope: ${inspection.scope}`);
    console.log(`OpenCode config: ${inspection.opencode.path}`);
    console.log(
      `OpenCode config parse: ${inspection.opencode.parseError ? inspection.opencode.parseError : "ok"}`,
    );
    console.log(
      `Configured plugins: ${inspection.opencode.plugins.length > 0 ? inspection.opencode.plugins.join(", ") : "<none>"}`,
    );
    console.log(`Guardian config: ${inspection.guardian.path}`);
    console.log(
      `Guardian config parse: ${inspection.guardian.parseError ? inspection.guardian.parseError : inspection.guardian.exists ? "ok" : "missing"}`,
    );
    console.log(`Guardian config managed by vvoc: ${inspection.guardian.managed ? "yes" : "no"}`);

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
  },
});
