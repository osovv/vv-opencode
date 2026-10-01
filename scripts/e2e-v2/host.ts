#!/usr/bin/env bun
// FILE: scripts/e2e-v2/host.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide the isolated, owned, loopback-only process, scratch, and packaging primitives for the v2 real-host harness.
//   SCOPE: Pinned host identity, an ownership-marked mkdtemp scratch with guarded removal, workspace packing into a tarball, offline packed-package installation, allow-listed child environments, exact live-handle PID ownership that never signals an exited or foreign process, bounded subprocess and HTTP helpers, non-loopback URL refusal, native service-registration password discovery, and authenticated native HTTP helpers. It never downloads a host, never calls service ensure/stop, and never kills by process name.
//   DEPENDS: [node:child_process, node:crypto, node:fs, node:fs/promises, node:path, node:url]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PINNED_HOST_VERSION - Pinned OpenCode host version accepted by the harness.
//   PINNED_HOST_SHA256 - SHA-256 of the pinned host binary.
//   PINNED_SOURCE_COMMIT - Pinned native host source commit recorded in evidence.
//   DEFAULT_HOST_BINARY - Default pinned host binary location for local acceptance.
//   LOOPBACK_HOSTNAMES - Hostnames accepted as loopback for provider dispatch.
//   HOST_ENV_KEYS - Allow-listed environment keys passed to the owned host process.
//   OWNERSHIP_MARKER - Marker file proving the harness created a scratch directory.
//   OwnedScratch - Ownership-marked scratch directory created by the harness.
//   sha256File - Stream a file and return its lowercase SHA-256 hex digest.
//   isLoopbackHostname - True when a hostname is a literal loopback address.
//   assertLoopbackHttpUrl - Throw unless a URL points at a loopback HTTP endpoint.
//   assertSafeScratchBase - Reject a scratch base at the filesystem/workspace/home root.
//   assertSafeCleanupTarget - Reject a cleanup target that is the base, outside it, a root, or a symlink.
//   createOwnedScratch - Create a fresh mkdtemp child with an ownership marker.
//   removeOwnedScratch - Remove only a marked, guarded scratch child.
//   buildHostEnv - Build an allow-listed child environment from scratch.
//   redactEnv - Redact private environment values before they reach evidence or logs.
//   CommandResult - Result of one bounded short-lived command.
//   DEFAULT_COMMAND_TIMEOUT_MS - Default timeout for one bounded short-lived command.
//   DEFAULT_HTTP_TIMEOUT_MS - Default timeout for one bounded native HTTP request.
//   DEFAULT_MAX_BYTES - Default output cap for one bounded command or HTTP response.
//   runCommand - Run one bounded short-lived command and capture status and output.
//   packedArtifactIssues - Expected top-level entries that make a packed workspace a valid installable artifact.
//   verifyPackedArtifact - Prove the tarball is readable and carries the expected manifest identity.
//   packWorkspace - Create the packed workspace tarball used by the isolated fixture.
//   linkDependencyTree - Symlink repository dependencies so the packed package resolves offline.
//   installPackedPackage - Extract the packed tarball into an isolated node_modules tree.
//   InstalledArtifact - Real installed package/dependency paths and resolved versions.
//   installPackedPackageWithDependencies - Install the packed tarball with its declared dependency graph (no workspace symlinks).
//   installedArtifactPathIssues - Prove installed paths resolve inside the isolated project, never the workspace.
//   OwnedProcesses - Exact live-handle process registry that refuses foreign or exited processes.
//   waitForRegisteredService - Read the native service registration password from XDG state.
//   NativeHttpResponse - One decoded native HTTP response.
//   NativeHttpApi - Authenticated bounded fetch helper bound to one owned host.
//   readBoundedText - Read a response body up to a byte cap.
//   createNativeApi - Build the authenticated native HTTP helper for an owned host.
//   discoverHostBinary - Resolve the pinned host binary from environment or the pinned location.
//   writeFileEnsured - Write one file, creating parent directories.
//   fileUrl - Expose the workspace file URL helper for fixture source generation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-FULL - Added declared-dependency install of the packed tarball plus installed-path verification, so acceptance runs the real installed artifact instead of workspace dependency symlinks.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-003 correction - Added ownership-marked scratch, live-handle PID ownership, bounded commands/HTTP, and precise loopback guards.]
// END_CHANGE_SUMMARY

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Pinned OpenCode host version accepted by the harness. */
export const PINNED_HOST_VERSION = "2.0.18";
/** SHA-256 of the pinned host binary. */
export const PINNED_HOST_SHA256 =
  "10d405161d8b9595f4a2ec31254e961969e6ca3f8239ac9bd55b6ff6431dc24f";
