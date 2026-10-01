// FILE: scripts/e2e-v2.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2 harness mode contract, scratch and process safety guards, allow-listed environments, parity inventory shape, installed-artifact full-runner row gating and evidence, and that the fixture plugin forwards to the real runtime with mandatory guards and correct cleanup.
//   SCOPE: Argument parsing, full/TUI refusal, missing-host refusal, injected core exit codes, installed-artifact parity-row outcomes and mandatory-row failures, loopback/scratch/cleanup guards, actual scratch creation and removal, env allow-list and redaction, live-handle owner refusal, parity.json vocabulary, fixture guard forwarding and failure cleanup.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, scripts/e2e-v2.ts, scripts/e2e-v2/full.ts, scripts/e2e-v2/full-cases.ts, scripts/e2e-v2/fixtures/plugin.ts, scripts/e2e-v2/host.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   scratchDirs - Temporary scratch directories removed after each test.
//   scratch - Create a temporary guarded test base.
//   hookHandlers - Hook handlers recorded through the minimal fake context.
//   disposeCalls - Disposal targets recorded through the minimal fake context.
//   fakeCtx - Minimal native plugin context that records registrations for the fixture test.
//   fakeRuntime - Minimal real-runtime stand-in that records forwarded calls.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Covered the installed-artifact full runner: installed-tier row mapping, mandatory-row gating, evidence totals, and the CLI --full exit behavior.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-003 correction - Added real scratch removal guards, env redaction, exited-handle refusal, and fixture failure-cleanup tests.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runCli } from "./e2e-v2.js";
import { createHarnessPlugin } from "./e2e-v2/fixtures/plugin.js";
import {
  buildParityEvidence,
  evaluateParityRows,
  mandatoryRowFailures,
  tierForCommand,
  type ParityRow,
} from "./e2e-v2/full-cases.js";
import { readParityInventory, runFull } from "./e2e-v2/full.js";
import {
  OwnedProcesses,
  assertLoopbackHttpUrl,
  assertSafeCleanupTarget,
  assertSafeScratchBase,
  buildHostEnv,
  createOwnedScratch,
  isLoopbackHostname,
  packedArtifactIssues,
  redactEnv,
  removeOwnedScratch,
} from "./e2e-v2/host.js";

const scratchDirs: string[] = [];
afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vvoc-e2e-test-"));
  scratchDirs.push(dir);
  return dir;
}

// START_BLOCK_FAKE_RUNTIME
const hookHandlers = new Map<string, (event: unknown) => Promise<void> | void>();
const disposeCalls: string[] = [];

function fakeCtx(options: { readonly failHook?: string } = {}): unknown {
  return {
    location: { directory: "/tmp/vvoc-e2e-project" },
    session: {
      async hook(name: string, handler: (event: unknown) => Promise<void> | void) {
        if (options.failHook === name) throw new Error(`hook ${name} registration failed`);
        hookHandlers.set(name, handler);
        return {
          dispose: async () => {
            disposeCalls.push(name);
            hookHandlers.delete(name);
          },
        };
      },
    },
    event: {
      async *subscribe() {
        // No events during the fixture unit test.
      },
    },
  };
}

function fakeRuntime(calls: string[]): unknown {
  return {
    runtime: {
      instanceId: "test-instance",
      location: { directory: "/tmp/vvoc-e2e-project" },
      identity: { directory: "/tmp/vvoc-e2e-project" },
    },
    snapshots: {
      async captures() {
        calls.push("captures");
        return [];
      },
      async variants() {
        calls.push("variants");
        return [];
      },
      async familyOf(id: string) {
        calls.push("familyOf");
        return id;
      },
      async policy() {
        calls.push("policy");
        return undefined;
      },
      async configFor() {
        calls.push("configFor");
        return undefined;
      },
      async hasStaged() {
        calls.push("hasStaged");
        return false;
      },
    },
    async admitWorkload(request: Record<string, unknown>) {
      calls.push("admitWorkload");
      return { status: "bound", sessionID: request.sessionID };
    },
    async client() {
      calls.push("client");
      return {};
    },
    permissions: {
      async request() {
        calls.push("permissions.request");
        return "allow";
      },
      async guard(_input: unknown, effect: () => void) {
        calls.push("permissions.guard");
        effect();
        return undefined;
      },
    },
    release() {
      calls.push("release");
    },
    lastConfigError() {
      return undefined;
    },
  };
}
// END_BLOCK_FAKE_RUNTIME

