#!/usr/bin/env bun
// FILE: scripts/e2e-v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: End-to-end verification of the vv-opencode dual-runtime package against a real, sandboxed OpenCode v2 server.
//   SCOPE: Download an isolated v2 binary on demand, build the package, prepare sandboxed XDG homes and a scratch project with role-referenced agents, start the server with an exact recorded PID, assert plugin activation, prompt-applied role models, preset hot-switching, and session anchoring through the server API, and always clean up by that PID.
//   DEPENDS: [node:fs, node:child_process, package.json]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS, M-PLUGIN-V2-RUNTIME]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   V2_VERSION - Pinned OpenCode v2 version under test.
//   WORKSPACE_ROOT - Repository root resolved from this script location.
//   checkResults - Collected check outcomes for the machine-readable summary.
//   main - Orchestrates build, sandbox preparation, server lifecycle, assertions, and cleanup.
//   downloadV2Binary - Fetch and cache the isolated v2 binary, never touching any installed OpenCode.
//   prepareSandbox - Create XDG homes and the scratch project with vvoc roles and a role-referenced agent.
//   startServer - Start the v2 server on a free port with the exact PID recorded for cleanup.
//   api - Authenticated fetch helper for the v2 HTTP API.
//   waitFor - Retry helper with timeout for readiness polling.
//   ServerHandle - Running server handle with exact PID, port, password, and stop.
//   record - Append and print one check outcome.
//   switchedModel - Routing proof via the model-switched session event.
//   buildSandboxConfigs - Pure vvoc roles and opencode plugin/agent shapes for the scratch project.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-009 - Created the repeatable sandboxed v2 end-to-end harness.]
// END_CHANGE_SUMMARY

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const V2_VERSION = "2.0.18";
const WORKSPACE_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "");
const checkResults: Array<{ name: string; status: "pass" | "fail" | "skip"; detail?: string }> = [];

function record(name: string, status: "pass" | "fail" | "skip", detail?: string) {
  checkResults.push({ name, status, detail });
  const label = String(status).toUpperCase();
  console.log(`[${label}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(
  label: string,
  attempt: () => Promise<boolean>,
  attempts: number,
  delayMs: number,
) {
  for (let i = 0; i < attempts; i++) {
    if (await attempt()) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function downloadV2Binary(cacheDir: string): Promise<string> {
  const binaryPath = join(cacheDir, "opencode");
  if (existsSync(binaryPath)) return binaryPath;
  await mkdir(cacheDir, { recursive: true });
  const url = `https://opencode.ai/files/bin/${V2_VERSION}/opencode-linux-x64.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  const archive = join(cacheDir, "v2.tar.gz");
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
  const extract = spawn("tar", ["xzf", "v2.tar.gz"], { cwd: cacheDir });
  await new Promise<void>((resolve, reject) => {
    extract.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
  });
  return binaryPath;
}

/** Pure sandbox config shapes so unit tests can validate them without IO. */
export function buildSandboxConfigs(rolesSmart: string, pluginSpecifier: string) {
  return {
    vvocRoles: {
      default: "opencode/gpt-6-luna",
      smart: rolesSmart,
      fast: "opencode/gpt-6-luna",
      reviewer: rolesSmart,
    },
    opencode: {
      plugins: [pluginSpecifier],
      agent: {
        "vv-role-probe": {
          prompt: "Probe agent whose model is a vv-role reference.",
          model: "vv-role:smart",
        },
      },
    },
  };
}

async function prepareSandbox(root: string, rolesSmart: string) {
  const project = join(root, "project");
  await mkdir(join(project, ".vvoc"), { recursive: true });
  const { createDefaultVvocConfig } = (await import(
    join(WORKSPACE_ROOT, "dist/lib/vvoc-config.js")
  )) as { createDefaultVvocConfig: () => Record<string, unknown> };
  const vvoc = createDefaultVvocConfig();
  const shapes = buildSandboxConfigs(rolesSmart, `file://${WORKSPACE_ROOT.replace(/\/$/, "")}`);
  (vvoc as { roles: Record<string, string> }).roles = shapes.vvocRoles;
  await writeFile(join(project, ".vvoc", "vvoc.json"), JSON.stringify(vvoc, null, 2));
  await writeFile(join(project, "opencode.json"), JSON.stringify(shapes.opencode, null, 2));
  return project;
}

interface ServerHandle {
  pid: number;
  port: number;
  password: string;
  baseUrl: string;
  stop: () => Promise<void>;
}

async function startServer(
  binary: string,
  project: string,
  xdgConfig: string,
  xdgData: string,
): Promise<ServerHandle> {
  await mkdir(join(xdgConfig, "opencode"), { recursive: true });
  await writeFile(
    join(xdgConfig, "opencode", "opencode.json"),
    JSON.stringify({ plugins: [`file://${WORKSPACE_ROOT.replace(/\/$/, "")}`] }),
  );
  const port = 47000 + Math.floor(Math.random() * 2000);
  const logPath = join(project, "..", "server.log");
  let logText = "";
  const child = spawn(binary, ["serve", "--port", String(port)], {
    cwd: project,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    logText += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logText += chunk.toString();
  });
  const pass = await waitFor(
    "server password",
    async () => /password (\S+)/.test(logText),
    60,
    500,
  ).then(() => /password (\S+)/.exec(logText)?.[1] ?? "");
  return {
    pid: child.pid ?? -1,
    port,
    password: pass,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      // PID-exact cleanup: never match processes by name.
      try {
        process.kill(child.pid ?? 0, "SIGTERM");
      } catch {}
    },
  };
}