/** Pinned native host source commit recorded in evidence. */
export const PINNED_SOURCE_COMMIT = "cd9a14a6b688d4021bee381dfd39d2cef9c0f862";
/** Default pinned host binary location for local acceptance. */
export const DEFAULT_HOST_BINARY = "/tmp/opencode/vvoc-seam-host-2.0.18/opencode";
/** Marker file proving the harness created a scratch directory. */
export const OWNERSHIP_MARKER = ".vvoc-e2e-owner.json";

/** Hostnames accepted as loopback for provider dispatch. */
export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "::1", "localhost"] as const;

/** Allow-listed environment keys passed to the owned host process. */
export const HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "LOOPBACK_API_KEY",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "VVOC_E2E_CONTROL_FILE",
  "VVOC_E2E_PROVIDER_ORIGIN",
  "VVOC_E2E_ALLOWED_PROVIDERS",
  "VVOC_E2E_TRACE",
  "VVOC_E2E_DELAY_MARKER",
  "VVOC_E2E_DELAY_MS",
] as const;

const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

// START_BLOCK_HASHING
/** Stream a file and return its lowercase SHA-256 hex digest. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}
// END_BLOCK_HASHING

// START_BLOCK_LOOPBACK_GUARD
/** True when a hostname is a literal loopback address. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(normalized);
}

/** Throw unless a URL points at a loopback HTTP endpoint. */
export function assertLoopbackHttpUrl(raw: string, label = "url"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`refusing ${label}: not an absolute URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing ${label}: unsupported protocol ${url.protocol}`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`refusing ${label}: non-loopback host ${url.hostname}`);
  }
  return url;
}
// END_BLOCK_LOOPBACK_GUARD

// START_BLOCK_SCRATCH_LIFECYCLE
/** Ownership-marked scratch directory created by the harness. */
export interface OwnedScratch {
  readonly dir: string;
  readonly base: string;
  readonly markerPath: string;
}

/** Reject a scratch base at the filesystem, workspace, or home root. */
export function assertSafeScratchBase(base: string): string {
  const resolved = resolve(base);
  if (parse(resolved).root === resolved) {
    throw new Error(`refusing scratch base at the filesystem root: ${resolved}`);
  }
  if (resolved === resolve(process.cwd())) {
    throw new Error(`refusing scratch base at the workspace root: ${resolved}`);
  }
  if (resolved === resolve(homedir())) {
    throw new Error(`refusing scratch base at the home directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Reject a cleanup target that is the filesystem root, the scratch base itself,
 * outside the base, or a symlink. This is the only path the harness ever
 * recursively deletes, and it must be a marked mkdtemp child of the base.
 */
export function assertSafeCleanupTarget(target: string, base: string): string {
  const resolved = resolve(target);
  const safeBase = resolve(base);
  if (parse(resolved).root === resolved) {
    throw new Error(`refusing to remove the filesystem root: ${resolved}`);
  }
  if (resolved === safeBase) {
    throw new Error(`refusing to remove the scratch base itself: ${resolved}`);
  }
  if (resolved === resolve(process.cwd()) || resolved === resolve(homedir())) {
    throw new Error(`refusing to remove a protected directory: ${resolved}`);
  }
  const rel = relative(safeBase, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to remove a path outside the scratch base: ${resolved}`);
  }
  return resolved;
}

/** Create a fresh mkdtemp child with an ownership marker. */
export async function createOwnedScratch(base: string): Promise<OwnedScratch> {
  const safeBase = assertSafeScratchBase(base);
  await mkdir(safeBase, { recursive: true });
  const dir = await mkdtemp(join(safeBase, "vvoc-e2e-v2-"));
  const resolvedDir = resolve(dir);
  const markerPath = join(resolvedDir, OWNERSHIP_MARKER);
  await writeFile(
    markerPath,
    JSON.stringify({ tool: "vvoc-e2e-v2", pid: process.pid, createdAt: new Date().toISOString() }),
    "utf8",
  );
  return { dir: resolvedDir, base: safeBase, markerPath };
}

