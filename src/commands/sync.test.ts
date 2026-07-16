// FILE: src/commands/sync.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify sync command behavior for strict current-only vvoc config handling and managed TUI registration.
//   SCOPE: Command-level invalid existing config rejection without rewrite, preservation of valid current plugin toggles, and conservative dedicated tui.json(c) sync.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/sync.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   sync command tests - Verify strict current-only command behavior and plugin toggle preservation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added TUI registration creation and malformed-config no-rewrite coverage.]
//   LAST_CHANGE: [v1.0.0 - Added strict invalid-config rejection and plugin toggle preservation coverage for vvoc sync.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import syncCommand from "./sync.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { TUI_PACKAGE_SPECIFIER } from "../lib/opencode.js";

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
    const tui = JSON.parse(await readFile(join(configHome, "opencode", "tui.json"), "utf8")) as {
      plugin?: string[];
    };
    expect(tui.plugin).toContain(TUI_PACKAGE_SPECIFIER);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("sync command rejects malformed existing TUI config without rewriting it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-sync-invalid-tui-"));

  try {
    const vvocDir = join(configHome, "vvoc");
    const tuiDir = join(configHome, "opencode");
    const tuiPath = join(tuiDir, "tui.jsonc");
    await mkdir(vvocDir, { recursive: true });
    await mkdir(tuiDir, { recursive: true });
    await writeFile(
      join(vvocDir, "vvoc.json"),
      renderVvocConfig(createDefaultVvocConfig()),
      "utf8",
    );
    const invalidText = '{ "plugin": [["broken"]] }\n';
    await writeFile(tuiPath, invalidText, "utf8");

    await expect(
      captureConsoleLog(() => runSyncCommand({ scope: "global", "config-dir": configHome })),
    ).rejects.toThrow('expected "plugin[0]"');
    expect(await readFile(tuiPath, "utf8")).toBe(invalidText);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

async function runSyncCommand(args: Record<string, unknown>): Promise<void> {
  await (syncCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }).run(
    {
      args,
    },
  );
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
