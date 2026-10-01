#!/usr/bin/env bun
// FILE: scripts/e2e-v2/tui.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Real-PTY acceptance for the native V2 TUI: drive the actual built TUI in an isolated standalone host and assert visible /context Overview/Tools/MCP content, tab navigation, narrow resize, key-driven scrolling, close/reopen reset, visible peak-hours banner/cache indicator/branding footer, controlled collection failure, and explicit-disabled negative controls.
//   SCOPE: Pinned host/source/artifact identity checks, ownership-marked scratch with an allow-listed environment, a local package-directory forwarder for the actual server model-roles plugin and the actual built TUI, a minimal ANSI screen buffer, real key input via Bun.Terminal, and exact-handle cleanup. It never replaces the plugin UI with a fake marker and never claims success it did not observe.
//   DEPENDS: [node:fs/promises, node:path, node:url, scripts/e2e-v2/host.ts, scripts/e2e-v2/provider.ts, scripts/e2e-v2/core.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS, M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TuiScenarioResult - Machine-readable outcome of one PTY scenario.
//   TuiAcceptanceResult - Machine-readable outcome of the whole TUI tier.
//   ScreenBuffer - Minimal ANSI terminal screen buffer used for visible-content assertions.
//   blank - Allocate a blank character matrix for one terminal screen.
//   TuiOptions - Inputs controlling one real-PTY TUI acceptance run.
//   runTuiAcceptance - Run the real-PTY acceptance and return only observed results.
//   result - Assemble a TuiAcceptanceResult from scenario outcomes.
//   UsageProvider - Running loopback provider that reports cache token usage.
//   createUsageProvider - Start the loopback usage provider on 127.0.0.1.
//   seedSession - Seed one real native session through the host HTTP API, then stop the headless server.
//   readPackageVersion - Read the workspace package version for the branding-footer assertion.
//   runDisabledNegative - Explicit-disabled negative control for suppressed context/analytics/peak-hours.
//   runControlledFailure - Controlled collection failure against a host without the vvoc server bridge.
//   screenExcerpt - Bounded one-line screen excerpt for failure diagnostics.
//   openContextOverview - Type /context and submit it, tolerating a consuming completion list.
//   waitFor - Poll the visible screen until a predicate holds or the deadline passes.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-FULL - The PTY tier now packs and installs the declared dependency graph and drives the INSTALLED TUI export plus installed server plugin, verifying installed paths stay outside the workspace.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added scroll, visible surfaces, controlled collection failure, and explicit-disabled negative controls, plus a cache-usage loopback provider.]
// END_CHANGE_SUMMARY

import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import {
  PINNED_HOST_SHA256,
  PINNED_SOURCE_COMMIT,
  assertLoopbackHttpUrl,
  buildHostEnv,
  createNativeApi,
  createOwnedScratch,
  discoverHostBinary,
  installPackedPackageWithDependencies,
  installedArtifactPathIssues,
  packWorkspace,
  removeOwnedScratch,
  sha256File,
  waitForRegisteredService,
  type OwnedScratch,
} from "./host.js";
import { getFreePort } from "./core.js";

/** Machine-readable outcome of one PTY scenario. */
export interface TuiScenarioResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

/** Machine-readable outcome of the whole TUI tier. */
export interface TuiAcceptanceResult {
  readonly ok: boolean;
  readonly implemented: boolean;
  readonly hostSha256?: string;
  readonly sourceCommit: string;
  readonly scenarios: readonly TuiScenarioResult[];
  readonly error?: string;
  readonly note: string;
}

// START_BLOCK_SCREEN_BUFFER
/**
 * Minimal ANSI terminal screen buffer. It understands the cursor movement,
 * erase, save/restore, and synchronized-update sequences OpenTUI emits, so
 * assertions read the current visible screen rather than any historical text.
 * Unknown CSI sequences are consumed without writing control bytes.
 */
