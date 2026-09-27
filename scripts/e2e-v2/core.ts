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
//   getFreePort - Reserve and release a loopback TCP port.
//   runCore - Execute the packed core real-host run and return its summary.
//   requireHostBinary - Resolve the pinned host binary or throw a bounded diagnostics error.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-003 correction - Owned scratch lifecycle, bounded host output/control, guard-aware evidence, and restart coverage of auxiliary families.]
// END_CHANGE_SUMMARY

import { createServer } from "node:net";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
  installPackedPackage,
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
    const nodeModulesDir = join(projectDir, "node_modules");
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
    const packageDir = await installPackedPackage({
      tarballPath: packedTarball.tarballPath,
      nodeModulesDir,
      workspaceNodeModules: join(options.workspaceRoot, "node_modules"),
    });
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
    const opened = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory: projectDir } }),
    });
    const warmupID = (opened.body as { data?: { id?: string } } | undefined)?.data?.id;
    if (typeof warmupID !== "string") {
      throw new Error(`project location did not open: ${opened.text}`);
    }
    await api(`/api/session/${warmupID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "harness activation warmup" }),
    });

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
          check.truthy(
            restartFresh.some(
              (record) =>
                JSON.stringify(record.body ?? "").includes("Generate a short, specific title") &&
                (record.body as { smoke_variant?: unknown } | undefined)?.smoke_variant ===
                  auxVariantName,
            ),
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
