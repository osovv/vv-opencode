import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  installGuardianConfig,
  installMemoryConfig,
  resolvePaths,
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "install",
    description: "Install vv-opencode into OpenCode config.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write to global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
    force: {
      type: "boolean",
      description: "Allow overwriting an existing guardian config when needed.",
    },
    "guardian-config": {
      type: "boolean",
      default: true,
      description: "Create guardian.jsonc when missing.",
    },
    "memory-config": {
      type: "boolean",
      default: true,
      description: "Create memory.jsonc when missing.",
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

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);

    if (args["guardian-config"] === false) {
      console.log(`Skipped ${paths.guardianConfigPath} (guardian config disabled)`);
    } else {
      const guardian = await installGuardianConfig(paths, { force: Boolean(args.force) });
      console.log(describeWriteResult(guardian));
    }

    if (args["memory-config"] === false) {
      console.log(`Skipped ${paths.memoryConfigPath} (memory config disabled)`);
      return;
    }

    const memory = await installMemoryConfig(paths, { force: Boolean(args.force) });
    console.log(describeWriteResult(memory));
  },
});