/** Remove only a marked, guarded scratch child. */
export async function removeOwnedScratch(scratch: OwnedScratch): Promise<void> {
  const resolved = assertSafeCleanupTarget(scratch.dir, scratch.base);
  const info = await lstat(resolved);
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to remove a symlinked scratch target: ${resolved}`);
  }
  let marker: { tool?: string } | undefined;
  try {
    marker = JSON.parse(await readFile(scratch.markerPath, "utf8")) as { tool?: string };
  } catch {
    throw new Error(`refusing to remove scratch without an ownership marker: ${resolved}`);
  }
  if (marker.tool !== "vvoc-e2e-v2") {
    throw new Error(`refusing to remove scratch with a foreign ownership marker: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
// END_BLOCK_SCRATCH_LIFECYCLE

// START_BLOCK_ENV
/** Build an allow-listed child environment from scratch. */
export function buildHostEnv(
  base: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const raw = extra[key] ?? base[key];
    if (raw !== undefined && raw !== "") env[key] = raw;
  }
  return env;
}

/** Redact private environment values before they reach evidence or logs. */
export function redactEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = key === "PATH" || /KEY|TOKEN|SECRET|PASSWORD/i.test(key) ? "[redacted]" : value;
  }
  return redacted;
}
// END_BLOCK_ENV

// START_BLOCK_COMMAND
/** Result of one bounded short-lived command. */
export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Run one bounded short-lived command and capture status and output. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  } = {},
): Promise<CommandResult> {
  const proc = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const append = (current: string, chunk: Buffer): string => {
    if (current.length >= maxBytes) return current;
    return (current + chunk.toString()).slice(0, maxBytes);
  };
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const status = await new Promise<number>((resolvePromise) => {
    proc.on("error", () => resolvePromise(-1));
    proc.on("close", (code) => resolvePromise(code ?? -1));
  });
  clearTimeout(timer);
  return { status, stdout, stderr, timedOut };
}
// END_BLOCK_COMMAND

// START_BLOCK_PACK
/** Expected top-level entries that make a packed workspace a valid installable artifact. */
export function packedArtifactIssues(
  entries: readonly string[],
  expected: { readonly name: string; readonly version: string },
): string[] {
  const required = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/runtime/context.js",
    "package/dist/plugins/model-roles/index.js",
  ];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (!entries.includes("package/package.json")) missing.push("package/package.json (metadata)");
  const issues = missing.map((entry) => `packed artifact missing ${entry}`);
  if (!entries.some((entry) => entry.startsWith("package/dist/"))) {
    issues.push("packed artifact contains no dist output");
  }
  void expected;
  return issues;
}

/**
 * Prove the packed tarball is a valid installable artifact for this workspace.
 * `npm pack --ignore-scripts` is not used because npm still runs the workspace
 * `prepare` (lefthook) hook here, which mutates user git hooks; `bun pm pack
 * --ignore-scripts` produces the same npm tarball format without running it.
 */
export async function verifyPackedArtifact(input: {
  readonly tarballPath: string;
  readonly name: string;
  readonly version: string;
}): Promise<{ readonly entries: number; readonly manifest: { name?: string; version?: string } }> {
  const listed = await runCommand("tar", ["tzf", input.tarballPath]);
  if (listed.status !== 0) {
    throw new Error(`packed artifact is not a readable tar: ${listed.stderr}`);
  }
  const entries = listed.stdout.split("\n").filter((line) => line.length > 0);
  const issues = packedArtifactIssues(entries, { name: input.name, version: input.version });
  if (issues.length > 0) throw new Error(issues.join("; "));
  const manifestResult = await runCommand("tar", [
    "xzOf",
    input.tarballPath,
    "package/package.json",
  ]);
  if (manifestResult.status !== 0) {
    throw new Error(`packed artifact package.json is unreadable: ${manifestResult.stderr}`);
  }
  const manifest = JSON.parse(manifestResult.stdout) as { name?: string; version?: string };
  if (manifest.name !== input.name || manifest.version !== input.version) {
    throw new Error(
      `packed artifact manifest mismatch: ${manifest.name}@${manifest.version} (expected ${input.name}@${input.version})`,
    );
  }
  return { entries: entries.length, manifest };
}

