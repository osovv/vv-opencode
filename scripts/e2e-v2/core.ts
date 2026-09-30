#!/usr/bin/env bun
// FILE: scripts/e2e-v2/core.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Orchestrate the isolated packed-package core real-host run: build, pack, install, prepare the fixture project, own the host lifecycle on an ownership-marked scratch, drive the core cases, and persist bounded machine-readable evidence.
//   SCOPE: Ownership-marked scratch creation/removal, in-process loopback provider, packed fixture plugin materialization, exact-PID host startup/restart/teardown, bounded control-plane and native API driver, per-request provider attribution, case execution, and evidence writing. It never signs services, never kills by name, and never dispatches to a non-loopback origin.
//   DEPENDS: [node:fs/promises, node:net, node:path, node:url, scripts/e2e-v2/cases.ts, scripts/e2e-v2/host.ts, scripts/e2e-v2/provider.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CoreRunOptions - Inputs controlling one core real-host run.
//   CoreRunSummary - Machine-readable summary of one core real-host run.
//   ROOT_PLUGIN_EXPORTS - The eleven native server plugin named exports the root aggregate must publish.
//   OwnedToolIds - The nine vvoc-owned tool ids (the host subagent tool is never a tenth registration).
//   InstalledSurfaceCheck - One installed-artifact surface check outcome.
//   InstalledSurfaceResult - Outcome of the installed-artifact surface checks.
//   runInstalledSurface - Verify the installed package surface, presets, managed assets, and installed CLI lifecycle.
//   getFreePort - Reserve and release a loopback TCP port.
//   runCore - Execute the packed core real-host run and return its summary.
//   requireHostBinary - Resolve the pinned host binary or throw a bounded diagnostics error.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-FULL - Installs the packed tarball with its declared dependency graph, verifies per-row outcomes, and drives the INSTALLED root aggregate on the real host control plane: system-context injection, analytics usage, peak-hours PRIMARY gating, web-tools permission-before-network, guardian deny/allow file-write gating, hashline-edit routed-tool + stale-anchor rejection, spec-guard scoped enforcement, and tool-history-compaction of the real dispatched request; retries readiness and deterministically replays the auxiliary family after restart.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-009-FULL - Installed-surface checks (root aggregate, standalone subpaths, nine-tool census, presets/variants, managed agents/skills, installed CLI lifecycle).]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-003 correction - Owned scratch lifecycle, bounded host output/control, guard-aware evidence, and restart coverage of auxiliary families.]
// END_CHANGE_SUMMARY

import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  coreCases,
  Checks,
  ORDERING_DELAY_MARKER,
  type CaseResult,
  type CoreDriver,
} from "./cases.js";
import {
  OwnedProcesses,
  buildHostEnv,
  createNativeApi,
  createOwnedScratch,
  discoverHostBinary,
  installPackedPackageWithDependencies,
  installedArtifactPathIssues,
  packWorkspace,
  redactEnv,
  removeOwnedScratch,
  runCommand,
  sha256File,
  verifyPackedArtifact,
  waitForRegisteredService,
  type OwnedScratch,
  PINNED_HOST_SHA256,
  PINNED_HOST_VERSION,
  PINNED_SOURCE_COMMIT,
} from "./host.js";
import { createLoopbackProvider, readProviderTrace, type ProviderRequestRecord } from "./provider.js";

/** Inputs controlling one core real-host run. */
export interface CoreRunOptions {
  readonly workspaceRoot: string;
  readonly hostBinary: string;
  readonly scratchBase: string;
  readonly evidencePath?: string;
  readonly build?: boolean;
  readonly keepScratch?: boolean;
  readonly caseTimeoutMs?: number;
}

/** Machine-readable summary of one core real-host run. */
export interface CoreRunSummary {
  readonly ok: boolean;
  readonly cases: readonly CaseResult[];
  readonly evidencePath?: string;
  readonly tarballSha256?: string;
  readonly installed?: {
    readonly packageDir: string;
    readonly packageVersion: string;
    readonly resolvedDependencies: Readonly<Record<string, string>>;
    readonly loadedPaths: Readonly<Record<string, string>>;
  };
  readonly installedSurface?: InstalledSurfaceResult;
  readonly aggregateChecks?: readonly AggregateCheck[];
  readonly error?: string;
}

// START_BLOCK_PORT
/** Reserve and release a loopback TCP port. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}
// END_BLOCK_PORT

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** True once an owned PID no longer exists; polls without signalling anything else. */
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await delay(200);
  }
}

// START_BLOCK_VVOC_CONFIG
/** Render and write the isolated project's canonical vvoc role configuration. */
async function writeVvocRolesFile(input: {
  readonly workspaceRoot: string;
  readonly projectDir: string;
  readonly allPlain: boolean;
}): Promise<void> {
  const modulePath = pathToFileURL(join(input.workspaceRoot, "dist", "lib", "vvoc-config.js")).href;
  const mod = (await import(modulePath)) as {
    createDefaultVvocConfig(): Record<string, unknown>;
    renderVvocConfig(config: Record<string, unknown>): string;
  };
  const config = mod.createDefaultVvocConfig() as { roles: Record<string, string> };
  config.roles = {
    default: input.allPlain ? "loopback/seam-smart#plain" : "loopback/seam-smart#override",
    smart: input.allPlain ? "loopback/seam-smart#plain" : "loopback/seam-smart#override",
    fast: "loopback/seam-smart#plain",
    reviewer: "loopback/seam-smart#plain",
  };
  await writeFile(join(input.projectDir, ".vvoc", "vvoc.json"), mod.renderVvocConfig(config));
}
// END_BLOCK_VVOC_CONFIG

// START_BLOCK_FIXTURE_FILES
/** Generate the isolated fixture plugin entry that wraps the packed actual plugin. */
function fixturePluginSource(input: {
  readonly fixtureFactoryPath: string;
  readonly packedPackageDir: string;
}): string {
  return [
    `import { createHarnessPlugin } from ${JSON.stringify(input.fixtureFactoryPath)};`,
    `import { ModelRolesPlugin } from "@osovv/vv-opencode/plugins/model-roles";`,
    `import { acquireNativeSnapshotRuntime } from ${JSON.stringify(
      join(input.packedPackageDir, "dist", "runtime", "context.js"),
    )};`,
    `export default createHarnessPlugin({`,
    `  modelRolesPlugin: ModelRolesPlugin,`,
    `  acquireRuntime: (ctx) => acquireNativeSnapshotRuntime(ctx),`,
    `  controlFilePath: process.env.VVOC_E2E_CONTROL_FILE,`,
    `  providerOrigin: process.env.VVOC_E2E_PROVIDER_ORIGIN,`,
    `  allowedProviders: (process.env.VVOC_E2E_ALLOWED_PROVIDERS ?? "loopback").split(","),`,
    `  tracePath: process.env.VVOC_E2E_TRACE,`,
    `  delayMarker: process.env.VVOC_E2E_DELAY_MARKER,`,
    `  delayMs: Number(process.env.VVOC_E2E_DELAY_MS ?? "0"),`,
    `});`,
    ``,
  ].join("\n");
}

/** Render the isolated project's native OpenCode configuration. */
function opencodeConfig(input: {
  readonly providerPort: number;
  readonly pluginDir: string;
}): unknown {
  return {
    model: "loopback/seam-smart",
    permissions: [
      { action: "e2e.probe.allow", resource: "e2e://resource", effect: "ask" },
      { action: "e2e.probe.deny", resource: "e2e://resource", effect: "ask" },
      { action: "e2e.guard.allow", resource: "e2e://resource", effect: "ask" },
      { action: "e2e.guard.deny", resource: "e2e://resource", effect: "ask" },
    ],
    providers: {
      loopback: {
        name: "E2E Loopback",
        package: "@opencode/ai/providers/openai-compatible",
        env: ["LOOPBACK_API_KEY"],
        settings: {
          baseURL: `http://127.0.0.1:${input.providerPort}/v1`,
          provider: "loopback",
        },
        models: {
          "seam-smart": {
            name: "Seam Smart",
            settings: { reasoningEffort: "low" },
            variants: [
              {
                id: "override",
                settings: { reasoningEffort: "high" },
                body: { smoke_variant: "override" },
              },
              {
                id: "plain",
                settings: { reasoningEffort: "minimal" },
                body: { smoke_variant: "plain" },
              },
            ],
          },
          "seam-fast": { name: "Seam Fast" },
        },
      },
    },
    plugins: [{ package: input.pluginDir }],
  };
}
// END_BLOCK_FIXTURE_FILES

/** Bounded JSON fetch against the fixture control plane. */
async function controlFetch(
  origin: string,
  nonce: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
  timeoutMs = 30_000,
): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "x-e2e-nonce": nonce,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = (await response.text()).slice(0, 512 * 1024);
    let body: any;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// START_BLOCK_DRIVER