describe("harness argument and mode contract", () => {
  test("parseArgs defaults to explicit full mode and recognizes each mode", () => {
    expect(parseArgs([])).toEqual({ mode: "full", json: false, keep: false });
    expect(parseArgs(["--core", "--json"])).toEqual({ mode: "core", json: true, keep: false });
    expect(parseArgs(["--tui"])).toEqual({ mode: "tui", json: false, keep: false });
    expect(parseArgs(["--list"])).toEqual({ mode: "list", json: false, keep: false });
    expect(parseArgs(["--core", "--keep"])).toEqual({ mode: "core", json: false, keep: true });
  });

  test("default full mode fails explicitly without claiming parity", async () => {
    const lines: string[] = [];
    const status = await runCli([], {
      workspaceRoot: process.cwd(),
      stdout: (line) => lines.push(line),
      runCore: async () => {
        throw new Error("runCore must not be called directly in full mode");
      },
      hostBinary: "/tmp/pinned-opencode",
      runFull: async () => ({
        ok: false,
        rows: [],
        failures: ["contracts.tools: unverified (no installed-artifact tier covers this row)"],
      }),
    });
    expect(status).not.toBe(0);
    expect(lines.join("\n")).toContain("not verified: contracts.tools");
  });

  test("tui mode reports success only for observed passing scenarios", async () => {
    const lines: string[] = [];
    const status = await runCli(["--tui"], {
      workspaceRoot: process.cwd(),
      stdout: (line) => lines.push(line),
      runCore: async () => {
        throw new Error("runCore must not be called in tui mode");
      },
      runTui: async () => ({
        ok: true,
        implemented: true,
        sourceCommit: "cd9a14a6b688d4021bee381dfd39d2cef9c0f862",
        scenarios: [{ id: "startup", status: "pass", detail: "rendered" }],
        note: "Observed 1 PTY scenario.",
      }),
    });
    expect(status).toBe(0);
    expect(lines.join("\n")).toContain("Observed 1 PTY scenario");
  });

  test("tui mode exits 2 when a real scenario fails", async () => {
    const lines: string[] = [];
    const status = await runCli(["--tui"], {
      workspaceRoot: process.cwd(),
      stdout: (line) => lines.push(line),
      runCore: async () => {
        throw new Error("runCore must not be called in tui mode");
      },
      runTui: async () => ({
        ok: false,
        implemented: true,
        sourceCommit: "cd9a14a6b688d4021bee381dfd39d2cef9c0f862",
        scenarios: [{ id: "startup", status: "fail", detail: "no home" }],
        note: "TUI did not reach its home screen.",
      }),
    });
    expect(status).toBe(2);
    expect(lines.join("\n")).toContain("did not reach its home screen");
  });

  test("list mode prints the parity inventory without spawning", async () => {
    const lines: string[] = [];
    const status = await runCli(["--list"], {
      workspaceRoot: process.cwd(),
      stdout: (line) => lines.push(line),
      runCore: async () => {
        throw new Error("runCore must not be called in list mode");
      },
    });
    expect(status).toBe(0);
    expect(lines.length).toBeGreaterThan(5);
  });

  test("core mode refuses a missing host explicitly", async () => {
    const lines: string[] = [];
    const status = await runCli(["--core"], {
      workspaceRoot: process.cwd(),
      stdout: (line) => lines.push(line),
      hostBinary: undefined,
      requireHost: () => {
        throw new Error("no pinned host");
      },
      runCore: async () => {
        throw new Error("runCore must not be called without a host");
      },
    });
    expect(status).toBe(2);
  });

  test("core mode maps an injected failing case to a nonzero exit", async () => {
    const lines: string[] = [];
    const failed = await runCli(["--core"], {
      workspaceRoot: process.cwd(),
      hostBinary: "/fake/opencode",
      stdout: (line) => lines.push(line),
      runCore: async () => ({
        ok: false,
        cases: [
          {
            id: "x",
            title: "x",
            phase: "T-003",
            parity: [],
            status: "fail",
            detail: "",
            assertions: [],
            failures: ["boom"],
          },
        ],
      }),
    });
    expect(failed).toBe(1);
  });

  test("core mode succeeds when the injected run succeeds", async () => {
    const status = await runCli(["--core"], {
      workspaceRoot: process.cwd(),
      hostBinary: "/fake/opencode",
      stdout: () => undefined,
      runCore: async () => ({ ok: true, cases: [] }),
    });
    expect(status).toBe(0);
  });
});