export class ScreenBuffer {
  readonly cols: number;
  readonly rows: number;
  #grid: string[][];
  #row = 0;
  #col = 0;
  #saved = { row: 0, col: 0 };
  #pending = "";

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.#grid = blank(cols, rows);
  }

  /** Current visible screen as trimmed lines. */
  text(): string {
    return this.#grid.map((line) => line.join("").replace(/\s+$/, "")).join("\n");
  }

  write(data: string): void {
    const input = this.#pending + data;
    this.#pending = "";
    let index = 0;
    while (index < input.length) {
      const char = input[index]!;
      if (char === "\x1b") {
        const rest = input.slice(index);
        if (rest.startsWith("\x1b]")) {
          const bel = rest.indexOf("\x07");
          const st = rest.indexOf("\x1b\\");
          let end = -1;
          if (bel >= 0 && (st < 0 || bel < st)) end = bel + 1;
          else if (st >= 0) end = st + 2;
          if (end < 0) {
            this.#pending = rest;
            return;
          }
          index += end;
          continue;
        }
        if (rest.startsWith("\x1b[")) {
          const match = /^\x1b\[([0-9;?<>!=]*)[ -/]*([@-~])/.exec(rest);
          if (match === null) {
            this.#pending = rest;
            return;
          }
          this.#csi(match[1] ?? "", match[2] ?? "");
          index += match[0]!.length;
          continue;
        }
        index += 2;
        continue;
      }
      if (char === "\r") {
        this.#col = 0;
        index += 1;
        continue;
      }
      if (char === "\n") {
        this.#row = Math.min(this.rows - 1, this.#row + 1);
        index += 1;
        continue;
      }
      if (char === "\b") {
        this.#col = Math.max(0, this.#col - 1);
        index += 1;
        continue;
      }
      if (char === "\t") {
        this.#col = Math.min(this.cols - 1, this.#col + 1);
        index += 1;
        continue;
      }
      if (char === "\x00") {
        index += 1;
        continue;
      }
      this.#put(char);
      index += 1;
    }
  }

  #put(char: string): void {
    if (this.#row < 0 || this.#row >= this.rows) return;
    if (this.#col < 0 || this.#col >= this.cols) return;
    this.#grid[this.#row]![this.#col] = char;
    this.#col += 1;
  }

  #csi(rawParams: string, final: string): void {
    const privateSequence = rawParams.startsWith("?");
    const params = rawParams
      .replace(/^[?<>=!]/, "")
      .split(";")
      .map((value) => (value === "" ? undefined : Number(value)));
    const first = params[0];
    switch (final) {
      case "H":
      case "f":
        this.#row = (first && first > 0 ? first : 1) - 1;
        this.#col = (params[1] && params[1] > 0 ? params[1] : 1) - 1;
        return;
      case "A":
        this.#row = Math.max(0, this.#row - (first || 1));
        return;
      case "B":
        this.#row = Math.min(this.rows - 1, this.#row + (first || 1));
        return;
      case "C":
        this.#col = Math.min(this.cols - 1, this.#col + (first || 1));
        return;
      case "D":
        this.#col = Math.max(0, this.#col - (first || 1));
        return;
      case "G":
      case "`":
        this.#col = Math.max(0, (first || 1) - 1);
        return;
      case "d":
        this.#row = Math.max(0, (first || 1) - 1);
        return;
      case "J": {
        const mode = first || 0;
        if (mode === 2) for (const line of this.#grid) line.fill(" ");
        else if (mode === 0) {
          for (let col = this.#col; col < this.cols; col += 1) this.#grid[this.#row]![col] = " ";
          for (let row = this.#row + 1; row < this.rows; row += 1) this.#grid[row]!.fill(" ");
        } else if (mode === 1) {
          for (let row = 0; row < this.#row; row += 1) this.#grid[row]!.fill(" ");
          for (let col = 0; col <= this.#col; col += 1) this.#grid[this.#row]![col] = " ";
        }
        return;
      }
      case "K": {
        const mode = first || 0;
        const line = this.#grid[this.#row]!;
        if (mode === 0) for (let col = this.#col; col < this.cols; col += 1) line[col] = " ";
        else if (mode === 2) line.fill(" ");
        else if (mode === 1) for (let col = 0; col <= this.#col; col += 1) line[col] = " ";
        return;
      }
      case "s":
        this.#saved = { row: this.#row, col: this.#col };
        return;
      case "u":
        this.#row = this.#saved.row;
        this.#col = this.#saved.col;
        return;
      default:
        void privateSequence;
        return;
    }
  }
}

function blank(cols: number, rows: number): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
}
// END_BLOCK_SCREEN_BUFFER

// START_BLOCK_TUI_ACCEPTANCE
interface TuiOptions {
  readonly workspaceRoot: string;
  readonly hostBinary?: string | undefined;
  readonly scratchBase?: string | undefined;
  readonly keepScratch?: boolean | undefined;
  readonly onScratch?: ((path: string) => void) | undefined;
}

/** Run the real-PTY acceptance and return only observed results. */
export async function runTuiAcceptance(options: TuiOptions): Promise<TuiAcceptanceResult> {
  const scenarios: TuiScenarioResult[] = [];
  const fail = (id: string, detail: string): TuiScenarioResult => {
    const result = { id, status: "fail" as const, detail };
    scenarios.push(result);
    return result;
  };
  const pass = (id: string, detail: string): void => {
    scenarios.push({ id, status: "pass", detail });
  };

  const hostBinary = options.hostBinary ?? discoverHostBinary();
  if (hostBinary === undefined) {
    return {
      ok: false,
      implemented: true,
      sourceCommit: PINNED_SOURCE_COMMIT,
      scenarios,
      error: "no pinned OpenCode 2.0.18 host binary; set VVOC_E2E_V2_HOST",
      note: "TUI acceptance requires the pinned host binary.",
    };
  }
  const hostSha256 = await sha256File(hostBinary);
  if (hostSha256 !== PINNED_HOST_SHA256) {
    return {
      ok: false,
      implemented: true,
      hostSha256,
      sourceCommit: PINNED_SOURCE_COMMIT,
      scenarios,
      error: `host ${hostBinary} sha256 does not match the pin`,
      note: "Refusing to run against an unpinned host binary.",
    };
  }

  const workspaceTui = join(options.workspaceRoot, "dist", "tui.js");
  const workspaceServer = join(
    options.workspaceRoot,
    "dist",
    "plugins",
    "model-roles",
    "index.js",
  );
  try {
    await readFile(workspaceTui);
    await readFile(workspaceServer);
  } catch {
    return {
      ok: false,
      implemented: true,
      hostSha256,
      sourceCommit: PINNED_SOURCE_COMMIT,
      scenarios,
      error: "built dist/tui.js or model-roles plugin is missing; run bun run build first",
      note: "TUI acceptance packs and installs the actual built artifact.",
    };
  }
  let builtTui = workspaceTui;
  let builtServerPlugin = workspaceServer;

  const scratchBase = options.scratchBase ?? process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode";
  let scratch: OwnedScratch | undefined;
  let provider: UsageProvider | undefined;
  let child: ChildProcess | undefined;
  let terminal: Bun.Terminal | undefined;
  const view = { screen: new ScreenBuffer(160, 40) };
  try {
    scratch = await createOwnedScratch(scratchBase);
    options.onScratch?.(scratch.dir);
    const project = join(scratch.dir, "project");
    for (const name of ["home", "cfg", "data", "state", "cache", "project"]) {
      await mkdir(join(scratch.dir, name), { recursive: true });
    }
    // Real installed artifact: pack then install the declared dependency graph
    // into the isolated project (no workspace node_modules symlinks).
    const packedTarball = await packWorkspace({
      workspaceRoot: options.workspaceRoot,
      filename: join(scratch.dir, "pack", "vv-opencode-tui.tgz"),
    });
    const installed = await installPackedPackageWithDependencies({
      workspaceRoot: options.workspaceRoot,
      tarballPath: packedTarball.tarballPath,
      projectDir: project,
    });
    const installIssues = installedArtifactPathIssues(installed, options.workspaceRoot);
    if (installIssues.length > 0) {
      fail("installed-artifact", installIssues.join("; "));
      return result(hostSha256, scenarios, "The installed artifact resolved outside the isolated project.");
    }
    builtTui = join(installed.packageDir, "dist", "tui.js");
    builtServerPlugin = join(installed.packageDir, "dist", "plugins", "model-roles", "index.js");
    pass(
      "installed-artifact",
      `packed tarball ${packedTarball.sha256.slice(0, 12)} installed with declared deps at ${installed.packageDir}`,
    );

    const providerPort = await getFreePort();
    provider = createUsageProvider({
      port: providerPort,
      catalog: JSON.parse(
        await readFile(join(options.workspaceRoot, "scripts", "e2e-v2", "fixtures", "model-catalog.json"), "utf8"),
      ),
    });

    const serverDir = join(project, ".server-plugin");
    const tuiDir = join(project, ".tui-plugin");
    await mkdir(serverDir, { recursive: true });
    await mkdir(tuiDir, { recursive: true });
    await writeFile(
      join(serverDir, "package.json"),
      JSON.stringify({ name: "vvoc-tui-e2e-server", private: true, version: "0.0.0" }),
    );
    await writeFile(
      join(serverDir, "index.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(builtServerPlugin).href)};\n`,
    );
    await writeFile(
      join(tuiDir, "tui.js"),
      `export * from ${JSON.stringify(pathToFileURL(builtTui).href)};\nexport { default } from ${JSON.stringify(pathToFileURL(builtTui).href)};\n`,
    );
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify(
        {
          model: "deepseek/seam-smart",
          providers: {
            deepseek: {
              name: "E2E DeepSeek",
              package: "@opencode/ai/providers/openai-compatible",
              env: ["LOOPBACK_API_KEY"],
              settings: {
                baseURL: `http://127.0.0.1:${providerPort}/v1`,
                provider: "deepseek",
              },
              models: { "seam-smart": { name: "Seam Smart" } },
            },
          },
          plugins: [{ package: serverDir }],
        },
        null,
        2,
      ),
    );
    await mkdir(join(project, ".vvoc"), { recursive: true });
    // Render a schema-valid canonical vvoc config through the actual built
    // module, so the host accepts it and the real plugins can bind a family.
    const vvocModule = (await import(
      pathToFileURL(join(installed.packageDir, "dist", "lib", "vvoc-config.js")).href
    )) as {
      createDefaultVvocConfig(): Record<string, unknown>;
      renderVvocConfig(config: Record<string, unknown>): string;
    };
    const vvocConfig = vvocModule.createDefaultVvocConfig() as {
      roles: Record<string, string>;
      plugins: Record<string, unknown>;
    };
    vvocConfig.roles = {
      default: "deepseek/seam-smart",
      smart: "deepseek/seam-smart",
      fast: "deepseek/seam-smart",
      reviewer: "deepseek/seam-smart",
    };
    // A covering peak window makes the real peak-hours banner observable, and
    // the loopback provider reports cache usage for the cache indicator.
    vvocConfig.plugins["peak-hours"] = {
      enabled: true,
      mode: "soft",
      graceActiveSessions: true,
      schedules: { deepseek: { windows: [{ start: "00:00", end: "23:59", tz: "UTC" }] } },
    };
    await writeFile(join(project, ".vvoc", "vvoc.json"), vvocModule.renderVvocConfig(vvocConfig));
    await mkdir(join(scratch.dir, "cfg", "opencode"), { recursive: true });
    await writeFile(
      join(scratch.dir, "cfg", "opencode", "cli.json"),
      JSON.stringify({ plugins: [pathToFileURL(tuiDir).href] }, null, 2),
    );

    const env = buildHostEnv(process.env, {
      HOME: join(scratch.dir, "home"),
      XDG_CONFIG_HOME: join(scratch.dir, "cfg"),
      XDG_DATA_HOME: join(scratch.dir, "data"),
      XDG_STATE_HOME: join(scratch.dir, "state"),
      XDG_CACHE_HOME: join(scratch.dir, "cache"),
      LOOPBACK_API_KEY: "e2e-loopback-key",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    });

    // Open the session directly so the composer stays empty for /context. The
    // session is seeded through the host's own authenticated HTTP API, never by
    // replacing the plugin UI.
    const sessionID = await seedSession({
      hostBinary,
      project,
      scratchDir: scratch.dir,
      env,
    });
    if (sessionID === undefined) {
      fail("session", "could not seed a session through the native HTTP API");
      return result(hostSha256, scenarios, "The native session could not be seeded.");
    }
    pass("session", "seeded a real native session through the authenticated HTTP API");

    terminal = new Bun.Terminal({
      cols: 160,
      rows: 40,
      data(_terminal, data) {
        view.screen.write(new TextDecoder().decode(data));
      },
    });
    child = Bun.spawn([hostBinary, "--standalone", "--auto", "--session", sessionID], {
      cwd: project,
      env,
      terminal,
      stdout: "ignore",
      stderr: "ignore",
    }) as unknown as ChildProcess;

    await new Promise((resolve) => setTimeout(resolve, 8_000));
    if (view.screen.text().includes("Plugin failed")) {
      fail("plugin-load", `plugin failure banner on screen: ${screenExcerpt(view.screen)}`);
      return result(hostSha256, scenarios, "The built TUI plugin failed to load in the host.");
    }
    pass("startup", "the built TUI opened the seeded session with no plugin failure");

    // Real turn first, while the composer is clean, so usage-driven surfaces
    // can be observed before any dialog interaction.
    terminal.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.write("\r");
    const turned = await waitFor(view.screen, (text) => text.includes("e2e-ok"), 30_000);
    if (!turned) {
      fail("turn", `the loopback turn did not complete: ${screenExcerpt(view.screen)}`);
      return result(hostSha256, scenarios, "The loopback turn did not complete.");
    }
    pass("turn", "a real loopback turn completed in the TUI");

    // The TUI runs at 160 columns so the native session sidebar (width > 120)
    // and its sidebar.footer branding slot are visible without a repaint race.
    const surfaces = view.screen.text();
    if (!surfaces.includes("PEAK deepseek")) {
      fail("peak-banner", `peak-hours banner not visible: ${screenExcerpt(view.screen)}`);
    } else {
      pass("peak-banner", "the peak-hours banner rendered for a scheduled provider");
    }
    if (!/cache \d+%/.test(surfaces)) {
      fail("cache-indicator", `cache indicator not visible: ${screenExcerpt(view.screen)}`);
    } else {
      pass("cache-indicator", "the cache indicator rendered provider cache usage");
    }
    const version = await readPackageVersion(options.workspaceRoot);
    if (!surfaces.includes(`vvoc v${version}`)) {
      fail("branding-footer", `branding footer not visible: ${screenExcerpt(view.screen)}`);
    } else {
      pass("branding-footer", "the branding footer rendered the vvoc version");
    }

    // /context navigation.
    const overview = await openContextOverview(terminal, view.screen);
    if (!overview) {
      fail("overview-open", `/context did not open Overview: ${screenExcerpt(view.screen)}`);
      return result(hostSha256, scenarios, "The /context dialog did not open.");
    }
    pass("overview-open", "the /context dialog opened on Overview");
    if (!view.screen.text().includes("Context usage") || !view.screen.text().includes("Approximate breakdown")) {
      fail("overview-content", "Overview did not render its measured usage and breakdown");
    } else {
      pass("overview-content", "Overview rendered measured usage and the breakdown");
    }

    // Tab 2: Tools content must be active-content-specific, not a persistent label.
    terminal.write("2");
    const tools = await waitFor(view.screen, (text) => text.includes("[2 Tools]"), 8_000);
    if (!tools || !view.screen.text().includes("Registered tool catalog")) {
      fail("tools-tab", "the Tools tab did not render the registered catalog view");
    } else {
      pass("tools-tab", "the Tools tab rendered the registered catalog view");
    }

    // Tab 3: MCP status content.
    terminal.write("3");
    const mcp = await waitFor(view.screen, (text) => text.includes("[3 MCP]") && text.includes("MCP servers"), 8_000);
    if (!mcp) {
      fail("mcp-tab", "the MCP tab did not render native server status");
    } else {
      pass("mcp-tab", "the MCP tab rendered native server status");
    }

    // Narrow resize keeps the dialog readable and within the terminal width.
    view.screen = new ScreenBuffer(60, 40);
    terminal.resize(60, 40);
    terminal.write("1");
    await new Promise((resolve) => setTimeout(resolve, 400));
    terminal.write("3");
    const narrowed = await waitFor(view.screen, (text) => text.includes("[3 MCP]"), 8_000);
    const widthOk = narrowed && view.screen.text().split("\n").every((line) => line.length <= 60);
    if (!narrowed || !widthOk) {
      fail("narrow-resize", `the dialog did not reflow within 60 columns: ${screenExcerpt(view.screen)}`);
    } else {
      pass("narrow-resize", "the dialog reflowed within a 60-column terminal");
    }
    view.screen = new ScreenBuffer(160, 40);
    terminal.resize(160, 40);
    terminal.write("3");
    await waitFor(view.screen, (text) => text.includes("[3 MCP]"), 8_000);

    // Escape closes the dialog.
    terminal.write("\u001b");
    const closed = await waitFor(view.screen, (text) => !text.includes("[3 MCP]") && !text.includes("[1 Overview]"), 8_000);
    if (!closed) fail("close", `Escape did not close the /context dialog: ${screenExcerpt(view.screen)}`);
    else pass("close", "Escape closed the /context dialog");

    // Reopen resets to Overview.
    await new Promise((resolve) => setTimeout(resolve, 500));
    terminal.write("x");
    terminal.write("\u007f");
    const reopened = await openContextOverview(terminal, view.screen);
    if (!reopened) fail("reopen", `reopening /context did not reset to Overview: ${screenExcerpt(view.screen)}`);
    else pass("reopen", "reopening /context reset to Overview");

    // Scroll last, while the reopened dialog is open, so a failed scroll cannot
    // leak keys into the composer for later scenarios. A short-height Tools tab
    // overflows the bounded body; a real page/down key must change the frame.
    view.screen = new ScreenBuffer(60, 40);
    terminal.resize(60, 40);
    terminal.write("1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    terminal.write("2");
    await waitFor(view.screen, (text) => text.includes("[2 Tools]"), 8_000);
    const beforeScroll = view.screen.text();
    let afterScroll = beforeScroll;
    let dialogOpen = true;
    // Only complete CSI sequences: an SS3/lone-ESC form closes the dialog.
    for (const key of ["\u001b[6~", "\u001b[6~", "\u001b[6~", "\u001b[B", "\u001b[B"]) {
      terminal.write(key);
      await new Promise((resolve) => setTimeout(resolve, 500));
      afterScroll = view.screen.text();
      // The narrow tab bar truncates "[2 Tools]"; the Overview/MCP labels and
      // the stable footer note prove the dialog is still open.
      dialogOpen =
        afterScroll.includes("1 Overview") || afterScroll.includes("Measured = latest");
      if (!dialogOpen || afterScroll !== beforeScroll) break;
    }
    if (!dialogOpen) {
      fail("scroll", `the dialog closed during scroll input: ${screenExcerpt(view.screen)}`);
    } else if (beforeScroll === afterScroll) {
      fail("scroll", `the dialog body did not scroll: ${screenExcerpt(view.screen)}`);
    } else {
      pass("scroll", "the dialog body scrolled on a page/down key");
    }

    // Release the main standalone host before the extra runs: a concurrent
    // standalone server holds the project database lock, so a second host could
    // not seed a session.
    terminal.close();
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
    terminal = undefined;
    child = undefined;
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Controlled collection failure: run the same built TUI against a host with
    // no vvoc server bridge, so the inspection RPC is unavailable. The dialog
    // must still open, show the unavailable catalog/policy honestly, and close
    // and reopen without crashing.
    await runControlledFailure({
      hostBinary,
      project,
      scratchDir: scratch.dir,
      env,
      builtTui,
      scenarios,
      hostSha256,
    });

    // Explicit-disabled negative control: the captured policy disables context,
    // analytics, and peak-hours. The /context command must be suppressed and the
    // indicator/banner must not appear even after a real turn.
    await runDisabledNegative({
      hostBinary,
      project,
      scratchDir: scratch.dir,
      workspaceRoot: options.workspaceRoot,
      env,
      scenarios,
    });

    return result(
      hostSha256,
      scenarios,
      scenarios.some((scenario) => scenario.status === "fail")
        ? "At least one TUI scenario failed."
        : `Observed ${scenarios.length} PTY scenarios against the actual built TUI.`,
    );
  } catch (error) {
    scenarios.push({
      id: "harness",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
    return result(hostSha256, scenarios, "The TUI harness failed before completing.");
  } finally {
    terminal?.close();
    try {
      child?.kill("SIGTERM");
    } catch {
      // already exited
    }
    provider?.stop();
    if (scratch !== undefined && !options.keepScratch) {
      await removeOwnedScratch(scratch).catch(() => undefined);
    }
  }
}

function result(
  hostSha256: string,
  scenarios: readonly TuiScenarioResult[],
  note: string,
): TuiAcceptanceResult {
  return {
    ok: scenarios.length > 0 && scenarios.every((scenario) => scenario.status === "pass"),
    implemented: true,
    hostSha256,
    sourceCommit: PINNED_SOURCE_COMMIT,
    scenarios,
    note,
  };
}

/** Minimal OpenAI-compatible loopback provider that reports cache token usage. */
interface UsageProvider {
  readonly baseUrl: string;
  readonly port: number;
  stop(): void;
}

function createUsageProvider(input: { readonly port: number; readonly catalog: unknown }): UsageProvider {
  assertLoopbackHttpUrl(`http://127.0.0.1:${input.port}`, "loopback provider");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request
        .clone()
        .json()
        .catch(() => undefined)) as { model?: string } | undefined;
      if (url.pathname.endsWith("/models")) return Response.json(input.catalog);
      if (url.pathname.endsWith("/chat/completions")) {
        const model = body?.model ?? "unknown";
        const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
          `data: ${JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage === undefined ? {} : { usage }),
          })}\n\n`;
        const stream =
          chunk({ role: "assistant", content: "" }, null) +
          chunk({ content: "e2e-ok" }, null) +
          chunk({}, "stop", {
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
            prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 0 },
          }) +
          "data: [DONE]\n\n";
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${input.port}`, port: input.port, stop: () => server.stop(true) };
}

/**
 * Seed one native session for the project through the host's own
 * authenticated HTTP API, then stop the headless server. The session is a real
 * persisted native session; the TUI opens it with `--session`.
 */
async function seedSession(input: {
  readonly hostBinary: string;
  readonly project: string;
  readonly scratchDir: string;
  readonly env: Record<string, string>;
}): Promise<string | undefined> {
  const port = await getFreePort();
  const servicePath = join(input.scratchDir, "state", "opencode", "service.json");
  const server = Bun.spawn(
    [
      input.hostBinary,
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "error",
    ],
    { cwd: input.project, env: input.env, stdout: "ignore", stderr: "ignore" },
  );
  try {
    const password = await waitForRegisteredService({ servicePath, timeoutMs: 30_000 });
    const api = createNativeApi({
      baseUrl: `http://127.0.0.1:${port}`,
      password,
      directory: input.project,
    });
    // Service registration is not registry readiness: retry until the location
    // registry accepts a session (a `service_starting` race previously failed
    // the whole PTY tier).
    const deadline = Date.now() + 60_000;
    for (;;) {
      const created = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: input.project } }),
      }).catch(() => undefined);
      const id = (created?.body as { data?: { id?: string } } | undefined)?.data?.id;
      if (typeof id === "string" && id.length > 0) return id;
      if (Date.now() > deadline) return undefined;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  } catch {
    return undefined;
  } finally {
    try {
      server.kill("SIGTERM");
    } catch {
      // already exited
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

/** Read the workspace package version for the branding-footer assertion. */
async function readPackageVersion(workspaceRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

/**
 * Explicit-disabled negative control: the captured policy disables context,
 * analytics, and peak-hours, so the /context command is suppressed and the
 * indicator/banner must not render even after a real turn.
 */
async function runDisabledNegative(input: {
  readonly hostBinary: string;
  readonly project: string;
  readonly scratchDir: string;
  readonly workspaceRoot: string;
  readonly env: Record<string, string>;
  readonly scenarios: TuiScenarioResult[];
}): Promise<void> {
  const pass = (id: string, detail: string): void => {
    input.scenarios.push({ id, status: "pass", detail });
  };
  const fail = (id: string, detail: string): void => {
    input.scenarios.push({ id, status: "fail", detail });
  };
  const vvocPath = join(input.project, ".vvoc", "vvoc.json");
  const original = await readFile(vvocPath, "utf8");
  const builtModule = (await import(
    pathToFileURL(join(input.workspaceRoot, "dist", "lib", "vvoc-config.js")).href
  )) as { createDefaultVvocConfig(): Record<string, unknown>; renderVvocConfig(config: Record<string, unknown>): string };
  const config = builtModule.createDefaultVvocConfig() as {
    roles: Record<string, string>;
    plugins: Record<string, unknown>;
  };
  config.roles = {
    default: "deepseek/seam-smart",
    smart: "deepseek/seam-smart",
    fast: "deepseek/seam-smart",
    reviewer: "deepseek/seam-smart",
  };
  config.plugins = { context: false, analytics: false, "peak-hours": false };
  await writeFile(vvocPath, builtModule.renderVvocConfig(config as unknown as Record<string, unknown>));
  const sessionID = await seedSession({
    hostBinary: input.hostBinary,
    project: input.project,
    scratchDir: input.scratchDir,
    env: input.env,
  });
  if (sessionID === undefined) {
    fail("disabled-session", "could not seed a session for the disabled control");
    return;
  }
  const view = { screen: new ScreenBuffer(160, 40) };
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 40,
    data(_terminal, data) {
      view.screen.write(new TextDecoder().decode(data));
    },
  });
  const child = Bun.spawn(
    [input.hostBinary, "--standalone", "--auto", "--session", sessionID],
    { cwd: input.project, env: input.env, terminal, stdout: "ignore", stderr: "ignore" },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 9_000));
    terminal.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.write("\r");
    const turned = await waitFor(view.screen, (text) => text.includes("e2e-ok"), 30_000);
    if (!turned) {
      fail("disabled-turn", `the loopback turn did not complete: ${screenExcerpt(view.screen)}`);
      return;
    }
    const text = view.screen.text();
    if (text.includes("PEAK") || /cache \d+%/.test(text)) {
      fail("disabled-effects", `disabled policy still rendered an effect: ${screenExcerpt(view.screen)}`);
      return;
    }
    pass("disabled-effects", "disabled analytics/peak-hours rendered no indicator or banner");

    terminal.write("/context");
    await new Promise((resolve) => setTimeout(resolve, 500));
    terminal.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (view.screen.text().includes("[1 Overview]")) {
      fail("disabled-context", "/context opened despite an explicit disabled captured policy");
    } else {
      pass("disabled-context", "an explicit disabled captured policy suppressed /context");
    }
  } catch (error) {
    fail("disabled-harness", error instanceof Error ? error.message : String(error));
  } finally {
    terminal.close();
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
    await writeFile(vvocPath, original).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Controlled collection failure: run the same built TUI against a host with no
 * vvoc server bridge, so the inspection RPC is unavailable. The dialog must
 * still open, report the unavailable catalog/policy honestly, and close/reopen.
 */
async function runControlledFailure(input: {
  readonly hostBinary: string;
  readonly project: string;
  readonly scratchDir: string;
  readonly env: Record<string, string>;
  readonly builtTui: string;
  readonly scenarios: TuiScenarioResult[];
}): Promise<void> {
  const pass = (id: string, detail: string): void => {
    input.scenarios.push({ id, status: "pass", detail });
  };
  const fail = (id: string, detail: string): void => {
    input.scenarios.push({ id, status: "fail", detail });
  };
  const configPath = join(input.project, "opencode.json");
  const original = await readFile(configPath, "utf8");
  await writeFile(configPath, JSON.stringify({ plugins: [] }, null, 2));
  const sessionID = await seedSession({
    hostBinary: input.hostBinary,
    project: input.project,
    scratchDir: input.scratchDir,
    env: input.env,
  });
  if (sessionID === undefined) {
    fail("failure-session", "could not seed a session without the server bridge");
    await writeFile(configPath, original).catch(() => undefined);
    return;
  }
  const view = { screen: new ScreenBuffer(160, 40) };
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 40,
    data(_terminal, data) {
      view.screen.write(new TextDecoder().decode(data));
    },
  });
  const child = Bun.spawn(
    [input.hostBinary, "--standalone", "--auto", "--session", sessionID],
    { cwd: input.project, env: input.env, terminal, stdout: "ignore", stderr: "ignore" },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 9_000));
    if (view.screen.text().includes("Plugin failed")) {
      fail("failure-startup", `plugin failure without the bridge: ${screenExcerpt(view.screen)}`);
      return;
    }
    if (!(await openContextOverview(terminal, view.screen))) {
      fail("failure-open", `the /context dialog did not open without the bridge: ${screenExcerpt(view.screen)}`);
      return;
    }
    if (!view.screen.text().includes("Provider usage is not available")) {
      fail("failure-overview", `Overview did not report unavailable usage: ${screenExcerpt(view.screen)}`);
      return;
    }
    terminal.write("2");
    await waitFor(view.screen, (text) => text.includes("[2 Tools]"), 8_000);
    const toolsText = view.screen.text();
    if (!toolsText.includes("Catalog status: unavailable") || !toolsText.includes("unavailable")) {
      fail("failure-catalog", `Tools did not report an unavailable catalog: ${screenExcerpt(view.screen)}`);
      return;
    }
    pass("failure-catalog", "the /context dialog reported the unavailable catalog honestly");
    terminal.write("\u001b");
    const closed = await waitFor(
      view.screen,
      (text) => !text.includes("[1 Overview]") && !text.includes("[2 Tools]"),
      8_000,
    );
    if (!closed) {
      fail("failure-close", "Escape did not close the failure dialog");
      return;
    }
    if (!(await openContextOverview(terminal, view.screen))) {
      fail("failure-reopen", "reopen did not reset to Overview under failure");
      return;
    }
    pass("failure-reopen", "the controlled failure dialog closed and reopened");
  } catch (error) {
    fail("failure-harness", error instanceof Error ? error.message : String(error));
  } finally {
    terminal.close();
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
    await writeFile(configPath, original).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Bounded one-line screen excerpt for failure diagnostics. */
function screenExcerpt(screen: ScreenBuffer): string {
  return screen
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ")
    .slice(0, 400);
}

/** Type /context and submit it, tolerating a completion list that consumes the first Enter. */
async function openContextOverview(
  terminal: Bun.Terminal,
  screen: ScreenBuffer,
): Promise<boolean> {
  terminal.write("/context");
  await new Promise((resolve) => setTimeout(resolve, 600));
  terminal.write("\r");
  if (await waitFor(screen, (text) => text.includes("[1 Overview]"), 10_000)) return true;
  terminal.write("\r");
  return waitFor(screen, (text) => text.includes("[1 Overview]"), 10_000);
}

async function waitFor(
  screen: ScreenBuffer,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(screen.text())) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
// END_BLOCK_TUI_ACCEPTANCE