/** Create the packed workspace tarball using the script-suppressed package manager pack command. */
export async function packWorkspace(input: {
  readonly workspaceRoot: string;
  readonly filename: string;
}): Promise<{ readonly tarballPath: string; readonly sha256: string }> {
  const filename = isAbsolute(input.filename)
    ? input.filename
    : join(input.workspaceRoot, input.filename);
  await mkdir(dirname(filename), { recursive: true });
  await rm(filename, { force: true });
  const result = await runCommand("bun", ["pm", "pack", "--ignore-scripts", "--filename", filename], {
    cwd: input.workspaceRoot,
  });
  if (result.status !== 0 || !existsSync(filename)) {
    throw new Error(`pack failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return { tarballPath: filename, sha256: await sha256File(filename) };
}

/** Symlink repository dependencies so the packed package resolves offline. */
async function linkDependencyTree(
  sourceNodeModules: string,
  targetNodeModules: string,
): Promise<void> {
  if (!existsSync(sourceNodeModules)) return;
  await mkdir(targetNodeModules, { recursive: true });
  for (const entry of readdirSync(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === "@osovv") continue;
    const target = join(targetNodeModules, entry.name);
    if (existsSync(target)) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      for (const scoped of readdirSync(join(sourceNodeModules, entry.name), { withFileTypes: true })) {
        const scopedTarget = join(target, scoped.name);
        if (existsSync(scopedTarget)) continue;
        await symlink(join(sourceNodeModules, entry.name, scoped.name), scopedTarget, "dir");
      }
      continue;
    }
    await symlink(join(sourceNodeModules, entry.name), target, "dir");
  }
}

/** Extract the packed tarball into an isolated node_modules tree. */
export async function installPackedPackage(input: {
  readonly tarballPath: string;
  readonly nodeModulesDir: string;
  readonly workspaceNodeModules: string;
}): Promise<string> {
  const { nodeModulesDir } = input;
  const extractDir = join(nodeModulesDir, ".vvoc-e2e-extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  const result = await runCommand("tar", ["xzf", input.tarballPath, "-C", extractDir]);
  if (result.status !== 0) throw new Error(`tarball extract failed: ${result.stderr}`);
  const packageDir = join(nodeModulesDir, "@osovv", "vv-opencode");
  await mkdir(dirname(packageDir), { recursive: true });
  await rm(packageDir, { recursive: true, force: true });
  await rename(join(extractDir, "package"), packageDir);
  await rm(extractDir, { recursive: true, force: true });
  await linkDependencyTree(input.workspaceNodeModules, nodeModulesDir);
  return packageDir;
}

/** Result of installing the packed tarball with its declared dependency graph. */
export interface InstalledArtifact {
  readonly projectDir: string;
  readonly packageDir: string;
  readonly packageVersion: string;
  readonly resolvedDependencies: Readonly<Record<string, string>>;
  /** Real (resolved) paths of the installed package and its declared dependencies. */
  readonly loadedPaths: Readonly<Record<string, string>>;
}

/**
 * Install the packed tarball into an isolated project using its DECLARED
 * dependency graph via the package manager (no workspace `node_modules`
 * symlinks). Dependency resolution may use the local package-manager cache; it
 * never substitutes repository files for the installed artifact.
 */
export async function installPackedPackageWithDependencies(input: {
  readonly workspaceRoot: string;
  readonly tarballPath: string;
  readonly projectDir: string;
}): Promise<InstalledArtifact> {
  await mkdir(input.projectDir, { recursive: true });
  await writeFile(
    join(input.projectDir, "package.json"),
    `${JSON.stringify(
      {
        name: "vvoc-e2e-installed",
        private: true,
        version: "0.0.0",
        dependencies: { "@osovv/vv-opencode": `file:${input.tarballPath}` },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const install = await runCommand("bun", ["install", "--ignore-scripts"], {
    cwd: input.projectDir,
    timeoutMs: 240_000,
  });
  if (install.status !== 0) {
    throw new Error(
      `declared-dependency install failed (${install.status}): ${install.stderr || install.stdout}`,
    );
  }
  const packageDir = join(input.projectDir, "node_modules", "@osovv", "vv-opencode");
  if (!existsSync(packageDir)) {
    throw new Error(`installed package directory is missing: ${packageDir}`);
  }
  if ((await lstat(packageDir)).isSymbolicLink()) {
    throw new Error(`installed package is a symlink, not a real install: ${packageDir}`);
  }
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  const resolvedDependencies: Record<string, string> = {};
  const loadedPaths: Record<string, string> = {};
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const manifestPath = join(input.projectDir, "node_modules", name, "package.json");
    if (!existsSync(manifestPath)) {
      resolvedDependencies[name] = "missing";
      continue;
    }
    const dependencyManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version?: string;
    };
    resolvedDependencies[name] = dependencyManifest.version ?? "unknown";
    loadedPaths[name] = await realpath(join(input.projectDir, "node_modules", name));
  }
  loadedPaths["@osovv/vv-opencode"] = await realpath(packageDir);
  return {
    projectDir: input.projectDir,
    packageDir,
    packageVersion: manifest.version ?? "unknown",
    resolvedDependencies,
    loadedPaths,
  };
}

/**
 * Verify every installed artifact path resolves outside the workspace and inside
 * the isolated project, so a workspace symlink can never be reported as an
 * installed-artifact pass.
 */
export function installedArtifactPathIssues(
  artifact: InstalledArtifact,
  workspaceRoot: string,
): string[] {
  const issues: string[] = [];
  for (const [name, path] of Object.entries(artifact.loadedPaths)) {
    if (path.startsWith(resolve(workspaceRoot) + "/")) {
      issues.push(`installed ${name} resolves into the workspace: ${path}`);
    }
    if (!path.startsWith(`${resolve(artifact.projectDir)}/`)) {
      issues.push(`installed ${name} resolves outside the isolated project: ${path}`);
    }
  }
  return issues;
}
// END_BLOCK_PACK

// START_BLOCK_OWNERSHIP
/**
 * Exact live-handle process registry. Only processes spawned through this
 * registry are tracked, handles are dropped the moment a child exits, and
 * signalling goes through the live `ChildProcess` handle so a reused PID can
 * never be hit. No process-name matching or broad kills exist here.
 */
export class OwnedProcesses {
  readonly #procs = new Map<number, ChildProcess>();

  spawn(
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
  ): ChildProcess {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      const pid = child.pid;
      this.#procs.set(pid, child);
      child.once("exit", () => {
        if (this.#procs.get(pid) === child) this.#procs.delete(pid);
      });
    }
    return child;
  }

  /** Live PIDs currently owned by this registry. */
  get pids(): number[] {
    return [...this.#procs.keys()];
  }

  owns(pid: number): boolean {
    return this.#procs.has(pid);
  }

  /** Signal one live owned PID; foreign or exited PIDs are refused, never signalled. */
  signal(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    const child = this.#procs.get(pid);
    if (child === undefined) {
      throw new Error(`refusing to signal non-owned pid ${pid}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#procs.delete(pid);
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // The handle is already closed.
    }
  }

  /** Terminate every live owned process, reap exited handles, and join exits. */
  async stopAll(signal: NodeJS.Signals = "SIGTERM", timeoutMs = 6_000): Promise<void> {
    const reap = (): void => {
      for (const [pid, child] of [...this.#procs]) {
        if (child.exitCode !== null || child.signalCode !== null) this.#procs.delete(pid);
      }
    };
    for (const [pid, child] of [...this.#procs]) {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.#procs.delete(pid);
        continue;
      }
      try {
        child.kill(signal);
      } catch {
        // The handle is already closed.
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (this.#procs.size > 0 && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      reap();
    }
    for (const [pid, child] of [...this.#procs]) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The handle is already closed.
        }
      }
      this.#procs.delete(pid);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}
// END_BLOCK_OWNERSHIP

// START_BLOCK_SERVICE
/** Read the native service registration password from XDG state, never from logs. */
export async function waitForRegisteredService(input: {
  readonly servicePath: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}): Promise<string> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const pollMs = input.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(input.servicePath, "utf8")) as { password?: string };
      if (typeof parsed.password === "string" && parsed.password.length > 0) return parsed.password;
    } catch {
      // Not registered yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`native service did not register at ${input.servicePath}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
}
// END_BLOCK_SERVICE

// START_BLOCK_NATIVE_API
/** One decoded native HTTP response. */
export interface NativeHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

/** Authenticated bounded fetch helper bound to one owned host. */
export type NativeHttpApi = (path: string, init?: RequestInit) => Promise<NativeHttpResponse>;

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length >= maxBytes) {
      text = text.slice(0, maxBytes);
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text;
}

/** Build the authenticated native HTTP helper for an owned host. */
export function createNativeApi(input: {
  readonly baseUrl: string;
  readonly password: string;
  readonly directory: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}): NativeHttpApi {
  const base = assertLoopbackHttpUrl(input.baseUrl, "native host base url");
  const auth = Buffer.from(`opencode:${input.password}`).toString("base64");
  const timeoutMs = input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  return async (path, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(path, `${base.origin}/`), {
        ...init,
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
          "x-opencode-directory": input.directory,
          ...init.headers,
        },
        signal: init.signal ?? controller.signal,
      });
      const text = await readBoundedText(response, maxBytes);
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      return { status: response.status, body, text };
    } finally {
      clearTimeout(timer);
    }
  };
}
// END_BLOCK_NATIVE_API

// START_BLOCK_DISCOVERY
/** Resolve the pinned host binary from the environment or the pinned location. */
export function discoverHostBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.VVOC_E2E_V2_HOST;
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
  if (existsSync(DEFAULT_HOST_BINARY)) return DEFAULT_HOST_BINARY;
  return undefined;
}

/** Write one file, creating parent directories. */
export async function writeFileEnsured(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/** Expose the workspace file URL helper for fixture source generation. */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}
// END_BLOCK_DISCOVERY