describe("isolation guards", () => {
  test("loopback hostnames are accepted and public hosts are refused", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(() => assertLoopbackHttpUrl("http://example.com/v1")).toThrow(/non-loopback/);
    expect(assertLoopbackHttpUrl("http://127.0.0.1:1234/v1").port).toBe("1234");
  });

  test("scratch base rejects filesystem, workspace, and home roots", () => {
    expect(assertSafeScratchBase(join(tmpdir(), "vvoc-e2e-base"))).toContain("vvoc-e2e-base");
    expect(() => assertSafeScratchBase("/")).toThrow(/filesystem root/);
    expect(() => assertSafeScratchBase(process.cwd())).toThrow(/workspace root/);
  });

  test("cleanup target rejects base, outside, root, and symlink targets", async () => {
    const base = join(tmpdir(), `vvoc-e2e-guard-${process.pid}`);
    expect(() => assertSafeCleanupTarget(base, base)).toThrow(/scratch base itself/);
    expect(() => assertSafeCleanupTarget("/", base)).toThrow(/filesystem root/);
    expect(() => assertSafeCleanupTarget(join(tmpdir(), "elsewhere"), base)).toThrow(/outside/);
    expect(assertSafeCleanupTarget(join(base, "child"), base)).toBe(join(base, "child"));
  });

  test("owned scratch is created, marked, and removed only with its marker", async () => {
    const base = await scratch();
    const owned = await createOwnedScratch(base);
    expect(owned.dir.startsWith(base)).toBe(true);
    const marker = JSON.parse(await readFile(owned.markerPath, "utf8")) as { tool: string };
    expect(marker.tool).toBe("vvoc-e2e-v2");
    await removeOwnedScratch(owned);
    await expect(readFile(owned.markerPath, "utf8")).rejects.toThrow();

    // A directory without the ownership marker is refused.
    const unmarked = join(base, "unmarked");
    await mkdir(unmarked, { recursive: true });
    await writeFile(join(unmarked, ".vvoc-e2e-owner.json"), JSON.stringify({ tool: "foreign" }));
    await expect(
      removeOwnedScratch({ dir: unmarked, base, markerPath: join(unmarked, ".vvoc-e2e-owner.json") }),
    ).rejects.toThrow(/foreign ownership marker/);
  });

  test("the host environment drops inherited credentials/proxies and redacts evidence", () => {
    const env = buildHostEnv(
      { PATH: "/usr/bin", OPENAI_API_KEY: "secret", HTTPS_PROXY: "http://proxy", HOME: "/home/user" },
      { HOME: "/tmp/iso/home", LOOPBACK_API_KEY: "key" },
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HOME).toBe("/tmp/iso/home");
    expect(env.LOOPBACK_API_KEY).toBe("key");
    const redacted = redactEnv(env);
    expect(redacted.PATH).toBe("[redacted]");
    expect(redacted.LOOPBACK_API_KEY).toBe("[redacted]");
    expect(redacted.HOME).toBe("/tmp/iso/home");
  });

  test("packed artifact equivalence rejects a tarball missing entrypoints", () => {
    const complete = [
      "package/package.json",
      "package/dist/index.js",
      "package/dist/runtime/context.js",
      "package/dist/plugins/model-roles/index.js",
    ];
    expect(packedArtifactIssues(complete, { name: "x", version: "1" })).toEqual([]);
    const incomplete = packedArtifactIssues(["package/package.json"], { name: "x", version: "1" });
    expect(incomplete.length).toBeGreaterThan(0);
  });

  test("owned processes refuse foreign and exited pids", async () => {
    const owned = new OwnedProcesses();
    expect(() => owned.signal(999_999)).toThrow(/non-owned/);
    expect(owned.owns(999_999)).toBe(false);
    const child = owned.spawn("true", []);
    const pid = child.pid as number;
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    // The exited handle is reaped, so a reused pid can never be signalled.
    expect(owned.owns(pid)).toBe(false);
    expect(() => owned.signal(pid)).toThrow(/non-owned/);
  });
});