/** Build the driver that talks to the owned host and its control plane. */
function createDriver(input: {
  readonly workspaceRoot: string;
  readonly scratchDir: string;
  readonly projectDir: string;
  readonly providerPort: number;
  readonly packedSha256: string;
  readonly packageDir: string;
  readonly packedVersion: string;
  readonly hostSha256: string;
  readonly api: ReturnType<typeof createNativeApi>;
  readonly control: CoreDriver["control"];
}): CoreDriver {
  const readTrace = async (): Promise<ProviderRequestRecord[]> =>
    readProviderTrace(join(input.scratchDir, "trace", "provider.jsonl"));
  return {
    workspaceRoot: input.workspaceRoot,
    scratchDir: input.scratchDir,
    projectDir: input.projectDir,
    providerPort: input.providerPort,
    packedSha256: input.packedSha256,
    packageDir: input.packageDir,
    packedVersion: input.packedVersion,
    hostSha256: input.hostSha256,
    sourceCommit: PINNED_SOURCE_COMMIT,
    missingAttachmentUri: pathToFileURL(
      join(input.scratchDir, "definitely-missing-attachment.txt"),
    ).href,
    api: input.api,
    control: input.control,
    async createSession(body = {}) {
      const response = await input.api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: input.projectDir }, ...body }),
      });
      const id = (response.body as { data?: { id?: string } } | undefined)?.data?.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`session create failed (${response.status}): ${response.text}`);
      }
      return id;
    },
    async deleteSession(id) {
      await input.api(`/api/session/${id}`, { method: "DELETE" }).catch(() => undefined);
    },
    async sessionInfo(id) {
      const response = await input.api(`/api/session/${id}`);
      return (response.body as { data?: any } | undefined)?.data;
    },
    async listSessions() {
      const response = await input.api(
        `/api/session?location[directory]=${encodeURIComponent(input.projectDir)}`,
      );
      return (response.body as { data?: any[] } | undefined)?.data ?? [];
    },
    async prompt(id, text, extra = {}) {
      const response = await input.api(`/api/session/${id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text, ...extra }),
      });
      return { status: response.status };
    },
    async generate(id, prompt) {
      const response = await input.api(`/api/session/${id}/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      return { status: response.status, text: (response.body as any)?.data?.text };
    },
    async synthetic(id, text, extra = {}) {
      const response = await input.api(`/api/session/${id}/synthetic`, {
        method: "POST",
        body: JSON.stringify({ text, ...extra }),
      });
      return { status: response.status };
    },
    async switchModel(id, model) {
      const response = await input.api(`/api/session/${id}/model`, {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      return { status: response.status };
    },
    async fork(id) {
      const response = await input.api(`/api/session/${id}/fork`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const forkID = (response.body as { data?: { id?: string } } | undefined)?.data?.id;
      return { status: response.status, id: forkID };
    },
    async move(id, directory) {
      const response = await input.api(`/api/session/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ directory }),
      });
      return { status: response.status };
    },
    async worktreeCreate(body) {
      const response = await input.api("/api/worktree", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const responseBody = response.body as any;
      return {
        status: response.status,
        directory: responseBody?.directory ?? responseBody?.data?.directory,
        error: response.status >= 400 ? response.text : undefined,
      };
    },
    async worktreeRefresh(projectID) {
      await input.api("/api/worktree/refresh", {
        method: "POST",
        body: JSON.stringify({ projectID }),
      }).catch(() => undefined);
    },
    async worktreeRemove(directory) {
      await input.api("/api/worktree", {
        method: "DELETE",
        body: JSON.stringify({ directory }),
      }).catch(() => undefined);
    },
    async modelList() {
      const response = await input.api("/api/model");
      return (response.body as { data?: unknown } | undefined)?.data;
    },
    async providerCount() {
      return (await readTrace()).filter((record) => record.event === "provider.request").length;
    },
    async providerRequestsSince(index) {
      const records = (await readTrace()).filter((record) => record.event === "provider.request");
      return records.slice(index);
    },
    async waitIdleChange(id, previousIdle, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const info = await this.sessionInfo(id);
        const idle = info?.time?.idle;
        if (idle !== undefined && idle !== previousIdle) return info;
        if (Date.now() > deadline) {
          throw new Error(`session ${id} did not reach a new idle terminal state within ${timeoutMs}ms`);
        }
        await delay(300);
      }
    },
    async writeVvocRoles({ allPlain }) {
      await writeVvocRolesFile({
        workspaceRoot: input.workspaceRoot,
        projectDir: input.projectDir,
        allPlain,
      });
    },
  };
}
// END_BLOCK_DRIVER

// START_BLOCK_RUN
/** Execute the packed core real-host run and return its summary. */
export async function runCore(options: CoreRunOptions): Promise<CoreRunSummary> {
  const owned = new OwnedProcesses();
  const results: CaseResult[] = [];
  let scratch: OwnedScratch | undefined;
  let provider: Awaited<ReturnType<typeof createLoopbackProvider>> | undefined;
  let hostPid: number | undefined;
  try {
    scratch = await createOwnedScratch(options.scratchBase);
    const scratchDir = scratch.dir;
    const projectDir = join(scratchDir, "project");
    const packed = join(scratchDir, "pack");
    const pluginDir = join(projectDir, ".e2e-plugin");
    const traceDir = join(scratchDir, "trace");
    const controlFilePath = join(traceDir, "control.json");
    const servicePath = join(scratchDir, "state", "opencode", "service.json");
    const configServicePath = join(scratchDir, "cfg", "opencode", "service.json");

    await mkdir(join(projectDir, ".vvoc"), { recursive: true });
    await mkdir(traceDir, { recursive: true });
    for (const dir of ["home", "cfg", "data", "state", "cache"]) {
      await mkdir(join(scratchDir, dir), { recursive: true });
    }
    await mkdir(pluginDir, { recursive: true });

    if (options.build !== false) {
      const build = await runCommand("bun", ["run", "build"], { cwd: options.workspaceRoot });
      if (build.status !== 0) {
        throw new Error(`bun run build failed with ${build.status}: ${build.stderr}`);
      }
    }

    const hostSha256 = await sha256File(options.hostBinary);
    if (hostSha256 !== PINNED_HOST_SHA256) {
      throw new Error(
        `refusing host ${options.hostBinary}: sha256 ${hostSha256} does not match the pinned host`,
      );
    }

    const packedTarball = await packWorkspace({
      workspaceRoot: options.workspaceRoot,
      filename: join(packed, "vv-opencode-e2e.tgz"),
    });
    const installed = await installPackedPackageWithDependencies({
      workspaceRoot: options.workspaceRoot,
      tarballPath: packedTarball.tarballPath,
      projectDir,
    });
    const installIssues = installedArtifactPathIssues(installed, options.workspaceRoot);
    if (installIssues.length > 0) throw new Error(installIssues.join("; "));
    const packageDir = installed.packageDir;
    const packedManifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    const packedArtifact = await verifyPackedArtifact({
      tarballPath: packedTarball.tarballPath,
      name: packedManifest.name ?? "@osovv/vv-opencode",
      version: packedManifest.version ?? "0.0.0",
    });

    const providerPort = await getFreePort();
    provider = await createLoopbackProvider({
      port: providerPort,
      tracePath: join(traceDir, "provider.jsonl"),
      catalog: JSON.parse(
        await readFile(
          join(options.workspaceRoot, "scripts", "e2e-v2", "fixtures", "model-catalog.json"),
          "utf8",
        ),
      ),
    });
    const providerOrigin = provider.baseUrl;

    const fixtureFactoryPath = join(
      options.workspaceRoot,
      "scripts",
      "e2e-v2",
      "fixtures",
      "plugin.ts",
    );
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "vvoc-e2e-fixture", private: true, version: "0.0.0" }),
    );
    await writeFile(
      join(pluginDir, "index.ts"),
      fixturePluginSource({ fixtureFactoryPath, packedPackageDir: packageDir }),
    );
    await writeFile(
      join(projectDir, "opencode.json"),
      JSON.stringify(opencodeConfig({ providerPort, pluginDir }), null, 2),
    );
    await writeVvocRolesFile({ workspaceRoot: options.workspaceRoot, projectDir, allPlain: false });
    // Owned git fixture so native worktree creation has a repository strategy.
    await writeFile(join(projectDir, ".gitignore"), "node_modules\n.e2e-plugin\n");
    await runCommand("git", ["init", "-q", projectDir], { cwd: projectDir });
    await runCommand("git", ["-C", projectDir, "add", "opencode.json", ".vvoc", ".gitignore"], {
      cwd: projectDir,
    });
    const commit = await runCommand(
      "git",
      [
        "-C",
        projectDir,
        "-c",
        "user.email=e2e@vvoc.local",
        "-c",
        "user.name=e2e",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-q",
        "-m",
        "fixture",
      ],
      { cwd: projectDir },
    );
    if (commit.status !== 0) {
      throw new Error(`fixture git commit failed (${commit.status}): ${commit.stderr}`);
    }

    const env = buildHostEnv(process.env, {
      HOME: join(scratchDir, "home"),
      XDG_CONFIG_HOME: join(scratchDir, "cfg"),
      XDG_DATA_HOME: join(scratchDir, "data"),
      XDG_STATE_HOME: join(scratchDir, "state"),
      XDG_CACHE_HOME: join(scratchDir, "cache"),
      LOOPBACK_API_KEY: "e2e-loopback-key",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      VVOC_E2E_CONTROL_FILE: controlFilePath,
      VVOC_E2E_PROVIDER_ORIGIN: providerOrigin,
      VVOC_E2E_ALLOWED_PROVIDERS: "loopback",
      VVOC_E2E_TRACE: join(traceDir, "observer.jsonl"),
      VVOC_E2E_DELAY_MARKER: ORDERING_DELAY_MARKER,
      VVOC_E2E_DELAY_MS: "5000",
    });
    let hostOutput = "";
    const startHost = async (): Promise<{
      readonly api: ReturnType<typeof createNativeApi>;
      readonly hostPort: number;
    }> => {
      const hostPort = await getFreePort();
      const host = owned.spawn(
        options.hostBinary,
        [
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(hostPort),
          "--log-level",
          "error",
        ],
        { cwd: projectDir, env },
      );
      hostPid = host.pid;
      const attach = (chunk: Buffer): void => {
        if (hostOutput.length < 64 * 1024) hostOutput = (hostOutput + chunk.toString()).slice(0, 64 * 1024);
      };
      host.stdout?.on("data", attach);
      host.stderr?.on("data", attach);
      const password = await waitForRegisteredService({ servicePath, timeoutMs: 30_000 });
      return {
        api: createNativeApi({
          baseUrl: `http://127.0.0.1:${hostPort}`,
          password,
          directory: projectDir,
        }),
        hostPort,
      };
    };

    let { api } = await startHost();

    // Plugins activate during the first model request, so a warmup prompt both
    // opens the project location and publishes the fixture control plane. The
    // warmup family is a separate session and never substitutes for a case.
    // Service registration is not registry readiness: retry until the location
    // registry accepts a session.
    const warmupDeadline = Date.now() + 60_000;
    let warmupID = "";
    for (;;) {
      const opened = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: projectDir } }),
      }).catch(() => undefined);
      const id = (opened?.body as { data?: { id?: string } } | undefined)?.data?.id;
      if (typeof id === "string") {
        warmupID = id;
        break;
      }
      if (Date.now() > warmupDeadline) {
        throw new Error(`project location did not open: ${opened?.text ?? "no response"}`);
      }
      await delay(500);
    }
    await api(`/api/session/${warmupID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "harness activation warmup" }),
    }).catch(() => undefined);

    const waitForControl = async (): Promise<{ port: number; nonce: string }> => {
      const controlDeadline = Date.now() + 45_000;
      for (;;) {
        try {
          const parsed = JSON.parse(await readFile(controlFilePath, "utf8")) as {
            port?: number;
            nonce?: string;
            stage?: string;
          };
          if (
            typeof parsed.port === "number" &&
            parsed.port > 0 &&
            typeof parsed.nonce === "string" &&
            parsed.nonce.length > 0
          ) {
            return { port: parsed.port, nonce: parsed.nonce };
          }
          if (parsed.stage === "setup-error") {
            throw new Error(`fixture setup failed: ${JSON.stringify(parsed)}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("fixture setup failed")) throw error;
          // not published yet
        }
        if (Date.now() > controlDeadline) {
          throw new Error(
            `fixture control plane did not start; host output: ${hostOutput.slice(-4000)}`,
          );
        }
        await delay(250);
      }
    };
    const makeControl =
      (info: { port: number; nonce: string }): CoreDriver["control"] =>
      (path, init) =>
        controlFetch(`http://127.0.0.1:${info.port}`, info.nonce, path, init);
    const control = makeControl(await waitForControl());

    const driver = createDriver({
      workspaceRoot: options.workspaceRoot,
      scratchDir,
      projectDir,
      providerPort,
      packedSha256: packedTarball.sha256,
      packageDir,
      packedVersion: packedManifest.version ?? "unknown",
      hostSha256,
      api,
      control,
    });

    const caseTimeoutMs = options.caseTimeoutMs ?? 90_000;
    for (const coreCase of coreCases) {
      const check = new Checks();
      let status: CaseResult["status"] = "pass";
      let detail = "";
      let observed: unknown;
      const startedAt = Date.now();
      try {
        const outcome = await Promise.race([
          coreCase.run(driver, check),
          new Promise<never>((_, rejectPromise) =>
            setTimeout(
              () => rejectPromise(new Error(`case timeout after ${caseTimeoutMs}ms`)),
              caseTimeoutMs,
            ),
          ),
        ]);
        detail = outcome.detail;
        observed = outcome.observed;
      } catch (error) {
        status = "fail";
        detail = error instanceof Error ? error.message : String(error);
      }
      if (status === "pass" && check.failed.length > 0) status = "fail";
      results.push({
        id: coreCase.id,
        title: coreCase.title,
        phase: coreCase.phase,
        parity: coreCase.parity,
        status,
        detail,
        assertions: check.passed,
        failures: check.failed,
        durationMs: Date.now() - startedAt,
        ...(observed === undefined ? {} : { observed }),
      });
    }

    // START_BLOCK_REPLAY_RESTART
    // Durable replay after a real service restart: the runner owns the host
    // lifecycle, so this case rebinds the same persisted root and auxiliary
    // sessions after a fresh host instance and checks both family captures
    // and payloads survived.
    {
      const check = new Checks();
      const startedAt = Date.now();
      let status: CaseResult["status"] = "pass";
      let detail = "";
      let observed: unknown;
      try {
        await writeVvocRolesFile({
          workspaceRoot: options.workspaceRoot,
          projectDir,
          allPlain: false,
        });
        await delay(1500);

        const root = await api("/api/session", {
          method: "POST",
          body: JSON.stringify({ location: { directory: projectDir } }),
        });
        const rootID = (root.body as { data?: { id?: string } } | undefined)?.data?.id;
        if (typeof rootID !== "string") throw new Error("restart root session not created");
        await delay(1000);
        const beforeRoot = (await driver.sessionInfo(rootID))?.time?.idle;
        await api(`/api/session/${rootID}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: "pre-restart replay" }),
        });
        const rootInfo = await driver.waitIdleChange(rootID, beforeRoot);
        const rootVariant = rootInfo?.model?.variant as string | undefined;
        check.truthy(
          typeof rootVariant === "string" && rootVariant.includes(".seam-smart."),
          `pre-restart root family bound a snapshot variant (${rootVariant})`,
        );
        const rootConfigBefore = await driver.control(`/config?sessionID=${rootID}`);
        const aux = (await driver.listSessions()).find((entry) => entry.parentID === rootID);
        check.truthy(aux !== undefined, "pre-restart auxiliary family exists");
        const auxID = aux?.id as string | undefined;
        let auxVariant: string | undefined;
        let auxConfigBefore: any;
        if (auxID !== undefined) {
          auxVariant = (await driver.sessionInfo(auxID))?.model?.variant;
          auxConfigBefore = await driver.control(`/config?sessionID=${auxID}`);
          check.equal(
            auxConfigBefore.body?.capture?.snapshotId,
            rootConfigBefore.body?.capture?.snapshotId,
            "pre-restart auxiliary shares the root family snapshot",
          );
        }

        // Restart the owned host instance. Only the exact owned live handle is signalled.
        await unlink(servicePath).catch(() => undefined);
        await unlink(configServicePath).catch(() => undefined);
        await rm(controlFilePath, { force: true });
        const oldPid = hostPid as number;
        owned.signal(oldPid, "SIGTERM");
        check.truthy(await waitForPidExit(oldPid, 20_000), "first host instance exited before restart");

        const restarted = await startHost();
        api = restarted.api;
        // Retry activation until the restarted fixture publishes its control plane.
        let controlAfterRestart: CoreDriver["control"] | undefined;
        const restartControlDeadline = Date.now() + 60_000;
        for (;;) {
          try {
            const warm = await api("/api/session", {
              method: "POST",
              body: JSON.stringify({ location: { directory: projectDir } }),
            });
            const warmID = (warm.body as { data?: { id?: string } } | undefined)?.data?.id;
            if (typeof warmID === "string") {
              await api(`/api/session/${warmID}/prompt`, {
                method: "POST",
                body: JSON.stringify({ text: "restart warmup" }),
              }).catch(() => undefined);
            }
          } catch {
            // retry
          }
          try {
            const parsed = JSON.parse(await readFile(controlFilePath, "utf8")) as {
              port?: number;
              nonce?: string;
            };
            if (
              typeof parsed.port === "number" &&
              parsed.port > 0 &&
              typeof parsed.nonce === "string" &&
              parsed.nonce.length > 0
            ) {
              controlAfterRestart = makeControl({ port: parsed.port, nonce: parsed.nonce });
              break;
            }
          } catch {
            // retry
          }
          if (Date.now() > restartControlDeadline) {
            throw new Error(
              `restarted fixture control plane did not start; host output: ${hostOutput.slice(-3000)}`,
            );
          }
          await delay(1000);
        }
        if (controlAfterRestart === undefined) {
          throw new Error("restarted fixture control plane unavailable");
        }
        const restartStatus = await controlAfterRestart("/status");
        check.truthy(
          restartStatus.body?.ok === true,
          "packed fixture control plane re-registered on the new host instance",
        );
        const driverAfterRestart = createDriver({
          workspaceRoot: options.workspaceRoot,
          scratchDir,
          projectDir,
          providerPort,
          packedSha256: packedTarball.sha256,
          packageDir,
          packedVersion: packedManifest.version ?? "unknown",
          hostSha256,
          api,
          control: controlAfterRestart,
        });

        // Root replay: same persisted capture and same qualified variant/payload.
        const beforeRoot2 = (await driverAfterRestart.sessionInfo(rootID))?.time?.idle;
        const restartProviderBase = await driverAfterRestart.providerCount();
        await api(`/api/session/${rootID}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: "post-restart replay" }),
        });
        const rootAfter = await driverAfterRestart.waitIdleChange(rootID, beforeRoot2);
        check.equal(
          rootAfter?.model?.variant,
          rootVariant,
          "persisted root family capture replayed after a real service restart",
        );
        const rootVariantName =
          typeof rootVariant === "string" ? rootVariant.replace(/.*\.seam-smart\./, "") : undefined;
        const restartFresh = await driverAfterRestart.providerRequestsSince(restartProviderBase);
        check.truthy(
          restartFresh.some(
            (record) =>
              JSON.stringify(record.body ?? "").includes("post-restart replay") &&
              (record.body as { smoke_variant?: unknown } | undefined)?.smoke_variant ===
                rootVariantName,
          ),
          "the replayed root family dispatched its persisted variant payload after restart",
        );
        // Auxiliary replay: its configFor still resolves the same snapshot.
        if (auxID !== undefined) {
          const auxConfigAfter = await controlAfterRestart(`/config?sessionID=${auxID}`);
          check.equal(
            auxConfigAfter.body?.capture?.snapshotId,
            rootConfigBefore.body?.capture?.snapshotId,
            "persisted auxiliary family capture replayed after restart",
          );
          check.equal(
            (await driverAfterRestart.sessionInfo(auxID))?.model?.variant,
            auxVariant,
            "auxiliary child kept its qualified variant after restart",
          );
          const auxVariantName =
            typeof auxVariant === "string" ? auxVariant.replace(/.*\.seam-smart\./, "") : undefined;
          // Drive the auxiliary family directly after restart so its persisted
          // capture/variant must dispatch deterministically (a title request is
          // not guaranteed for an already-titled session).
          const auxProviderBase = await driverAfterRestart.providerCount();
          await api(`/api/session/${auxID}/prompt`, {
            method: "POST",
            body: JSON.stringify({ text: "aux post-restart replay marker" }),
          }).catch(() => undefined);
          let auxDispatched = false;
          const auxDeadline = Date.now() + 20_000;
          while (!auxDispatched && Date.now() < auxDeadline) {
            const fresh = await driverAfterRestart.providerRequestsSince(auxProviderBase);
            auxDispatched = fresh.some(
              (record) =>
                JSON.stringify(record.body ?? "").includes("aux post-restart replay marker") &&
                (record.body as { smoke_variant?: unknown } | undefined)?.smoke_variant ===
                  auxVariantName,
            );
            if (!auxDispatched) await delay(500);
          }
          check.truthy(
            auxDispatched,
            "the auxiliary family dispatched its persisted variant payload after restart",
          );
        }
        detail = "persisted root and auxiliary family captures survived a real host restart";
        observed = {
          rootID,
          rootVariant,
          rootAfterVariant: rootAfter?.model?.variant,
          auxID,
          auxVariant,
          restarted: true,
        };
      } catch (error) {
        status = "fail";
        detail = error instanceof Error ? error.message : String(error);
      }
      if (status === "pass" && check.failed.length > 0) status = "fail";
      results.push({
        id: "replay-restart",
        title: "Durable root and auxiliary family replay after a real service restart",
        phase: "T-003",
        parity: ["runtime.snapshot-persist", "runtime.lineage"],
        status,
        detail,
        assertions: check.passed,
        failures: check.failed,
        durationMs: Date.now() - startedAt,
        ...(observed === undefined ? {} : { observed }),
      });
    }
    // END_BLOCK_REPLAY_RESTART

    const providerPayloads = (await readProviderTrace(join(traceDir, "provider.jsonl")))
      .filter((record) => record.event === "provider.request")
      .map((record) => {
        const body = (record.body ?? {}) as { smoke_variant?: unknown; reasoning_effort?: unknown };
        return {
          model: record.model,
          smoke_variant: body.smoke_variant,
          reasoning_effort: body.reasoning_effort,
        };
      });
    const distinctPayloads = [
      ...new Map(providerPayloads.map((entry) => [JSON.stringify(entry), entry])).values(),
    ];

    const aggregateChecks = [
      ...(await runAggregateParity({
        workspaceRoot: options.workspaceRoot,
        hostBinary: options.hostBinary,
        scratchDir,
        packageDir,
        owned,
        timeoutMs: options.caseTimeoutMs,
      })),
      ...(await runToolControlPlaneParity({
        workspaceRoot: options.workspaceRoot,
        hostBinary: options.hostBinary,
        scratchDir,
        packageDir,
        owned,
        timeoutMs: options.caseTimeoutMs,
      })),
      ...(await runWorkflowParity({
        workspaceRoot: options.workspaceRoot,
        hostBinary: options.hostBinary,
        scratchDir,
        packageDir,
        owned,
        timeoutMs: options.caseTimeoutMs,
      })),
    ];
    const installedSurface = await runInstalledSurface({
      installedDir: packageDir,
      projectDir,
      hostBinary: options.hostBinary,
    });
    const evidence = {
      change: "C-OPENCODE-V2-NATIVE T-003 core real-host harness",
      mode: "core",
      generatedAt: new Date().toISOString(),
      host: {
        binary: options.hostBinary,
        sha256: hostSha256,
        version: PINNED_HOST_VERSION,
        sourceCommit: PINNED_SOURCE_COMMIT,
      },
      package: {
        tarballPath: packedTarball.tarballPath,
        tarballSha256: packedTarball.sha256,
        version: packedManifest.version ?? "unknown",
        installedDir: packageDir,
        installStrategy:
          "declared dependency graph installed into the isolated project via bun install --ignore-scripts (no workspace node_modules symlinks)",
        resolvedDependencies: installed.resolvedDependencies,
        loadedPaths: installed.loadedPaths,
        packTool: "bun pm pack --ignore-scripts",
        packEquivalence:
          "verified npm-format tarball entrypoints present and package.json name/version match; successfully installed and loaded on the pinned host",
        packedEntryCount: packedArtifact.entries,
      },
      isolation: {
        scratch: { dir: scratchDir, base: scratch.base, marker: "owned" },
        envKeys: Object.keys(env).sort(),
        env: redactEnv(env),
        networking:
          "owned 127.0.0.1 provider origin only; fixture guards enforce http.request URL, model.request baseURL/provider, and WS handshake destination before dispatch",
      },
      provider: {
        origin: providerOrigin,
        catalog: provider.catalog,
        requestCount: providerPayloads.length,
        distinctPayloads,
      },
      teardown: {
        strategy:
          "exact live ChildProcess handles, SIGTERM then joined SIGKILL; ownership-marked scratch removed only through guarded cleanup",
        ownedPids: owned.pids,
      },
      cases: results,
      installedSurface: installedSurface.checks,
      aggregateChecks,
      coverageLimits: [
        "Same-model switch emits no native event and is not a criterion.",
        "Equal-time cross-session acceptance ordering is covered by engine/integration tests; the host case delays preparation after the real prompt hook without implementing admission.",
        "Secrets/SSE placeholder restoration product parity belongs to T-005/T-009; this run only probes hook availability.",
        "Full-product parity (all eleven plugins, CLI/config/setup, presets, workflow, full TUI) is not claimed; see parity.json.",
      ],
    };
    if (options.evidencePath !== undefined) {
      await mkdir(dirname(options.evidencePath), { recursive: true }).catch(() => undefined);
      await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    return {
      ok: results.every((entry) => entry.status !== "fail"),
      cases: results,
      ...(options.evidencePath === undefined ? {} : { evidencePath: options.evidencePath }),
      tarballSha256: packedTarball.sha256,
      installed: {
        packageDir,
        packageVersion: installed.packageVersion,
        resolvedDependencies: installed.resolvedDependencies,
        loadedPaths: installed.loadedPaths,
      },
      installedSurface,
      aggregateChecks,
    };
  } catch (error) {
    return {
      ok: false,
      cases: results,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await owned.stopAll();
    provider?.stop();
    if (scratch !== undefined && options.keepScratch !== true) {
      await removeOwnedScratch(scratch).catch(() => undefined);
    }
  }
}
// END_BLOCK_RUN

