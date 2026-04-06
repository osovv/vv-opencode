import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  resolvePaths,
  syncGuardianConfig,
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "sync",
    description: "Sync managed vv-opencode config files.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Sync global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global OpenCode config directory.",
    },
    force: {
      type: "boolean",
      description: "Allow rewriting unmanaged guardian config files.",
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
    const opencode = await ensurePackageInstalled(paths);
    const guardian = await syncGuardianConfig(paths, { force: Boolean(args.force) });

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
    console.log(describeWriteResult(guardian));
  },
});