describe("parity inventory", () => {
  test("every row is complete and statuses separate core from pending", async () => {
    const parsed = JSON.parse(
      await readFile(join(process.cwd(), "scripts", "e2e-v2", "parity.json"), "utf8"),
    ) as { rows: Array<Record<string, string>>; statusVocabulary: string[] };
    expect(parsed.rows.length).toBeGreaterThan(20);
    for (const row of parsed.rows) {
      for (const field of ["id", "surface", "phase", "status", "acceptance", "command"]) {
        expect(typeof row[field]).toBe("string");
        expect(row[field].length).toBeGreaterThan(0);
      }
      expect(parsed.statusVocabulary).toContain(row.status);
    }
    const statuses = new Set(parsed.rows.map((row) => row.status));
    expect(statuses.has("implemented-core")).toBe(true);
    expect(statuses.has("pending")).toBe(true);
  });
});

describe("fixture plugin forwarding", () => {
  test("setup registers mandatory guards and forwards reads, then disposes registrations", async () => {
    const dir = await scratch();
    const controlFilePath = join(dir, "control.json");
    const calls: string[] = [];
    let realSetupCalled = false;
    hookHandlers.clear();
    disposeCalls.length = 0;
    const plugin = createHarnessPlugin({
      modelRolesPlugin: {
        setup: () => {
          realSetupCalled = true;
        },
      },
      acquireRuntime: async () => fakeRuntime(calls) as never,
      controlFilePath,
      providerOrigin: "http://127.0.0.1:1",
      allowedProviders: ["loopback"],
    });
    expect(realSetupCalled).toBe(false);

    const cleanup = await plugin.setup(fakeCtx());
    expect(realSetupCalled).toBe(true);

    const info = JSON.parse(await readFile(controlFilePath, "utf8")) as {
      port: number;
      nonce: string;
    };
    const unauthorized = await fetch(`http://127.0.0.1:${info.port}/status`);
    expect(unauthorized.status).toBe(403);
    const status = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { "x-e2e-nonce": info.nonce },
    });
    const body = (await status.json()) as { ok: boolean; guardState: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(body.guardState["http.request"]).toBe(true);
    expect(body.guardState["model.request"]).toBe(true);

    const client = await fetch(`http://127.0.0.1:${info.port}/client`, {
      headers: { "x-e2e-nonce": info.nonce },
    });
    expect(client.status).toBe(200);
    expect(calls).toContain("client");

    const guard = hookHandlers.get("model.request");
    expect(guard).toBeDefined();
    const invokeGuard = async (event: unknown): Promise<void> => {
      await guard?.(event);
    };
    await expect(invokeGuard({ model: { providerID: "openai" } })).rejects.toThrow(
      /not an owned loopback/,
    );
    await expect(
      invokeGuard({ model: { providerID: "loopback" }, baseURL: "http://example.com/v1" }),
    ).rejects.toThrow(/non-fixture origin/);
    await expect(
      invokeGuard({ model: { providerID: "loopback" }, baseURL: "http://127.0.0.1:1/v1" }),
    ).resolves.toBeUndefined();

    await cleanup();
    expect(disposeCalls).toContain("http.request");
    expect(disposeCalls).toContain("model.request");
    expect(calls).toContain("release");
  });

  test("setup failure disposes the runtime lease and the real plugin cleanup", async () => {
    const dir = await scratch();
    const controlFilePath = join(dir, "control.json");
    const calls: string[] = [];
    let modelCleanupCalled = false;
    hookHandlers.clear();
    const plugin = createHarnessPlugin({
      modelRolesPlugin: {
        setup: () => () => {
          modelCleanupCalled = true;
        },
      },
      acquireRuntime: async () => fakeRuntime(calls) as never,
      controlFilePath,
      providerOrigin: "http://127.0.0.1:1",
      allowedProviders: ["loopback"],
    });
    await expect(plugin.setup(fakeCtx({ failHook: "http.request" }))).rejects.toThrow(
      /http.request registration failed/,
    );
    expect(calls).toContain("release");
    expect(modelCleanupCalled).toBe(true);
  });

  test("real plugin setup failure aborts before acquiring the runtime", async () => {
    const dir = await scratch();
    const calls: string[] = [];
    const plugin = createHarnessPlugin({
      modelRolesPlugin: {
        setup: () => {
          throw new Error("real setup failed");
        },
      },
      acquireRuntime: async () => fakeRuntime(calls) as never,
      controlFilePath: join(dir, "control.json"),
      providerOrigin: "http://127.0.0.1:1",
      allowedProviders: ["loopback"],
    });
    await expect(plugin.setup(fakeCtx())).rejects.toThrow(/real setup failed/);
    expect(calls).not.toContain("release");
  });

  test("permission-guard endpoint runs the effect through the real guard", async () => {
    const dir = await scratch();
    const controlFilePath = join(dir, "control.json");
    const calls: string[] = [];
    hookHandlers.clear();
    const plugin = createHarnessPlugin({
      modelRolesPlugin: { setup: () => undefined },
      acquireRuntime: async () => fakeRuntime(calls) as never,
      controlFilePath,
      providerOrigin: "http://127.0.0.1:1",
      allowedProviders: ["loopback"],
    });
    const cleanup = await plugin.setup(fakeCtx());
    const info = JSON.parse(await readFile(controlFilePath, "utf8")) as { port: number; nonce: string };
    const response = await fetch(`http://127.0.0.1:${info.port}/permission-guard`, {
      method: "POST",
      headers: { "x-e2e-nonce": info.nonce, "content-type": "application/json" },
      body: JSON.stringify({ sessionID: "ses_test", action: "e2e.guard.allow" }),
    });
    const body = (await response.json()) as { allowed: boolean; effects: number };
    expect(body.allowed).toBe(true);
    expect(body.effects).toBe(1);
    expect(calls).toContain("permissions.guard");
    await cleanup();
  });
});