/** Resolve the pinned host binary or throw a bounded diagnostics error. */
export function requireHostBinary(env: NodeJS.ProcessEnv = process.env): string {
  const binary = discoverHostBinary(env);
  if (binary === undefined) {
    throw new Error(
      "no pinned OpenCode 2.0.18 host binary; set VVOC_E2E_V2_HOST or install to /tmp/opencode/vvoc-seam-host-2.0.18/opencode",
    );
  }
  return binary;
}
// START_BLOCK_AGGREGATE_PARITY
/** One aggregate real-host parity observation. */
export interface AggregateCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Broad-allow native config that loads the INSTALLED package directory as the root aggregate. */
function aggregateOpencodeConfig(input: {
  readonly providerPort: number;
  readonly packageDir: string;
  readonly transport?: "http" | "websocket";
  readonly permissions?: readonly unknown[];
}): unknown {
  return {
    model: "loopback/seam-smart",
    default_agent: "vv-controller",
    permissions: input.permissions ?? [{ action: "*", resource: "*", effect: "allow" }],
    providers: {
      loopback: {
        name: "Aggregate Loopback",
        package: "@opencode/ai/providers/openai-compatible",
        env: ["LOOPBACK_API_KEY"],
        settings: {
          baseURL: `http://127.0.0.1:${input.providerPort}/v1`,
          provider: "loopback",
          ...(input.transport === undefined ? {} : { transport: input.transport }),
        },
        models: {
          "seam-smart": { name: "Seam Smart" },
          "seam-fast": { name: "Seam Fast" },
        },
      },
    },
    agents: {
      "vv-controller": { description: "Aggregate controller", mode: "primary", model: "loopback/seam-smart" },
      "vv-implementer": {
        description: "Aggregate delegated implementer",
        mode: "subagent",
        model: "loopback/seam-smart",
      },
    },
    plugins: [{ package: input.packageDir }],
  };
}

