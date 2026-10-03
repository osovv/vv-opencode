// FILE: src/commands/sync.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify sync command behavior for strict current-only vvoc config handling and managed TUI registration.
//   SCOPE: Command-level invalid existing config rejection without rewrite, preservation of valid current plugin toggles, and conservative dedicated tui.json(c) sync.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/sync.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG, V-M-CLI-COMMANDS, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUPPORTED_RUNTIME - Supported runtime inspection fixture stub.
//   V1_OPENCODE_CONFIG - vvoc 1.7.0 OpenCode config fixture used by migration coverage.
//   captureConsoleLog - Captures sync command diagnostics.
//   runSyncCommand - Runs the sync command against isolated fixtures.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-V1-OPENCODE-CONFIG-MIGRATION T-002 - Added host-gated V1 config migration, manual-work abort, and out-of-window no-op coverage.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "./sync.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { SUPPORTED_OPENCODE_VERSION_RANGE } from "../lib/opencode.js";

const SUPPORTED_RUNTIME = {
  version: "2.0.18",
  supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
  versionSupported: true,
};

test("sync command rejects invalid existing global vvoc config without rewriting it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-invalid-global-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const vvocConfigPath = join(vvocDir, "vvoc.json");
    await mkdir(vvocDir, { recursive: true });
    const invalidText =
      JSON.stringify({ ...createDefaultVvocConfig(), version: 2 }, null, 2) + "\n";
    await writeFile(vvocConfigPath, invalidText, "utf8");

    await expect(
      captureConsoleLog(() => runSyncCommand({ scope: "global", "config-dir": configHome })),
    ).rejects.toThrow();
    expect(await readFile(vvocConfigPath, "utf8")).toBe(invalidText);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("sync command preserves disabled current plugin toggles", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-plugin-toggle-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const vvocConfigPath = join(vvocDir, "vvoc.json");
    await mkdir(vvocDir, { recursive: true });
    await writeFile(
      vvocConfigPath,
      renderVvocConfig({
        ...createDefaultVvocConfig(),
        plugins: {
          ...createDefaultVvocConfig().plugins,
          "secrets-redaction": false,
        },
      }),
      "utf8",
    );

    await captureConsoleLog(() => runSyncCommand({ scope: "global", "config-dir": configHome }));
    const synced = JSON.parse(await readFile(vvocConfigPath, "utf8")) as {
      plugins?: Record<string, boolean>;
    };
    expect(synced.plugins?.["secrets-redaction"]).toBe(false);
    const opencode = JSON.parse(
      await readFile(join(configHome, "opencode", "opencode.json"), "utf8"),
    ) as { plugins?: Array<string | { package: string }> };
    expect(
      opencode.plugins?.some((entry) =>
        typeof entry === "string"
          ? entry.includes("vv-opencode")
          : entry.package.includes("vv-opencode"),
      ),
    ).toBe(true);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("sync command rejects a malformed native plugins document without rewriting it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-invalid-plugins-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const opencodeDir = join(configHome, "opencode");
    const opencodePath = join(opencodeDir, "opencode.json");
    await mkdir(vvocDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(vvocDir, "vvoc.json"),
      renderVvocConfig(createDefaultVvocConfig()),
      "utf8",
    );
    const invalidText = '{ "plugins": [["broken"]] }\n';
    await writeFile(opencodePath, invalidText, "utf8");

    await expect(
      captureConsoleLog(() => runSyncCommand({ scope: "global", "config-dir": configHome })),
    ).rejects.toThrow('expected "plugins[0]"');
    expect(await readFile(opencodePath, "utf8")).toBe(invalidText);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

const V1_OPENCODE_CONFIG = {
  model: "vv-role:smart",
  small_model: "vv-role:fast",
  default_agent: "vv-controller",
  agent: { explore: { model: "vv-role:fast" } },
  skills: { paths: ["./.vvoc/skills"] },
  command: {},
  plugin: ["@osovv/vv-opencode@1.7.0"],
};

test("sync command materializes a V1 OpenCode config with a backup", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-migrate-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const opencodeDir = join(configHome, "opencode");
    const opencodePath = join(opencodeDir, "opencode.json");
    await mkdir(vvocDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(vvocDir, "vvoc.json"),
      renderVvocConfig(createDefaultVvocConfig()),
      "utf8",
    );
    await writeFile(opencodePath, `${JSON.stringify(V1_OPENCODE_CONFIG, null, 2)}\n`, "utf8");

    await captureConsoleLog(() => runSyncCommand({ scope: "global", "config-dir": configHome }));

    const migrated = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
    expect("plugin" in migrated).toBe(false);
    expect("small_model" in migrated).toBe(false);
    expect(Array.isArray(migrated.plugins)).toBe(true);
    expect(JSON.stringify(migrated.plugins)).toContain("vv-opencode");
    expect((await readdir(opencodeDir)).some((name) => name.includes(".vvoc-backup-"))).toBe(true);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("sync command aborts on a V1 config whose fields need manual work", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-migrate-abort-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const opencodeDir = join(configHome, "opencode");
    const opencodePath = join(opencodeDir, "opencode.json");
    await mkdir(vvocDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(vvocDir, "vvoc.json"),
      renderVvocConfig(createDefaultVvocConfig()),
      "utf8",
    );
    const original = `${JSON.stringify({ enabled_providers: ["anthropic"] }, null, 2)}\n`;
    await writeFile(opencodePath, original, "utf8");

    await expect(
      captureConsoleLog(() => runSyncCommand({ scope: "global", "config-dir": configHome })),
    ).rejects.toThrow("migration needs manual work");
    expect(await readFile(opencodePath, "utf8")).toBe(original);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("sync command leaves a V1 config untouched when the host is out of window", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-migrate-host-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const opencodeDir = join(configHome, "opencode");
    const opencodePath = join(opencodeDir, "opencode.json");
    await mkdir(vvocDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(vvocDir, "vvoc.json"),
      renderVvocConfig(createDefaultVvocConfig()),
      "utf8",
    );
    const original = `${JSON.stringify(V1_OPENCODE_CONFIG, null, 2)}\n`;
    await writeFile(opencodePath, original, "utf8");

    await expect(
      captureConsoleLog(() =>
        runSync(
          { scope: "global", "config-dir": configHome },
          {
            inspectRuntime: async () => ({
              version: "1.18.2",
              supportedRange: SUPPORTED_RUNTIME.supportedRange,
              versionSupported: false,
            }),
          },
        ),
      ),
    ).rejects.toThrow();
    expect(await readFile(opencodePath, "utf8")).toBe(original);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

async function runSyncCommand(args: Record<string, unknown>): Promise<void> {
  await runSync(args, { inspectRuntime: async () => SUPPORTED_RUNTIME });
}

async function captureConsoleLog(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
}