describe("full installed-artifact parity runner", () => {
  const rows: ParityRow[] = [
    { id: "core.a", surface: "core", phase: "T", status: "implemented-core", acceptance: "x", command: "bun scripts/e2e-v2.ts --core" },
    { id: "tui.a", surface: "tui", phase: "T", status: "pending", acceptance: "x", command: "bun scripts/e2e-v2.ts --tui" },
    { id: "installed.a", surface: "installed", phase: "T", status: "pending", acceptance: "x", command: "bun scripts/e2e-v2.ts --installed" },
    { id: "aggregate.a", surface: "aggregate", phase: "T", status: "pending", acceptance: "x", command: "bun scripts/e2e-v2.ts --aggregate" },
    { id: "unit.a", surface: "unit", phase: "T", status: "pending", acceptance: "x", command: "bun test x" },
  ];

  test("maps commands to installed tiers and never promotes a unit row", () => {
    expect(tierForCommand("bun scripts/e2e-v2.ts --core")).toBe("core");
    expect(tierForCommand("bun scripts/e2e-v2.ts --tui")).toBe("tui");
    expect(tierForCommand("bun scripts/e2e-v2.ts --installed")).toBe("installed");
    expect(tierForCommand("bun scripts/e2e-v2.ts --aggregate")).toBe("aggregate");
    expect(tierForCommand("bun test src/x.test.ts")).toBeUndefined();
    const results = evaluateParityRows(rows, {
      coreOk: true,
      tuiOk: undefined,
      installedOk: true,
      aggregateOutcomes: { "aggregate.a": true },
    });
    expect(results.find((row) => row.id === "core.a")?.outcome).toBe("pass");
    expect(results.find((row) => row.id === "installed.a")?.outcome).toBe("pass");
    expect(results.find((row) => row.id === "aggregate.a")?.outcome).toBe("pass");
    expect(results.find((row) => row.id === "tui.a")?.outcome).toBe("unverified");
    expect(results.find((row) => row.id === "unit.a")?.outcome).toBe("unverified");
    const failures = mandatoryRowFailures(results);
    expect(failures).toContain("tui.a: unverified (TUI tier was not run)");
    expect(failures.some((failure) => failure.startsWith("unit.a"))).toBe(true);
    expect(failures.some((failure) => failure.startsWith("core.a"))).toBe(false);
    expect(failures.some((failure) => failure.startsWith("installed.a"))).toBe(false);
    // An installed row is unverified until the installed-surface tier reports.
    const pendingInstalled = evaluateParityRows(rows, { coreOk: true, tuiOk: true, installedOk: undefined });
    expect(pendingInstalled.find((row) => row.id === "installed.a")?.outcome).toBe("unverified");
    const pendingAggregate = evaluateParityRows(rows, { coreOk: true, tuiOk: true, installedOk: true });
    expect(pendingAggregate.find((row) => row.id === "aggregate.a")?.outcome).toBe("unverified");
  });

  test("the real inventory has 38 rows and full parity stays unverified until every tier lands", async () => {
    const inventory = readParityInventory(process.cwd());
    expect(inventory).toHaveLength(38);
    const dir = await scratch();
    const evidencePath = join(dir, "parity-evidence.json");
    const summary = await runFull(
      {
        workspaceRoot: process.cwd(),
        hostBinary: "/tmp/pinned-opencode",
        scratchBase: dir,
        evidencePath,
      },
      {
        runCore: async () => ({ ok: true, cases: [], tarballSha256: "deadbeef" }),
        runTui: async () => ({
          ok: true,
          implemented: true,
          sourceCommit: "x",
          scenarios: [],
          note: "ok",
        }),
        hostSha256: async () => "host-hash",
        writeEvidence: async (path, document) => {
          await writeFile(path, JSON.stringify(document), "utf8");
        },
      },
    );
    expect(summary.ok).toBe(false);
    expect(summary.failures.length).toBeGreaterThan(0);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      totals: { rows: number; verified: number; unverified: number };
      host: { binarySha256: string };
    };
    expect(evidence.totals.rows).toBe(38);
    expect(evidence.totals.verified).toBeGreaterThan(0);
    expect(evidence.totals.unverified).toBeGreaterThan(0);
    expect(evidence.host.binarySha256).toBe("host-hash");
  });

  test("fails closed when the pinned host is unavailable", async () => {
    const dir = await scratch();
    const summary = await runFull(
      { workspaceRoot: process.cwd(), hostBinary: "/missing", scratchBase: dir, evidencePath: join(dir, "e.json") },
      { hostSha256: async () => { throw new Error("missing host"); } },
    );
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("pinned host is unavailable");
  });

  test("the CLI --full mode returns nonzero when mandatory rows are unverified", async () => {
    const dir = await scratch();
    const lines: string[] = [];
    const status = await runCli(["--full", "--json"], {
      workspaceRoot: process.cwd(),
      stdout: (line) => lines.push(line),
      runCore: async () => ({ ok: true, cases: [] }),
      runFull: async () => ({
        ok: false,
        rows: [],
        failures: ["unit.a: unverified"],
        evidencePath: join(dir, "e.json"),
      }),
      hostBinary: "/tmp/pinned-opencode",
    });
    expect(status).toBe(1);
    expect(lines.join("\n")).toContain("unit.a: unverified");
  });

  test("parity.full only passes when every mandatory row is verified or an accepted residual", () => {
    const base = {
      phase: "T",
      surface: "x",
    };
    const rows: ParityRow[] = [
      { ...base, id: "ok-row", status: "implemented-full", acceptance: "x", command: "bun scripts/e2e-v2.ts --core" },
      {
        ...base,
        id: "residual-row",
        status: "residual-accepted",
        acceptance: "x",
        command: "bun test x",
        residual: { reason: "offline-infeasible", crossReferences: ["unit suite"] },
      },
      { ...base, id: "pending-row", status: "pending", acceptance: "x", command: "bun test y" },
      { ...base, id: "parity.full", status: "pending", acceptance: "meta", command: "bun run e2e:v2" },
    ];
    const input = { coreOk: true, tuiOk: true, installedOk: true };
    const results = evaluateParityRows(rows, input);
    const meta = results.find((row) => row.id === "parity.full");
    expect(meta?.outcome).toBe("unverified");
    expect(meta?.detail).toContain("pending-row");
    expect(results.find((row) => row.id === "residual-row")?.outcome).toBe("residual");
    const failures = mandatoryRowFailures(results);
    expect(failures.some((failure) => failure.startsWith("pending-row"))).toBe(true);
    expect(failures.some((failure) => failure.startsWith("residual-row"))).toBe(false);

    const resolvedRows = rows.filter((row) => row.id !== "pending-row");
    const resolved = evaluateParityRows(resolvedRows, input);
    const resolvedMeta = resolved.find((row) => row.id === "parity.full");
    expect(resolvedMeta?.outcome).toBe("pass");
    expect(mandatoryRowFailures(resolved)).toEqual([]);
  });

  test("a residual-accepted row without a reason and cross-references is rejected as unverified", () => {
    const rows: ParityRow[] = [
      {
        id: "ok-row",
        surface: "x",
        phase: "T",
        status: "implemented-full",
        acceptance: "x",
        command: "bun scripts/e2e-v2.ts --core",
      },
      { id: "bad-residual", surface: "x", phase: "T", status: "residual-accepted", acceptance: "x", command: "bun test x" },
      { id: "thin-residual", surface: "x", phase: "T", status: "residual-accepted", acceptance: "x", command: "bun test x", residual: { reason: "  ", crossReferences: ["unit suite"] } },
      { id: "empty-refs", surface: "x", phase: "T", status: "residual-accepted", acceptance: "x", command: "bun test x", residual: { reason: "precise", crossReferences: [] } },
      { id: "parity.full", surface: "meta", phase: "T", status: "pending", acceptance: "meta", command: "bun run e2e:v2" },
    ];
    const results = evaluateParityRows(rows, { coreOk: true, tuiOk: true, installedOk: true });
    expect(results.find((row) => row.id === "bad-residual")?.outcome).toBe("unverified");
    expect(results.find((row) => row.id === "thin-residual")?.outcome).toBe("unverified");
    expect(results.find((row) => row.id === "empty-refs")?.outcome).toBe("unverified");
    expect(
      results.find((row) => row.id === "bad-residual")?.detail,
    ).toContain("missing a precise reason");
    const meta = results.find((row) => row.id === "parity.full");
    expect(meta?.outcome).toBe("unverified");
    expect(mandatoryRowFailures(results).length).toBeGreaterThanOrEqual(3);
  });

  test("buildParityEvidence summarizes verified, failed, and unverified rows", () => {
    const document = buildParityEvidence({
      rows: evaluateParityRows(rows, {
        coreOk: false,
        tuiOk: true,
        installedOk: true,
        aggregateOutcomes: { "aggregate.a": false },
      }),
      hostBinary: "/bin",
      hostBinarySha256: "h",
      hostSourceCommit: "c",
      hostVersion: "2.0.18",
      tarballSha256: undefined,
      packageName: "p",
      packageVersion: "1.0.0",
      dependencyHashes: {},
      coreSummary: { cases: 1, failed: 1 },
      tuiSummary: undefined,
      limits: [],
      generatedAt: "now",
    });
    expect(document.totals).toMatchObject({ rows: 5, verified: 2, failed: 2, unverified: 1 });
  });
});