/**
 * Boot one isolated host whose only plugin is the INSTALLED package directory
 * (the native host resolves package/server → dist/index.js default aggregate).
 * Returns the authenticated API plus the provider trace path and a stop handle.
 */
async function bootAggregateHost(input: {
  readonly workspaceRoot: string;
  readonly hostBinary: string;
  readonly scratchDir: string;
  readonly packageDir: string;
  readonly owned: OwnedProcesses;
  readonly transport?: "http" | "websocket";
  readonly label?: string;
  readonly permissions?: readonly unknown[];
  readonly toolPlan?: readonly ProviderToolStep[];
  readonly toolPlanActivationText?: string;
  readonly childReportText?: string;
  readonly childHoldMs?: number;
  readonly vvocOverrides?: (config: {
    roles: Record<string, string>;
    plugins: Record<string, unknown>;
  }) => void;
}): Promise<{
  readonly api: ReturnType<typeof createNativeApi>;
  readonly projectDir: string;
  readonly tracePath: string;
  readonly hostOutput: () => string;
  readonly stop: () => void;
}> {
  const label = input.label ?? "aggregate";
  const projectDir = join(input.scratchDir, `${label}-project`);
  const dirs = {
    home: join(input.scratchDir, `${label}-home`),
    cfg: join(input.scratchDir, `${label}-cfg`),
    data: join(input.scratchDir, `${label}-data`),
    state: join(input.scratchDir, `${label}-state`),
    cache: join(input.scratchDir, `${label}-cache`),
  };
  for (const directory of [projectDir, ...Object.values(dirs)]) {
    await mkdir(directory, { recursive: true });
  }
  await mkdir(join(projectDir, ".vvoc"), { recursive: true });
  const traceDir = join(input.scratchDir, `${label}-trace`);
  await mkdir(traceDir, { recursive: true });

  const providerPort = await getFreePort();
  const provider = await createLoopbackProvider({
    port: providerPort,
    tracePath: join(traceDir, "provider.jsonl"),
    catalog: JSON.parse(
      await readFile(
        join(input.workspaceRoot, "scripts", "e2e-v2", "fixtures", "model-catalog.json"),
        "utf8",
      ),
    ),
    ...(input.toolPlan === undefined ? {} : { toolPlan: input.toolPlan }),
    ...(input.toolPlanActivationText === undefined
      ? {}
      : { toolPlanActivationText: input.toolPlanActivationText }),
    ...(input.childReportText === undefined ? {} : { childReportText: input.childReportText }),
    ...(input.childHoldMs === undefined ? {} : { childHoldMs: input.childHoldMs }),
  });

  await writeFile(
    join(projectDir, "opencode.json"),
    JSON.stringify(
      aggregateOpencodeConfig({
        providerPort,
        packageDir: input.packageDir,
        ...(input.transport === undefined ? {} : { transport: input.transport }),
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
      }),
      null,
      2,
    ),
    "utf8",
  );
  const vvocModule = (await import(
    pathToFileURL(join(input.workspaceRoot, "dist", "lib", "vvoc-config.js")).href
  )) as {
    createDefaultVvocConfig(): Record<string, unknown>;
    renderVvocConfig(config: Record<string, unknown>): string;
  };
  const vvocConfig = vvocModule.createDefaultVvocConfig() as {
    roles: Record<string, string>;
    plugins: Record<string, unknown>;
  };
  vvocConfig.roles = {
    default: "loopback/seam-smart",
    smart: "loopback/seam-smart",
    fast: "loopback/seam-fast",
    reviewer: "loopback/seam-smart",
  };
  input.vvocOverrides?.(vvocConfig);
  await writeFile(
    join(projectDir, ".vvoc", "vvoc.json"),
    vvocModule.renderVvocConfig(vvocConfig),
    "utf8",
  );

  const env = buildHostEnv(process.env, {
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.cfg,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    LOOPBACK_API_KEY: "e2e-loopback-key",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  });
  const hostPort = await getFreePort();
  const host = input.owned.spawn(
    input.hostBinary,
    ["serve", "--service", "--hostname", "127.0.0.1", "--port", String(hostPort), "--log-level", "error"],
    { cwd: projectDir, env },
  );
  let output = "";
  const attach = (chunk: Buffer): void => {
    if (output.length < 64 * 1024) output = (output + chunk.toString()).slice(0, 64 * 1024);
  };
  host.stdout?.on("data", attach);
  host.stderr?.on("data", attach);
  const password = await waitForRegisteredService({
    servicePath: join(dirs.state, "opencode", "service.json"),
    timeoutMs: 30_000,
  });
  const api = createNativeApi({
    baseUrl: `http://127.0.0.1:${hostPort}`,
    password,
    directory: projectDir,
  });
  return {
    api,
    projectDir,
    tracePath: provider.tracePath,
    hostOutput: () => output,
    stop: () => provider.stop(),
  };
}

/** Send one prompt through the native API and return the created session id. */
async function aggregatePrompt(
  api: ReturnType<typeof createNativeApi>,
  projectDir: string,
  text: string,
  timeoutMs = 60_000,
): Promise<string> {
  // Service registration is not registry readiness; retry until the location
  // registry accepts a session, then prompt once it accepts.
  const deadline = Date.now() + timeoutMs;
  let sessionID = "";
  for (;;) {
    const opened = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory: projectDir } }),
    }).catch(() => undefined);
    const id = (opened?.body as { data?: { id?: string } } | undefined)?.data?.id;
    if (typeof id === "string") {
      sessionID = id;
      break;
    }
    if (Date.now() > deadline) throw new Error(`session did not open: ${opened?.text ?? "no response"}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  for (;;) {
    const result = await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }).catch(() => undefined);
    if (result?.status !== undefined && result.status < 400) return sessionID;
    if (Date.now() > deadline) return sessionID;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

/** Wait until the provider trace shows at least one recorded request body. */
async function waitForProviderRequests(
  tracePath: string,
  minimum: number,
  timeoutMs: number,
): Promise<ProviderRequestRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await readProviderTrace(tracePath);
    if (records.length >= minimum) return records;
    if (Date.now() > deadline) return records;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

/** True when any request body carries the given injected system context marker. */
function traceHasSystemText(records: readonly ProviderRequestRecord[], marker: string): boolean {
  for (const record of records) {
    const body = record.body as { system?: unknown; messages?: unknown } | undefined;
    if (body === undefined) continue;
    const system = body.system;
    if (Array.isArray(system)) {
      for (const part of system) {
        if (
          typeof part === "object" &&
          part !== null &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          if ((part as { text: string }).text.includes(marker)) return true;
        }
      }
    }
    if (JSON.stringify(body.messages ?? "").includes(marker)) return true;
  }
  return false;
}

/**
 * Wait for a real analytics usage record with provider-reported non-zero tokens
 * under the isolated XDG data home (`vvoc/analytics/usage-YYYY-MM.jsonl`).
 */
async function waitForAnalyticsUsage(
  dataDir: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const dir = join(dataDir, "vvoc", "analytics");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const files = (await readdir(dir)).filter((name) => name.startsWith("usage-"));
      for (const file of files) {
        const text = await readFile(join(dir, file), "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const tokens = (record as { tokens?: Record<string, unknown> } | undefined)?.tokens;
          if (tokens === undefined) continue;
          const total = ["input", "output", "reasoning", "cacheRead", "cacheWrite"].reduce(
            (sum, key) => sum + (typeof tokens[key] === "number" ? (tokens[key] as number) : 0),
            0,
          );
          if (total > 0) {
            return { ok: true, detail: `usageFile=${file} tokens=${JSON.stringify(tokens)}` };
          }
        }
      }
    } catch {
      // directory not created yet
    }
    if (Date.now() > deadline) return { ok: false, detail: "no non-zero usage record observed" };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

/**
 * Drive the INSTALLED root aggregate on the real host for rows observable in
 * the actual provider payload: system-context injection, provider-reported
 * analytics usage, and peak-hours hard/soft PRIMARY dispatch gating. Every
 * observation comes from a real loopback host turn.
 */
export async function runAggregateParity(input: {
  readonly workspaceRoot: string;
  readonly hostBinary: string;
  readonly scratchDir: string;
  readonly packageDir: string;
  readonly owned: OwnedProcesses;
  readonly timeoutMs?: number;
}): Promise<AggregateCheck[]> {
  const checks: AggregateCheck[] = [];
  const timeoutMs = input.timeoutMs ?? 60_000;

  // system-context-injection: eligible primary request carries the injected guidance.
  try {
    const host = await bootAggregateHost({ ...input, label: "sysctx" });
    try {
      await aggregatePrompt(host.api, host.projectDir, "aggregate warmup");
      await waitForProviderRequests(host.tracePath, 1, timeoutMs);
      await aggregatePrompt(host.api, host.projectDir, "aggregate primary probe");
      const records = await waitForProviderRequests(host.tracePath, 2, timeoutMs);
      const injected = traceHasSystemText(records, "<semantic_continuity>");
      checks.push({
        id: "plugin.system-context-injection",
        ok: injected,
        detail: `providerRequests=${records.length} injectedGuidance=${injected}`,
      });
      const analytics = await waitForAnalyticsUsage(join(input.scratchDir, "sysctx-data"), 20_000);
      checks.push({
        id: "plugin.analytics",
        ok: analytics.ok,
        detail: analytics.detail,
      });
    } finally {
      host.stop();
    }
  } catch (error) {
    checks.push({
      id: "plugin.system-context-injection",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // peak-hours: a covering hard window must deny BEFORE provider dispatch for a
  // bound family; the soft negative control on the same window must dispatch.
  const peakHoursOverrides =
    (mode: "soft" | "hard") =>
    (config: { roles: Record<string, string>; plugins: Record<string, unknown> }): void => {
      config.plugins["peak-hours"] = {
        enabled: true,
        mode,
        graceActiveSessions: false,
        schedules: {
          loopback: { windows: [{ start: "00:00", end: "23:59", tz: "UTC" }] },
        },
      };
    };
  /**
   * A PRIMARY dispatch carries injected guidance (`<semantic_continuity>`), which
   * system-context-injection never adds to title/compaction/internal requests.
   * Counting only these avoids attributing an exempt auxiliary dispatch to a
   * primary peak-hours bypass.
   */
  const countPrimaryDispatches = (records: readonly ProviderRequestRecord[]): number =>
    records.filter(
      (record) =>
        record.path?.endsWith("/chat/completions") &&
        JSON.stringify(record.body ?? "").includes("<semantic_continuity>"),
    ).length;
  const openSession = async (
    api: ReturnType<typeof createNativeApi>,
    projectDir: string,
  ): Promise<string> => {
    // Service registration is not app/registry readiness: retry until the
    // location/agent/model registry actually accepts a session.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const opened = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: projectDir } }),
      }).catch(() => undefined);
      const sessionID = (opened?.body as { data?: { id?: string } } | undefined)?.data?.id;
      if (typeof sessionID === "string") return sessionID;
      if (Date.now() > deadline) {
        throw new Error(`session did not open: ${opened?.text ?? "no response"}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  };
  const promptSession = async (
    api: ReturnType<typeof createNativeApi>,
    sessionID: string,
    text: string,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await api(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }).catch(() => undefined);
      const code = (result?.body as { code?: string } | undefined)?.code;
      if (result?.status !== undefined && result.status < 400) return;
      if (Date.now() > deadline) return;
      void code;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  };
  const measureSecondPrompt = async (label: string, mode: "soft" | "hard"): Promise<number> => {
    const host = await bootAggregateHost({ ...input, label, vvocOverrides: peakHoursOverrides(mode) });
    try {
      const sessionID = await openSession(host.api, host.projectDir);
      await promptSession(host.api, sessionID, "peak binding warmup");
      await waitForProviderRequests(host.tracePath, 1, timeoutMs);
      const before = countPrimaryDispatches(await readProviderTrace(host.tracePath));
      await promptSession(host.api, sessionID, `peak ${mode} probe`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 6_000));
      const after = countPrimaryDispatches(await readProviderTrace(host.tracePath));
      return Math.max(0, after - before);
    } finally {
      host.stop();
    }
  };
  try {
    const softExtra = await measureSecondPrompt("peak-soft", "soft");
    const hardExtra = await measureSecondPrompt("peak-hard", "hard");
    checks.push({
      id: "plugin.peak-hours",
      ok: softExtra > 0 && hardExtra === 0,
      detail: `softSecondPromptPrimaryDispatches=${softExtra} hardSecondPromptPrimaryDispatches=${hardExtra}`,
    });
  } catch (error) {
    checks.push({
      id: "plugin.peak-hours",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // secrets-redaction real WebSocket transport: the host must open a session
  // WebSocket and the loopback responder must serve protocol frames (HTTP
  // fallback would not produce provider.websocket events).
  try {
    const host = await bootAggregateHost({ ...input, label: "ws-transport", transport: "websocket" });
    try {
      await aggregatePrompt(host.api, host.projectDir, "ws transport probe");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 4_000));
      const records = await readProviderTrace(host.tracePath);
      const wsOpened = records.some(
        (record) => record.event === "provider.websocket" && record.path === "open",
      );
      const wsMessages = records.filter(
        (record) => record.event === "provider.websocket" && record.path === "message",
      ).length;
      checks.push({
        id: "plugin.secrets-redaction.websocket-transport",
        ok: wsOpened && wsMessages > 0,
        detail: `wsOpened=${wsOpened} wsRequestFrames=${wsMessages}`,
      });
    } finally {
      host.stop();
    }
  } catch (error) {
    checks.push({
      id: "plugin.secrets-redaction.websocket-transport",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}
// END_BLOCK_AGGREGATE_PARITY

// START_BLOCK_TOOL_CONTROL_PLANE
/** Loopback HTTP target that counts inbound fetches (web_fetch side-effect oracle). */
function createFetchOracle(): { readonly port: number; count: () => number; stop: () => void } {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests += 1;
      return new Response("oracle-body", { headers: { "content-type": "text/plain" } });
    },
  });
  return { port: server.port ?? 0, count: () => requests, stop: () => server.stop(true) };
}