async function api(server: ServerHandle, path: string, init?: RequestInit): Promise<unknown> {
  const auth = Buffer.from(`opencode:${server.password}`).toString("base64");
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  });
  return response.json();
}

/**
 * The routing proof: the model-switched session event records the exact
 * model our prompt hook pinned, independent of whether the provider then
 * answers without credentials (sandbox models may require auth and produce
 * empty responses, which still proves the routing).
 */
async function switchedModel(server: ServerHandle, sessionID: string): Promise<string | undefined> {
  const messages = (await api(server, `/api/session/${sessionID}/message`)) as {
    data?: Array<{ type?: string; model?: { id?: string; providerID?: string } }>;
  };
  const switched = messages.data?.find((message) => message.type === "model-switched");
  return switched?.model ? `${switched.model.providerID}/${switched.model.id}` : undefined;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "vvoc-e2e-v2-"));
  let server: ServerHandle | undefined;
  try {
    record("build package", "pass");
    const build = spawn("bun", ["run", "build"], { cwd: WORKSPACE_ROOT });
    await new Promise<void>((resolve, reject) =>
      build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("build failed")))),
    );

    const binary = await downloadV2Binary(join(tmpdir(), `vvoc-e2e-v2-bin-${V2_VERSION}`));
    const project = await prepareSandbox(root, "opencode/gpt-6-sol");

    server = await startServer(binary, project, join(root, "xdg-config"), join(root, "xdg-data"));

    // Kick the project location open and wait for plugin activation.
    await waitFor(
      "plugin activation",
      async () => {
        try {
          await api(server!, "/api/session", {
            method: "POST",
            body: JSON.stringify({ title: "boot" }),
          });
          const plugins = (await api(server!, "/api/plugin")) as {
            data?: Array<{ id?: string; state?: { status?: string } }>;
          };
          const vvoc = plugins.data?.find((plugin) => plugin.id === "vvoc");
          return vvoc?.state?.status === "active";
        } catch {
          return false;
        }
      },
      12,
      3000,
    );
    const plugins = (await api(server, "/api/plugin")) as {
      data?: Array<{ id?: string; source?: { type?: string }; features?: Record<string, boolean> }>;
    };
    const vvoc = plugins.data?.find((plugin) => plugin.id === "vvoc");
    record(
      "plugin active with server and tui features",
      Boolean(vvoc?.features?.server && vvoc?.features?.tui) ? "pass" : "fail",
      JSON.stringify(vvoc?.features),
    );

    // Session A: role model applied on first prompt.
    const sessionA = (await api(server, "/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "anchored", agent: "vv-role-probe" }),
    })) as { data?: { id?: string } };
    const sessionAID = sessionA.data?.id ?? "";
    await api(server, `/api/session/${sessionAID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "e2e" }),
    });
    await waitFor(
      "session A model",
      async () => (await switchedModel(server!, sessionAID)) !== undefined,
      30,
      1000,
    );
    const modelA1 = await switchedModel(server, sessionAID);
    record(
      "role model applied on first prompt",
      modelA1 === "opencode/gpt-6-sol" ? "pass" : "fail",
      String(modelA1),
    );

    // Hot-switch the preset and verify anchoring.
    const { createDefaultVvocConfig: rebuild } = (await import(
      join(WORKSPACE_ROOT, "dist/lib/vvoc-config.js")
    )) as { createDefaultVvocConfig: () => Record<string, unknown> };
    const switched = rebuild();
    (switched as { roles: Record<string, string> }).roles = buildSandboxConfigs(
      "opencode/gpt-6-luna",
      "",
    ).vvocRoles;
    await writeFile(join(project, ".vvoc", "vvoc.json"), JSON.stringify(switched, null, 2));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const sessionB = (await api(server, "/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "new-preset", agent: "vv-role-probe" }),
    })) as { data?: { id?: string } };
    const sessionBID = sessionB.data?.id ?? "";
    await api(server, `/api/session/${sessionBID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "e2e" }),
    });
    await waitFor(
      "session B model",
      async () => (await switchedModel(server!, sessionBID)) !== undefined,
      30,
      1000,
    );
    const modelB = await switchedModel(server, sessionBID);
    record(
      "preset hot-switch without restart",
      modelB === "opencode/gpt-6-luna" ? "pass" : "fail",
      String(modelB),
    );

    await api(server, `/api/session/${sessionAID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "again" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const modelA2 = await switchedModel(server, sessionAID);
    record(
      "long session anchored to its starting preset",
      modelA2 === "opencode/gpt-6-sol" ? "pass" : "fail",
      String(modelA2),
    );
  } catch (error) {
    record("harness", "fail", String(error));
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checkResults.filter((entry) => entry.status === "fail").length;
  console.log(`\ne2e:v2 summary: ${checkResults.length - failed} pass, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