const controlDelay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Poll the native session permission list for the first pending request id. */
async function waitForPendingPermission(
  api: ReturnType<typeof createNativeApi>,
  sessionID: string,
  timeoutMs = 12_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await api(`/api/session/${sessionID}/permission`).catch(() => undefined);
    const entries = (listed?.body as { data?: Array<{ id?: string }> } | undefined)?.data;
    if (Array.isArray(entries) && entries.length > 0 && typeof entries[0]?.id === "string") {
      return entries[0].id;
    }
    await controlDelay(150);
  }
  return undefined;
}

/** Reply to one native permission request. */
async function replyPermission(
  api: ReturnType<typeof createNativeApi>,
  sessionID: string,
  requestID: string,
  decision: "once" | "reject",
): Promise<void> {
  await api(`/api/session/${sessionID}/permission/${requestID}/reply`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  }).catch(() => undefined);
}

/** Open a session with readiness retries, then prompt once. */
async function controlPrompt(
  api: ReturnType<typeof createNativeApi>,
  projectDir: string,
  text: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const opened = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory: projectDir } }),
    }).catch(() => undefined);
    const sessionID = (opened?.body as { data?: { id?: string } } | undefined)?.data?.id;
    if (typeof sessionID === "string") {
      // Bind the family first, then send the tool-call prompt.
      await api(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: "control plane binding warmup" }),
      }).catch(() => undefined);
      await controlDelay(2_000);
      await api(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }).catch(() => undefined);
      return sessionID;
    }
    if (Date.now() > deadline) return undefined;
    await controlDelay(500);
  }
}

/**
 * Installed-aggregate tool control plane: script real native tool calls through
 * the loopback provider, decide the native permission via the host API, and
 * assert the guarded side effect happened (allow) or did not (deny).
 */
export async function runToolControlPlaneParity(input: {
  readonly workspaceRoot: string;
  readonly hostBinary: string;
  readonly scratchDir: string;
  readonly packageDir: string;
  readonly owned: OwnedProcesses;
  readonly timeoutMs?: number;
}): Promise<AggregateCheck[]> {
  const checks: AggregateCheck[] = [];
  const timeoutMs = input.timeoutMs ?? 60_000;
  const oracle = createFetchOracle();
  const targetUrl = `http://127.0.0.1:${oracle.port}/resource`;
  const permissions = [{ action: "web_fetch", resource: targetUrl, effect: "ask" }];
  const runOne = async (decision: "once" | "reject", label: string): Promise<{ fetches: number; permissionSeen: boolean }> => {
    const before = oracle.count();
    const host = await bootAggregateHost({
      ...input,
      label,
      permissions,
      toolPlan: [{ tool: "web_fetch", args: { url: targetUrl, format: "text" } }],
    });
    let permissionSeen = false;
    try {
      const sessionID = await controlPrompt(host.api, host.projectDir, "control plane fetch probe", timeoutMs);
      if (sessionID !== undefined) {
        const requestID = await waitForPendingPermission(host.api, sessionID, 12_000);
        if (requestID !== undefined) {
          permissionSeen = true;
          await replyPermission(host.api, sessionID, requestID, decision);
        }
        await controlDelay(5_000);
      }
      return { fetches: oracle.count() - before, permissionSeen };
    } finally {
      host.stop();
    }
  };
  try {
    const denied = await runOne("reject", "web-deny");
    const allowed = await runOne("once", "web-allow");
    checks.push({
      id: "plugin.web-tools",
      ok: denied.permissionSeen && denied.fetches === 0 && allowed.fetches > 0,
      detail: `deniedPermissionSeen=${denied.permissionSeen} deniedFetches=${denied.fetches} allowedPermissionSeen=${allowed.permissionSeen} allowedFetches=${allowed.fetches}`,
    });
  } catch (error) {
    checks.push({
      id: "plugin.web-tools",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    oracle.stop();
  }

  // guardian/permission-before-side-effect: a guarded native write must not
  // happen when the native permission is rejected, and must happen when allowed.
  const runGuardedWrite = async (
    decision: "once" | "reject",
  ): Promise<{ seen: boolean; written: boolean }> => {
    const target = join(input.scratchDir, `guardian-${decision}.txt`);
    await rm(target, { force: true });
    const host = await bootAggregateHost({
      ...input,
      label: `guardian-${decision}`,
      permissions: [
        { action: "write", resource: target, effect: "ask" },
        { action: "edit", resource: target, effect: "ask" },
      ],
      toolPlan: [{ tool: "write", args: { path: target, content: "guarded\n" } }],
    });
    let seen = false;
    try {
      const sessionID = await controlPrompt(host.api, host.projectDir, "guardian guarded write probe", timeoutMs);
      if (sessionID !== undefined) {
        const requestID = await waitForPendingPermission(host.api, sessionID, 12_000);
        if (requestID !== undefined) {
          seen = true;
          await replyPermission(host.api, sessionID, requestID, decision);
        }
        await controlDelay(5_000);
      }
      return { seen, written: existsSync(target) };
    } finally {
      host.stop();
    }
  };
  try {
    const denied = await runGuardedWrite("reject");
    const allowed = await runGuardedWrite("once");
    checks.push({
      id: "plugin.guardian",
      ok: denied.seen && !denied.written && allowed.written,
      detail: `deniedPermissionSeen=${denied.seen} deniedWritten=${denied.written} allowedPermissionSeen=${allowed.seen} allowedWritten=${allowed.written}`,
    });
  } catch (error) {
    checks.push({
      id: "plugin.guardian",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // hashline-edit: the routed edit tool is `hashline_edit` (native edit/patch
  // hidden), and an anchor that is stale after an external change is rejected.
  try {
    const target = join(input.scratchDir, "hashline-target.txt");
    await writeFile(target, "alpha\nbeta\n", "utf8");
    let anchor: string | undefined;
    const host = await bootAggregateHost({
      ...input,
      label: "hashline",
      permissions: [{ action: "edit", resource: target, effect: "allow" }],
      toolPlan: [
        { tool: "read", args: { path: target } },
        {
          tool: "hashline_edit",
          argsFromRequest: (body) => {
            const match = JSON.stringify(body ?? "").match(
              /(\d+#[ZPMQVRWSNKTXJBYH]{2}#[ZPMQVRWSNKTXJBYH]{2})\|/,
            );
            anchor = match?.[1];
            return anchor === undefined
              ? undefined
              : { filePath: target, edits: [{ op: "replace", pos: anchor, lines: ["ALPHA"] }] };
          },
          before: async () => {
            // Change the file after the read established the anchor, so the
            // emitted edit anchor is stale.
            await writeFile(target, "alpha changed\nbeta\n", "utf8");
          },
        },
      ],
    });
    try {
      await controlPrompt(host.api, host.projectDir, "hashline stale anchor probe", timeoutMs);
      await controlDelay(6_000);
      const records = await readProviderTrace(host.tracePath);
      const firstWithTools = records.find(
        (record) =>
          record.event === "provider.request" &&
          Array.isArray((record.body as { tools?: unknown[] } | undefined)?.tools) &&
          ((record.body as { tools?: unknown[] }).tools?.length ?? 0) > 0,
      );
      const toolNames = (
        (firstWithTools?.body as { tools?: Array<{ function?: { name?: string }; name?: string }> })
          ?.tools ?? []
      ).map((entry) => entry.function?.name ?? entry.name);
      const routed =
        toolNames.includes("hashline_edit") &&
        !toolNames.includes("edit") &&
        !toolNames.includes("patch");
      const staleRejected = records.some((record) =>
        JSON.stringify(record.body ?? "").includes("changed since last read"),
      );
      checks.push({
        id: "plugin.hashline-edit",
        ok: anchor !== undefined && routed && staleRejected,
        detail: `readAnchor=${anchor ?? "missing"} routedHashlineEdit=${routed} staleAnchorRejected=${staleRejected}`,
      });
    } finally {
      host.stop();
    }
  } catch (error) {
    checks.push({
      id: "plugin.hashline-edit",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // spec-guard: enforce mode blocks a full-content write of an active
  // `.vvoc/specs` artifact that has ERROR findings, while the same tool writing a
  // non-gated path is allowed (the gate is path-scoped).
  try {
    const label = "spec-guard";
    const projectDir = join(input.scratchDir, `${label}-project`);
    const gatedPath = join(projectDir, ".vvoc", "specs", "gated", "spec.xml");
    const plainPath = join(projectDir, "plain-spec-target.txt");
    await mkdir(dirname(gatedPath), { recursive: true });
    const invalidSpec = `<GraceChangeSpec graceVersion="4.0" status="approved"></GraceChangeSpec>`;
    const host = await bootAggregateHost({
      ...input,
      label,
      permissions: [
        { action: "write", resource: gatedPath, effect: "allow" },
        { action: "write", resource: plainPath, effect: "allow" },
        { action: "edit", resource: gatedPath, effect: "allow" },
        { action: "edit", resource: plainPath, effect: "allow" },
      ],
      vvocOverrides: (config) => {
        config.plugins["spec-guard"] = { enabled: true, mode: "enforce" };
      },
      toolPlanActivationText: "spec guard probe",
      toolPlan: [
        { tool: "write", args: { path: gatedPath, content: invalidSpec } },
        { tool: "write", args: { path: plainPath, content: "plain\n" } },
      ],
    });
    try {
      await controlPrompt(host.api, host.projectDir, "spec guard probe", timeoutMs);
      await controlDelay(6_000);
      const records = await readProviderTrace(host.tracePath);
      const gatedBlocked = !existsSync(gatedPath);
      const plainWritten = existsSync(plainPath);
      const specGuardDiagnostic = records.some((record) =>
        JSON.stringify(record.body ?? "").includes("[spec-guard]"),
      );
      checks.push({
        id: "plugin.spec-guard",
        ok: gatedBlocked && plainWritten && specGuardDiagnostic,
        detail: `gatedWriteBlocked=${gatedBlocked} plainWriteAllowed=${plainWritten} specGuardDiagnostic=${specGuardDiagnostic}`,
      });
    } finally {
      host.stop();
    }
  } catch (error) {
    checks.push({
      id: "plugin.spec-guard",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // tool-history-compaction: a long tool history is compacted on the real
  // dispatched request while the protected recent window stays intact.
  try {
    const label = "compaction";
    const bigDir = join(input.scratchDir, `${label}-project`, "big");
    await mkdir(bigDir, { recursive: true });
    await writeFile(
      join(bigDir, "big.txt"),
      Array.from(
        { length: 400 },
        (_, index) => `line ${index} MATCHTOKEN filler filler filler filler filler`,
      ).join("\n"),
      "utf8",
    );
    const grepArgs = { pattern: "MATCHTOKEN", path: bigDir };
    const host = await bootAggregateHost({
      ...input,
      label,
      vvocOverrides: (config) => {
        config.plugins["tool-history-compaction"] = {
          enabled: true,
          protectLastCalls: 1,
          protectRecentMessages: 0,
        };
      },
      toolPlanActivationText: "compaction probe",
      toolPlan: [
        { tool: "grep", args: grepArgs },
        { tool: "grep", args: grepArgs },
        { tool: "grep", args: grepArgs },
      ],
    });
    try {
      await controlPrompt(host.api, host.projectDir, "compaction probe", timeoutMs);
      await controlDelay(8_000);
      const records = await readProviderTrace(host.tracePath);
      const bodies = records
        .filter((record) => record.event === "provider.request")
        .map((record) => JSON.stringify(record.body ?? ""));
      const compacted = bodies.some((body) => body.includes("[... tool output pruned ...]"));
      const protectedRecent = bodies.some(
        (body) => (body.match(/MATCHTOKEN/g)?.length ?? 0) >= 50,
      );
      checks.push({
        id: "plugin.tool-history-compaction",
        ok: compacted && protectedRecent,
        detail: `olderOutputCompacted=${compacted} recentWindowPreserved=${protectedRecent}`,
      });
    } finally {
      host.stop();
    }
  } catch (error) {
    checks.push({
      id: "plugin.tool-history-compaction",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}
// END_BLOCK_TOOL_CONTROL_PLANE

// START_BLOCK_WORKFLOW_PARITY
type AnyRecord = Record<string, unknown>;

function isAnyRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect every nested object that carries a `type` string (native part shapes). */
function collectTypedParts(value: unknown, out: AnyRecord[] = [], depth = 0): AnyRecord[] {
  if (depth > 10 || out.length > 600) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectTypedParts(item, out, depth + 1);
    return out;
  }
  if (isAnyRecord(value)) {
    if (typeof value.type === "string") out.push(value);
    for (const nested of Object.values(value)) collectTypedParts(nested, out, depth + 1);
  }
  return out;
}

/** Epoch-ms of a native timestamp (number or ISO string); undefined otherwise. */
function toMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Maximum `time.completed` (ms) anywhere inside a native message subtree. */
function maxCompletedMs(value: unknown, depth = 0): number | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    let best: number | undefined;
    for (const item of value) {
      const ms = maxCompletedMs(item, depth + 1);
      if (ms !== undefined && (best === undefined || ms > best)) best = ms;
    }
    return best;
  }
  if (!isAnyRecord(value)) return undefined;
  let best: number | undefined;
  const own = isAnyRecord(value.time) ? toMs(value.time.completed) : undefined;
  if (own !== undefined) best = own;
  for (const nested of Object.values(value)) {
    const ms = maxCompletedMs(nested, depth + 1);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best;
}

/** Flatten a persisted workflow state into its attempt records. */
function collectAttempts(state: unknown): AnyRecord[] {
  const out: AnyRecord[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || out.length > 32) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isAnyRecord(value)) return;
    if (value.attempt !== undefined && value.status !== undefined) out.push(value);
    for (const nested of Object.values(value)) walk(nested, depth + 1);
  };
  walk(state, 0);
  return out;
}

async function pollFor<T>(
  fn: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  pollMs = 400,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined && predicate(value)) return value;
    if (Date.now() >= deadline) return undefined;
    await controlDelay(pollMs);
  }
}

/** Read all persisted workflow-state JSON files under an isolated vvoc data home. */
async function readWorkflowStates(dataDir: string): Promise<unknown[]> {
  const root = join(dataDir, "vvoc", "workflow");
  const states: unknown[] = [];
  let sessions: string[] = [];
  try {
    sessions = await readdir(root);
  } catch {
    return states;
  }
  for (const session of sessions) {
    try {
      const text = await readFile(join(root, session, "workflow-state.json"), "utf8");
      states.push(JSON.parse(text));
    } catch {
      // no state for this session
    }
  }
  return states;
}

/** Pinned 2.0.18 parent subagent failure shapes on the native assistant tool part. */
const PARENT_CANCEL_RE = /^(Subagent cancelled|Tool execution interrupted) \(sessionID: .+\)$/;

/** Last work-item id visible in a request body (latest open wins across history). */
function lastWorkItemId(body: unknown): string {
  const matches = [...JSON.stringify(body ?? "").matchAll(/wi-[A-Za-z0-9]+/g)];
  return matches[matches.length - 1]?.[0] ?? "wi-1";
}

/**
 * Drive the installed aggregate's workflow boundary on real native records:
 * a delegated foreground subagent launch, a child-only interrupt with native
 * cancellation evidence, pre-recover in-flight survival, driven explicit recovery
 * (settled with completedAt = max(parent, child)), a background launch, and the
 * live parent shape after a root interrupt.
 */
export async function runWorkflowParity(input: {
  readonly workspaceRoot: string;
  readonly hostBinary: string;
  readonly scratchDir: string;
  readonly packageDir: string;
  readonly owned: OwnedProcesses;
  readonly timeoutMs?: number;
}): Promise<AggregateCheck[]> {
  const checks: AggregateCheck[] = [];
  const timeoutMs = input.timeoutMs ?? 60_000;
  const label = "workflow";
  const dataDir = join(input.scratchDir, `${label}-data`);
  const rootDataDir = join(input.scratchDir, "workflow-root-data");
  const childReport =
    "VVOC_WORK_ITEM_ID: {workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nDelegated implementation complete.";

  const openItem = (key: string, title: string, scope: string) => ({
    tool: "work_item_open",
    args: {
      items: [
        { key, title, mode: "delegated", requiredReviewers: [], writeScope: [scope] },
      ],
    },
  });
  const subagentStep = (background: boolean) => ({
    tool: "subagent",
    argsFromRequest: (body: unknown) => ({
      agent: "vv-implementer",
      description: background ? "Background task" : "Delegated implementation",
      prompt: `VVOC_WORK_ITEM_ID: ${lastWorkItemId(body)}\n<assignment>Apply the scoped change.</assignment>`,
      background,
    }),
  });
  const recoverStep = {
    tool: "work_item_decide",
    argsFromRequest: (body: unknown) => ({
      workItemId: lastWorkItemId(body),
      attempt: 1,
      decision: "recover",
      diagnosis: "child terminal abort observed on native records",
      changedCondition: "cancellation evidence gathered after native child interrupt",
      verification: [
        "native parent tool part Subagent cancelled",
        "native child terminal aborted error",
        "active and inbox quiescent",
      ],
      recoveryId: "recover-native-cancellation",
    }),
  };

  let host: Awaited<ReturnType<typeof bootAggregateHost>> | undefined;
  try {
    host = await bootAggregateHost({
      ...input,
      label,
      childReportText: childReport,
      childHoldMs: 60_000,
      toolPlanActivationText: "workflow probe",
      toolPlan: [
        openItem("k1", "Delegated implementation", "src/impl.ts"),
        subagentStep(false),
        recoverStep,
        openItem("k2", "Background delegated task", "src/gen.ts"),
        subagentStep(true),
      ],
    });
    const current = () => {
      if (host === undefined) throw new Error("workflow host not started");
      return host;
    };
    const http = (path: string, init?: RequestInit) => current().api(path, init).catch(() => undefined);
    const messageList = async (sessionID: string): Promise<AnyRecord[] | undefined> => {
      const res = await http(`/api/session/${sessionID}/message`);
      if (res === undefined || res.status >= 400) return undefined;
      const body = res.body;
      const data = isAnyRecord(body) && Array.isArray(body.data) ? body.data : undefined;
      return Array.isArray(data) ? (data as AnyRecord[]) : undefined;
    };
    const listSessions = async (): Promise<AnyRecord[] | undefined> => {
      const res = await http(`/api/session?location[directory]=${encodeURIComponent(current().projectDir)}`);
      if (res === undefined || res.status >= 400) return undefined;
      const body = res.body;
      const data = isAnyRecord(body) && Array.isArray(body.data) ? body.data : undefined;
      return Array.isArray(data) ? (data as AnyRecord[]) : undefined;
    };
    const childrenOf = (list: AnyRecord[] | undefined, rootId: string): AnyRecord[] =>
      (list ?? []).filter(
        (entry) =>
          isAnyRecord(entry) &&
          typeof entry.id === "string" &&
          typeof entry.parentID === "string" &&
          entry.parentID === rootId,
      );
    const interruptTrue = async (
      sessionID: string,
    ): Promise<{ ok: boolean; status: number | "no-response"; body: string }> => {
      const res = await http(`/api/session/${sessionID}/interrupt`, { method: "POST" });
      if (res === undefined) return { ok: false, status: "no-response", body: "" };
      return {
        ok:
          res.status < 400 &&
          (isAnyRecord(res.body)
            ? res.body.interrupted === true
            : typeof res.body === "object" && res.body !== null
              ? JSON.stringify(res.body).includes('"interrupted":true')
              : false),
        status: res.status,
        body: JSON.stringify(res.body).slice(0, 240),
      };
    };
    const findParentCancel = async (
      sessionID: string,
      childID: string,
    ): Promise<AnyRecord | undefined> => {
      const marker = new RegExp(
        `^(Subagent cancelled|Tool execution interrupted) \\(sessionID: ${childID}\\)$`,
      );
      return pollFor(
        async () => {
          const list = await messageList(sessionID);
          if (list === undefined) return undefined;
          for (const part of collectTypedParts(list)) {
            if (part.type !== "tool") continue;
            const state = isAnyRecord(part.state) ? part.state : undefined;
            if (state === undefined || state.status !== "error") continue;
            const message = isAnyRecord(state.error) ? state.error.message : undefined;
            if (typeof message === "string" && marker.test(message)) return part;
          }
          return undefined;
        },
        () => true,
        45_000,
      );
    };

    try {
      const rootSession = await controlPrompt(
        current().api,
        current().projectDir,
        "workflow probe",
        timeoutMs,
      );
      if (rootSession === undefined) throw new Error("workflow probe session did not open");

      // 1. Foreground native subagent launch: real child session + persisted in-flight attempt.
      const child = await pollFor(
        async () => {
          const list = await listSessions();
          return list === undefined ? undefined : childrenOf(list, rootSession)[0];
        },
        () => true,
        30_000,
      );
      const childId = isAnyRecord(child) ? (child.id as string) : undefined;
      const launchAttempt = await pollFor(
        async () => {
          const states = await readWorkflowStates(dataDir);
          const attempt = states.flatMap(collectAttempts)[0];
          return attempt !== undefined && typeof attempt.launchedAt === "string" ? attempt : undefined;
        },
        () => true,
        30_000,
      );
      const launchStateCount = (await readWorkflowStates(dataDir)).length;
      checks.push({
        id: "plugin.workflow.launch",
        ok: childId !== undefined && launchAttempt !== undefined,
        detail: `childSession=${childId ?? "none"} rootSession=${rootSession} attemptStatus=${String(launchAttempt?.status ?? "none")} attemptCallId=${String(launchAttempt?.callId ?? "none")} launchedAt=${String(launchAttempt?.launchedAt ?? "none")} stateFiles=${launchStateCount}`,
      });
      if (childId === undefined) throw new Error("foreground subagent launch was not observed");

      // 2. Child-only interrupt with native cancellation evidence on real records.
      // First wait until the child's provider turn is actually in flight (its
      // request holds the child mid-execution); interrupting earlier is an idle
      // no-op (`interrupted:false`) and proves nothing.
      const childTurnInFlight = await pollFor(
        async () => {
          const records = await readProviderTrace(current().tracePath);
          const childTurn = records.some((record) => {
            if (record.event !== "provider.request") return false;
            const body = record.body as { messages?: unknown[]; tools?: unknown[] } | undefined;
            const text = JSON.stringify(body ?? "");
            return (
              text.includes("VVOC_WORK_ITEM_ID:") &&
              Array.isArray(body?.messages) &&
              body.messages.length === 2 &&
              Array.isArray(body?.tools) &&
              body.tools.length > 0
            );
          });
          return childTurn ? true : undefined;
        },
        () => true,
        30_000,
      );
      // The child's fetch can reach the provider a beat before its run is
      // registered interruptible; retry inside the hold window until it is not
      // an idle no-op (`interrupted:false`).
      let interruptResult = { ok: false, status: 0 as number | "no-response", body: "" };
      const interruptDeadline = Date.now() + 20_000;
      while (!interruptResult.ok && Date.now() < interruptDeadline) {
        await controlDelay(1_500);
        interruptResult = await interruptTrue(childId);
      }
      const interrupted = interruptResult.ok;
      const rootPart = await findParentCancel(rootSession, childId);
      const parentMessage =
        rootPart !== undefined &&
        isAnyRecord(rootPart.state) &&
        isAnyRecord(rootPart.state.error)
          ? String(rootPart.state.error.message)
          : undefined;
      const parentCompleted = rootPart === undefined ? undefined : maxCompletedMs(rootPart);
      const childCompleted = await pollFor(
        async () => {
          const list = await messageList(childId);
          if (list === undefined) return undefined;
          return JSON.stringify(list).includes('"aborted"') ? maxCompletedMs(list) : undefined;
        },
        () => true,
        45_000,
      );
      const activeBody = JSON.stringify((await http("/api/session/active"))?.body ?? "");
      const childAbsentFromActive = activeBody.includes(childId) === false;
      const inboxBody = (await http(`/api/session/${childId}/inbox`))?.body;
      const inboxEmpty =
        isAnyRecord(inboxBody) && Array.isArray(inboxBody.data) && inboxBody.data.length === 0;
      const preStates = await readWorkflowStates(dataDir);
      const preAttempt = preStates.flatMap(collectAttempts)[0];
      const rootList = await messageList(rootSession);
      const rootErrors = (rootList === undefined ? [] : collectTypedParts(rootList))
        .filter((part) => part.type === "tool")
        .map((part) => {
          const state = isAnyRecord(part.state) ? part.state : undefined;
          const message = state !== undefined && isAnyRecord(state.error) ? state.error.message : undefined;
          return `${String((part.name ?? part.tool) ?? "?")}:${state?.status ?? "?"}:${String(message ?? "").slice(0, 90)}`;
        });
      const rootErrorDump = rootErrors.join(" | ").slice(0, 400) || "none";
      const expectedCompletedIso =
        parentCompleted !== undefined && childCompleted !== undefined
          ? new Date(Math.max(parentCompleted, childCompleted)).toISOString()
          : undefined;
      checks.push({
        id: "workflow.cancellation-recovery",
        ok:
          interrupted &&
          parentMessage !== undefined &&
          childCompleted !== undefined &&
          childAbsentFromActive &&
          inboxEmpty &&
          preAttempt?.status === "in_flight" &&
          expectedCompletedIso !== undefined,
        detail: `childTurnInFlight=${childTurnInFlight === true} interrupted=${interrupted} interruptStatus=${String(interruptResult.status)} interruptBody=${interruptResult.body} parentMessage=${parentMessage ?? "none"} parentCompletedMs=${String(parentCompleted ?? "none")} childAbortedCompletedMs=${String(childCompleted ?? "none")} childAbsentFromActive=${childAbsentFromActive} inboxEmpty=${inboxEmpty} preRecoverStatus=${String(preAttempt?.status ?? "none")} expectedCompletedAt=${expectedCompletedIso ?? "none"} rootErrors=${rootErrorDump}`,
      });

      // 3. Explicit recovery settles the attempt with completedAt = max(parent, child).
      const settled = await pollFor(
        async () => {
          const states = await readWorkflowStates(dataDir);
          const attempt = states.flatMap(collectAttempts)[0];
          return attempt !== undefined && attempt.status !== "in_flight" ? attempt : undefined;
        },
        () => true,
        45_000,
      );
      const settledIso =
        settled !== undefined && typeof settled.completedAt === "string"
          ? settled.completedAt
          : undefined;
      checks.push({
        id: "workflow.cancellation-recovery.settlement",
        ok:
          settled?.status === "failed" &&
          expectedCompletedIso !== undefined &&
          settledIso === expectedCompletedIso,
        detail: `settleStatus=${String(settled?.status ?? "none")} completedAt=${settledIso ?? "none"} expectedCompletedAt=${expectedCompletedIso ?? "none"} match=${settledIso === expectedCompletedIso}`,
      });

      // 4. Background native subagent launch (second delegated item).
      const backgroundChild = await pollFor(
        async () => {
          const list = await listSessions();
          if (list === undefined) return undefined;
          return childrenOf(list, rootSession).find((entry) => entry.id !== childId);
        },
        () => true,
        45_000,
      );
      const bgStates = await readWorkflowStates(dataDir);
      const bgAttempts = bgStates.flatMap(collectAttempts);
      checks.push({
        id: "plugin.workflow.background",
        ok: backgroundChild !== undefined && bgAttempts.length >= 2,
        detail: `backgroundChild=${isAnyRecord(backgroundChild) ? String(backgroundChild.id) : "none"} attemptCount=${bgAttempts.length} attemptStatuses=${bgAttempts.map((attempt) => String(attempt.status)).join(",")}`,
      });
    } finally {
      current().stop();
    }

    // 5. Root-interrupt live shape (wi-20): the parent's subagent tool part carries
    // the pinned root-interrupt message on real native records.
    host = await bootAggregateHost({
      ...input,
      label: "workflow-root",
      childReportText: childReport,
      childHoldMs: 60_000,
      toolPlanActivationText: "workflow probe",
      toolPlan: [openItem("k1", "Delegated implementation", "src/impl.ts"), subagentStep(false)],
    });
    try {
      const rootSession2 = await controlPrompt(
        current().api,
        current().projectDir,
        "workflow probe",
        timeoutMs,
      );
      const child2 = await pollFor(
        async () => {
          const list = await listSessions();
          if (list === undefined || rootSession2 === undefined) return undefined;
          return childrenOf(list, rootSession2)[0];
        },
        () => true,
        30_000,
      );
      const child2Id = isAnyRecord(child2) ? (child2.id as string) : undefined;
      if (child2Id === undefined || rootSession2 === undefined) {
        checks.push({
          id: "workflow.cancellation-recovery.root",
          ok: false,
          detail: `root scenario could not launch a child (child=${child2Id ?? "none"} root=${rootSession2 ?? "none"})`,
        });
      } else {
        const rootInterruptResult = await interruptTrue(rootSession2);
        const rootInterrupted = rootInterruptResult.ok;
        const parentPart2 = await findParentCancel(rootSession2, child2Id);
        const liveMessage =
          parentPart2 !== undefined &&
          isAnyRecord(parentPart2.state) &&
          isAnyRecord(parentPart2.state.error)
            ? String(parentPart2.state.error.message)
            : "none";
        const continued = await pollFor(
          async () => {
            const states = await readWorkflowStates(rootDataDir);
            const attempt = states.flatMap(collectAttempts)[0];
            return attempt !== undefined && attempt.status !== "in_flight" ? attempt : undefined;
          },
          () => true,
          5_000,
        );
        const rootPartsDump =
          (await messageList(rootSession2))
            ?.flatMap((entry) => collectTypedParts(entry))
            .filter((part) => part.type === "tool")
            .map((part) => {
              const state = isAnyRecord(part.state) ? part.state : undefined;
              const message = state !== undefined && isAnyRecord(state.error) ? state.error.message : undefined;
              return `${String(part.name ?? part.tool ?? "?")}:${String(state?.status ?? "?")}:${String(message ?? "").slice(0, 120)}`;
            })
            .join(" | ")
            .slice(0, 500) ?? "none";
        const rawRootMessages = JSON.stringify(await messageList(rootSession2) ?? "none").slice(0, 1200);
        const rawChildMessages =
          child2Id === undefined
            ? "none"
            : JSON.stringify(await messageList(child2Id) ?? "none").slice(0, 900);
        checks.push({
          id: "workflow.cancellation-recovery.root",
          ok: rootInterrupted && PARENT_CANCEL_RE.test(liveMessage),
          detail: `rootInterrupted=${rootInterrupted} interruptStatus=${String(rootInterruptResult.status)} liveParentMessage=${liveMessage.slice(0, 160)} rootTurnContinued=${continued !== undefined} rootToolParts=${rootPartsDump} rawRootMessages=${rawRootMessages} rawChildMessages=${rawChildMessages}`,
        });
      }
    } finally {
      current().stop();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const id of [
      "plugin.workflow.launch",
      "plugin.workflow.background",
      "workflow.cancellation-recovery",
      "workflow.cancellation-recovery.settlement",
    ]) {
      if (!checks.some((check) => check.id === id)) {
        checks.push({ id, ok: false, detail });
      }
    }
  }
  return checks;
}
// END_BLOCK_WORKFLOW_PARITY
// START_BLOCK_INSTALLED_SURFACE
/** The eleven native server plugin named exports the packed root aggregate must publish. */
export const ROOT_PLUGIN_EXPORTS = [
  "GuardianPlugin",
  "HashlineEditPlugin",
  "ModelRolesPlugin",
  "SystemContextInjectionPlugin",
  "WorkflowPlugin",
  "SecretsRedactionPlugin",
  "WebToolsPlugin",
  "ToolHistoryCompactionPlugin",
  "AnalyticsPlugin",
  "PeakHoursPlugin",
  "SpecGuardPlugin",
] as const;

/** The nine vvoc-owned tool ids; the host `subagent` tool is never a tenth owned registration. */
export const OWNED_TOOL_IDS = [
  "hashline_edit",
  "str_replace_editor",
  "web_fetch",
  "web_search",
  "work_checkpoint",
  "work_item_close",
  "work_item_decide",
  "work_item_list",
  "work_item_open",
] as const;

/** One installed-artifact surface check. */
export interface InstalledSurfaceCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Outcome of the installed-artifact surface checks. */
export interface InstalledSurfaceResult {
  readonly ok: boolean;
  readonly checks: readonly InstalledSurfaceCheck[];
}

/** Assert a module value is a native `{ id, setup | effect }` entry. */
function nativeEntryIssue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not a native entry object";
  const entry = value as { id?: unknown; setup?: unknown; effect?: unknown };
  if (typeof entry.id !== "string" || entry.id.length === 0) return "no string id";
  if (typeof entry.setup !== "function" && typeof entry.effect !== "function") {
    return "no setup or effect function";
  }
  return undefined;
}

/**
 * Verify the INSTALLED packed artifact's public native surface in-process: the
 * root aggregate default plus all eleven named plugins, every standalone plugin
 * subpath, and the nine-owned-tool catalog census. The installed module graph
 * resolves its own declared dependencies under the isolated project.
 */
export async function runInstalledSurface(input: {
  readonly installedDir: string;
  readonly projectDir?: string | undefined;
  readonly hostBinary?: string | undefined;
}): Promise<InstalledSurfaceResult> {
  const checks: InstalledSurfaceCheck[] = [];
  const record = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  try {
    const root = (await import(
      pathToFileURL(join(input.installedDir, "dist", "index.js")).href
    )) as Record<string, unknown>;
    const defaultIssue = nativeEntryIssue(root.default);
    const namedIssues = ROOT_PLUGIN_EXPORTS.map((name) => {
      const issue = nativeEntryIssue(root[name]);
      return issue === undefined ? undefined : `${name}: ${issue}`;
    }).filter((issue): issue is string => issue !== undefined);
    record(
      "root-aggregate",
      defaultIssue === undefined && namedIssues.length === 0,
      `default=${defaultIssue ?? "ok"} named=${namedIssues.length === 0 ? "all native" : namedIssues.join("; ")}`,
    );
  } catch (error) {
    record("root-aggregate", false, error instanceof Error ? error.message : String(error));
  }

  const manifest = JSON.parse(readFileSync(join(input.installedDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const subpaths = Object.entries(manifest.exports ?? {}).filter(([subpath]) =>
    subpath.startsWith("./plugins/"),
  );
  const subpathFailures: string[] = [];
  for (const [subpath, value] of subpaths) {
    const target =
      typeof value === "string"
        ? value
        : typeof value === "object" && value !== null
          ? ((value as Record<string, unknown>).import ?? (value as Record<string, unknown>).default)
          : undefined;
    if (typeof target !== "string") {
      subpathFailures.push(`${subpath}: no import target`);
      continue;
    }
    try {
      const module = (await import(
        pathToFileURL(join(input.installedDir, target.replace(/^\.\//, ""))).href
      )) as Record<string, unknown>;
      const name = `${subpath
        .replace(/^\.\/plugins\//, "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")}Plugin`;
      const issue = nativeEntryIssue(module[name]);
      if (issue !== undefined) subpathFailures.push(`${subpath}: ${issue}`);
    } catch (error) {
      subpathFailures.push(
        `${subpath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  record(
    "standalone-subpaths",
    subpaths.length === 11 && subpathFailures.length === 0,
    subpaths.length === 11 && subpathFailures.length === 0
      ? `11 standalone plugin subpaths loaded as native entries`
      : `count=${subpaths.length} failures=${subpathFailures.join("; ")}`,
  );

  try {
    const catalog = (await import(
      pathToFileURL(join(input.installedDir, "dist", "lib", "agent-tool-catalog.js")).href
    )) as { AGENT_TOOL_CATALOG_TOOL_IDS?: readonly string[] };
    const ids = [...(catalog.AGENT_TOOL_CATALOG_TOOL_IDS ?? [])].sort();
    const expected = [...OWNED_TOOL_IDS].sort();
    const matches = JSON.stringify(ids) === JSON.stringify(expected);
    record(
      "tool-catalog-census",
      matches && !ids.includes("subagent"),
      matches
        ? "the installed catalog holds exactly the nine owned tool ids and no subagent registration"
        : `catalog ids ${JSON.stringify(ids)} do not match the nine owned tools`,
    );
  } catch (error) {
    record("tool-catalog-census", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const presets = (await import(
      pathToFileURL(join(input.installedDir, "dist", "lib", "vvoc-preset-registry.js")).href
    )) as {
      BUILTIN_VVOC_PRESET_NAMES?: readonly string[];
      BUILTIN_VVOC_PRESET_REGISTRY?: Record<string, unknown>;
    };
    const registryText = JSON.stringify(presets.BUILTIN_VVOC_PRESET_REGISTRY ?? {});
    const modelRegistry = (await import(
      pathToFileURL(join(input.installedDir, "dist", "runtime", "model-registry.js")).href
    )) as {
      isManagedThinkingModel?: (selection: unknown) => boolean;
      managedVariantFor?: (selection: unknown) => unknown;
    };
    const selection = {
      providerID: "xiaomi",
      modelID: "mimo-v2.6-flash",
      variant: "thinking",
    };
    const variant = modelRegistry.managedVariantFor?.(selection) as
      | { body?: { thinking?: { type?: unknown } } }
      | undefined;
    const variantText = JSON.stringify(variant ?? {});
    const noKimi =
      !(presets.BUILTIN_VVOC_PRESET_NAMES ?? []).includes("vv-kimi") && !registryText.includes("vv-kimi");
    const thinkingOk = variant?.body?.thinking?.type === "enabled";
    const noPdf = !/pdf/i.test(variantText);
    const noEffortHigh = !/"reasoningEffort"\s*:\s*"high"/.test(variantText);
    const thinkingModel = modelRegistry.isManagedThinkingModel?.(selection) === true;
    record(
      "presets-model-variants",
      noKimi && thinkingOk && noPdf && noEffortHigh && thinkingModel,
      `noKimi=${noKimi} thinking.type.enabled=${thinkingOk} noPdf=${noPdf} noEffortHigh=${noEffortHigh} managedThinkingModel=${thinkingModel}`,
    );
  } catch (error) {
    record("presets-model-variants", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const agents = (await import(
      pathToFileURL(join(input.installedDir, "dist", "lib", "managed-agents.js")).href
    )) as {
      MANAGED_SUBAGENT_NAMES?: readonly string[];
      getManagedSubagentDefinition?: (name: string) => { mode?: unknown };
      loadManagedAgentPromptTemplate?: (name: string) => Promise<string>;
    };
    const skills = (await import(
      pathToFileURL(join(input.installedDir, "dist", "lib", "managed-skills.js")).href
    )) as {
      MANAGED_SKILL_NAMES?: readonly string[];
      loadManagedSkillTemplate?: (name: string) => Promise<string>;
    };
    const requiredSubagents = ["vv-implementer", "vv-spec-reviewer", "vv-code-reviewer"];
    const subagentsPresent = requiredSubagents.every((name) =>
      (agents.MANAGED_SUBAGENT_NAMES ?? []).includes(name),
    );
    const requiredSkills = ["vv-execute", "vv-spec", "vv-plan", "vv-review"];
    const skillsPresent = requiredSkills.every((name) =>
      (skills.MANAGED_SKILL_NAMES ?? []).includes(name),
    );
    const subagentDefinition = agents.getManagedSubagentDefinition?.("vv-implementer");
    const skillText = (await skills.loadManagedSkillTemplate?.("vv-execute")) ?? "";
    const controllerText = (await agents.loadManagedAgentPromptTemplate?.("vv-controller")) ?? "";
    const nativeSemantics =
      subagentDefinition?.mode === "subagent" &&
      /subagent/i.test(skillText) &&
      controllerText.length > 0;
    record(
      "managed-agents-skills",
      subagentsPresent && skillsPresent && nativeSemantics,
      `subagents=${subagentsPresent} skills=${skillsPresent} nativeSubagentSemantics=${nativeSemantics}`,
    );
  } catch (error) {
    record("managed-agents-skills", false, error instanceof Error ? error.message : String(error));
  }

  if (input.projectDir !== undefined && input.hostBinary !== undefined) {
    try {
      const scratchDir = dirname(input.projectDir);
      const binDir = join(scratchDir, "cli-bin");
      await mkdir(binDir, { recursive: true });
      await symlink(input.hostBinary, join(binDir, "opencode"));
      const vvocBin = join(input.projectDir, "node_modules", ".bin", "vvoc");
      const env = buildHostEnv(process.env, {
        HOME: join(scratchDir, "home"),
        XDG_CONFIG_HOME: join(scratchDir, "cfg"),
        XDG_DATA_HOME: join(scratchDir, "data"),
        XDG_STATE_HOME: join(scratchDir, "state"),
        XDG_CACHE_HOME: join(scratchDir, "cache"),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      });
      // `completion` needs a shell name; buildHostEnv intentionally allow-lists no SHELL.
      env.SHELL = process.env.SHELL ?? "/bin/zsh";
      const cliProject = join(scratchDir, "cli-project");
      await mkdir(join(cliProject, ".vvoc"), { recursive: true });
      await mkdir(join(cliProject, ".opencode"), { recursive: true });
      const runCli = (args: readonly string[]) =>
        runCommand(vvocBin, [...args], { cwd: cliProject, env, timeoutMs: 180_000 });

      const globalVvocPath = join(scratchDir, "cfg", "vvoc", "vvoc.json");
      const opencodePath = join(scratchDir, "cfg", "opencode", "opencode.json");
      const globalInit = await runCli(["init", "--non-interactive"]);
      const projectInit = await runCli(["init", "--non-interactive", "--scope", "project"]);
      const globalValid = existsSync(globalVvocPath)
        ? await readFile(globalVvocPath, "utf8")
        : "";
      const sync1 = await runCli(["sync"]);
      const syncHash1 = existsSync(opencodePath) ? await sha256File(opencodePath) : "missing";
      const sync2 = await runCli(["sync"]);
      const syncHash2 = existsSync(opencodePath) ? await sha256File(opencodePath) : "missing";

      const status = await runCli(["status"]);
      const doctor = await runCli(["doctor"]);
      const statusText = `${status.stdout}${status.stderr}`;
      record(
        "cli.status-doctor-upgrade",
        status.status === 0 && doctor.status === 0 && /2\.0\.18/.test(statusText),
        `status=${status.status} doctor=${doctor.status} versionObserved=${/2\.0\.18/.test(statusText)}`,
      );

      const configValidate = await runCli(["config", "validate"]);
      const pluginList = await runCli(["plugin", "list"]);
      const pluginDisable = await runCli(["plugin", "disable", "guardian"]);
      const pluginEnable = await runCli(["plugin", "enable", "guardian"]);
      const completion = await runCli(["completion"]);
      record(
        "cli.config-plugin-completions",
        configValidate.status === 0 &&
          pluginList.status === 0 &&
          pluginDisable.status === 0 &&
          pluginEnable.status === 0 &&
          completion.status === 0,
        `configValidate=${configValidate.status} pluginList=${pluginList.status} toggle=${pluginDisable.status}/${pluginEnable.status} completion=${completion.status}`,
      );

      // Invalid global config must be refused before any write, then restored.
      const globalBeforeInvalid = existsSync(globalVvocPath)
        ? await sha256File(globalVvocPath)
        : "missing";
      const opencodeBeforeInvalid = existsSync(opencodePath)
        ? await sha256File(opencodePath)
        : "missing";
      await writeFile(globalVvocPath, "{ invalid json\n", "utf8");
      const invalidSync = await runCli(["sync"]);
      const opencodeAfterInvalid = existsSync(opencodePath)
        ? await sha256File(opencodePath)
        : "missing";
      if (globalValid.length > 0) await writeFile(globalVvocPath, globalValid, "utf8");
      const invalidRefused = invalidSync.status !== 0 && opencodeAfterInvalid === opencodeBeforeInvalid;
      record(
        "cli.install-sync-init",
        globalInit.status === 0 &&
          projectInit.status === 0 &&
          sync1.status === 0 &&
          sync2.status === 0 &&
          syncHash1 === syncHash2 &&
          invalidRefused &&
          globalBeforeInvalid !== "missing",
        `globalInit=${globalInit.status} projectInit=${projectInit.status} sync=${sync1.status}/${sync2.status} idempotent=${syncHash1 === syncHash2} invalidRefusedBeforeWrite=${invalidRefused}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record("cli.install-sync-init", false, detail);
      record("cli.status-doctor-upgrade", false, detail);
      record("cli.config-plugin-completions", false, detail);
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}
// END_BLOCK_INSTALLED_SURFACE
