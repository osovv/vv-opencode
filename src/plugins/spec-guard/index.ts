// FILE: src/plugins/spec-guard/index.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Annotate reads and validate writes of active .vvoc spec-package XML artifacts with lint verdicts, failing writes in enforce mode only when ERROR-severity findings exist, using the native OpenCode 2.0.18 tool hook boundary.
//   SCOPE: Native Plugin.define entry, per-bound-family mode resolution from the shared snapshot capture (fail-closed when unbound), active-vs-archive path gating, cache-backed lint runs with cross-file sibling spec resolution for plans, read annotation through the native tool execute.after result, write validation through execute.before for full-content writes and execute.after for edits, enforce throwing only on ERROR findings, and fail-open degradation to warning diagnostics. No V1 plugin context, no fabricated host logger.
//   DEPENDS: [@opencode/plugin, src/runtime/context.ts, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/lib/spec-lint.ts, src/lib/spec-lint-cache.ts]
//   LINKS: [M-PLUGIN-SPEC-GUARD, M-SPEC-LINT, M-PLUGIN-TOGGLE-CONFIG, M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SpecGuardMode - Enforcement modes warn and enforce.
//   SpecGuardNativeResult - Narrow native Tool.Result view mutated by the after handler.
//   SpecGuardHookDependencies - Injectable per-session mode resolver, lint cache, file reader, and logging.
//   SpecGuardHandlers - Native hook handlers for execute.before/after.
//   SPEC_GUARD_VERDICT_TAG - Bounded wrapper tag for appended verdict text.
//   SPEC_GUARD_MAX_APPENDED_FINDINGS - Cap on findings surfaced in one verdict text.
//   isSpecGuardTargetPath - True for active .vvoc specs XML artifacts (never archived ones).
//   specGuardPathFromArgs - Extracts the file path from native read/edit/write tool input.
//   formatSpecGuardVerdict - Renders a bounded verdict line for tool output.
//   lintSpecGuardFile - Runs a cache-backed lint for one artifact with its sibling spec when applicable.
//   createSpecGuardHandlers - Builds native tool hook handlers with injectable dependencies.
//   createSpecGuardPlugin - Builds the native spec-guard plugin with injectable runtime acquisition.
//   SpecGuardPlugin - Default production native spec-guard plugin object.
//   SpecGuardPolicyMode - Resolved mode including explicit off and unknown policy.
//   SpecGuardBeforeEvent - Native execute.before event surface.
//   SpecGuardAfterEvent - Native execute.after event/result surface.
//   SpecGuardPluginOptions - Optional injectable runtime acquisition for tests.
//   default - Default export alias of SpecGuardPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 attempt 2 - Unknown family policy after reconciliation now refuses protected spec mutation/handoff (fail closed) while an explicit disabled capture remains off; warn/enforce behavior preserved.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  isSpecArchivePath,
  type SpecLintArtifactInput,
  type SpecLintVerdict,
} from "../../lib/spec-lint.js";
import { createSpecLintCache, type SpecLintCache } from "../../lib/spec-lint-cache.js";
import type { FamilyCapture } from "../../runtime/types.js";

// START_BLOCK_CONSTANTS
export type SpecGuardMode = "warn" | "enforce";

/** A family whose captured policy is unknown: provider/work policy could not be established. */
export type SpecGuardPolicyMode = SpecGuardMode | "off" | "unknown";

export const SPEC_GUARD_VERDICT_TAG = "[spec-guard]";
export const SPEC_GUARD_MAX_APPENDED_FINDINGS = 5;
const SPEC_GUARD_MAX_MESSAGE_CHARS = 160;
const SPEC_GUARD_ARTIFACT_NAMES = new Set(["spec.xml", "plan.xml", "design-context.xml"]);

/** Narrow native `Tool.Result` view mutated by the execute.after handler. */
export interface SpecGuardNativeResult {
  output?: unknown;
  content?: string | ReadonlyArray<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

/** Native tool hook event surfaces consumed by the spec-guard handlers. */
export interface SpecGuardBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
}

export interface SpecGuardAfterEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
  readonly status: "completed" | "error";
  readonly result?: SpecGuardNativeResult;
  readonly error?: unknown;
}

export type SpecGuardHookDependencies = {
  modeFor: (sessionID: string) => Promise<SpecGuardPolicyMode>;
  /** Trusted native invocation location (absolute directory) for a session, if any. */
  locationFor: (sessionID: string) => Promise<string | undefined>;
  /** Trusted host home used to expand a leading `~`. */
  readonly hostHome: () => string;
  cache: Pick<SpecLintCache, "lint">;
  readFile: (path: string) => Promise<string | undefined>;
  log: (level: "info" | "warn", message: string, extra?: Record<string, unknown>) => Promise<void>;
};

/**
 * Resolve one caller artifact path against the trusted session location so a
 * relative `plan.xml` sibling lookup reads the intended location. Without a
 * location the path is kept verbatim (absolute paths still work).
 */
async function resolveGuardPath(
  deps: SpecGuardHookDependencies,
  sessionID: string,
  callerPath: string,
): Promise<string> {
  const home = deps.hostHome();
  if (callerPath === "~") return resolve(home);
  const expanded = callerPath.startsWith("~/") ? join(home, callerPath.slice(2)) : callerPath;
  if (isAbsolute(expanded)) return resolve(expanded);
  const baseDir = await deps.locationFor(sessionID);
  if (typeof baseDir !== "string" || baseDir.length === 0) return expanded;
  return resolve(baseDir, expanded);
}

export interface SpecGuardHandlers {
  before(event: SpecGuardBeforeEvent): Promise<void>;
  after(event: SpecGuardAfterEvent): Promise<void>;
}
// END_BLOCK_CONSTANTS

// START_BLOCK_PATH_GATE
/** True for active spec-package XML artifacts; archived files are never guarded. */
export function isSpecGuardTargetPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (isSpecArchivePath(normalized)) return false;
  const fileName = normalized.split("/").pop() ?? "";
  if (!SPEC_GUARD_ARTIFACT_NAMES.has(fileName)) return false;
  return /(^|\/)\.vvoc\/specs\//.test(normalized);
}

/** Extract the target file path from native read/edit/write tool input. */
export function specGuardPathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const candidate =
    (args as Record<string, unknown>).filePath ??
    (args as Record<string, unknown>).file_path ??
    (args as Record<string, unknown>).path;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}
// END_BLOCK_PATH_GATE

// START_BLOCK_VERDICT_FORMAT
export function formatSpecGuardVerdict(verdict: SpecLintVerdict, cached: boolean): string {
  const errors = verdict.findings.filter((f) => f.severity === "error");
  const warnings = verdict.findings.filter((f) => f.severity === "warning");
  if (verdict.findings.length === 0) {
    return `${SPEC_GUARD_VERDICT_TAG} ${verdict.kind} OK${cached ? " (cached)" : ""}`;
  }
  const lines = [
    `${SPEC_GUARD_VERDICT_TAG} ${verdict.kind} ${errors.length} error(s), ${warnings.length} warning(s)${cached ? " (cached)" : ""}`,
  ];
  for (const finding of [...errors, ...warnings].slice(0, SPEC_GUARD_MAX_APPENDED_FINDINGS)) {
    const message =
      finding.message.length > SPEC_GUARD_MAX_MESSAGE_CHARS
        ? `${finding.message.slice(0, SPEC_GUARD_MAX_MESSAGE_CHARS - 3)}...`
        : finding.message;
    lines.push(
      `${SPEC_GUARD_VERDICT_TAG} ${verdict.file}:${finding.line} ${finding.severity} [${finding.rule}]: ${message}`,
    );
  }
  if (verdict.findings.length > SPEC_GUARD_MAX_APPENDED_FINDINGS) {
    lines.push(
      `${SPEC_GUARD_VERDICT_TAG} ...and ${verdict.findings.length - SPEC_GUARD_MAX_APPENDED_FINDINGS} more finding(s)`,
    );
  }
  return lines.join("\n");
}
// END_BLOCK_VERDICT_FORMAT

// START_BLOCK_LINT_RUN
/**
 * Cache-backed lint for one artifact. Plan artifacts pull in their sibling
 * spec.xml so the plan-subset-of-spec rule runs; a missing sibling degrades to
 * the engine's spec-missing warning, never to a hard failure.
 */
export async function lintSpecGuardFile(
  deps: SpecGuardHookDependencies,
  filePath: string,
  contentOverride?: string,
): Promise<{ verdict: SpecLintVerdict; cached: boolean }> {
  const normalized = filePath.replace(/\\/g, "/");
  let content = contentOverride;
  if (content === undefined) {
    try {
      content = await deps.readFile(normalized);
    } catch {
      content = undefined;
    }
  }
  if (content === undefined) {
    return {
      verdict: {
        version: 0,
        file: normalized,
        kind: "unknown",
        ok: false,
        findings: [
          {
            severity: "warning",
            rule: "spec_guard.unreadable",
            message: "file could not be read for linting",
            file: normalized,
            line: 1,
          },
        ],
      },
      cached: false,
    };
  }
  const inputs: SpecLintArtifactInput[] = [{ file: normalized, content }];
  if (normalized.endsWith("plan.xml")) {
    const sibling = normalized.slice(0, -"plan.xml".length) + "spec.xml";
    const siblingContent = sibling === normalized ? undefined : await deps.readFile(sibling);
    if (siblingContent !== undefined) {
      inputs.push({ file: sibling, content: siblingContent });
    }
  }
  const result = await deps.cache.lint(inputs);
  return { verdict: result.verdicts[0], cached: result.hit };
}
// END_BLOCK_LINT_RUN

// START_BLOCK_HANDLERS
function isWriteToolInput(args: unknown): boolean {
  return (
    !!args &&
    typeof args === "object" &&
    typeof (args as Record<string, unknown>).content === "string"
  );
}

function appendVerdict(result: SpecGuardNativeResult, text: string): void {
  if (typeof result.content === "string") {
    result.content = `${result.content}\n\n${text}`;
    return;
  }
  if (Array.isArray(result.content)) {
    // Native `content` arrays are re-assigned with an appended text frame so the
    // model sees the verdict without mutating any opaque non-text frame.
    result.content = [...result.content, { type: "text", text: `\n\n${text}` }];
    return;
  }
  // A result that only carries structured output keeps its structured payload
  // untouched; the verdict is still surfaced through the metadata channel.
  result.metadata = { ...result.metadata, specGuard: text };
}

function prependVerdict(result: SpecGuardNativeResult, text: string): void {
  if (typeof result.content === "string") {
    result.content = `${text}\n\n${result.content}`;
    return;
  }
  if (Array.isArray(result.content)) {
    result.content = [{ type: "text", text: `${text}\n\n` }, ...result.content];
    return;
  }
  result.metadata = { ...result.metadata, specGuard: text };
}

/**
 * Build the native `execute.before`/`execute.after` handlers. Read verdicts are
 * derived from the artifact bytes on disk (never the host rendering); a
 * per-session mode that is `"off"` leaves every tool untouched. Every guard
 * path fails open with a bounded warning except the deliberate enforce throw.
 */
export function createSpecGuardHandlers(deps: SpecGuardHookDependencies): SpecGuardHandlers {
  const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      // Only the deliberate enforce throw must escape this wrapper.
      if (error instanceof Error && error.message.includes(SPEC_GUARD_VERDICT_TAG)) throw error;
      await deps.log(
        "warn",
        `spec-guard ${operation} failed open: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  return {
    async before(event) {
      const mode = await deps.modeFor(event.sessionID);
      if (mode === "off") return;
      await guard("before-write inspection", async () => {
        const rawPath = specGuardPathFromArgs(event.input);
        if (!rawPath) return;
        const path = await resolveGuardPath(deps, event.sessionID, rawPath);
        if (!isSpecGuardTargetPath(path)) return;
        if (mode === "unknown") {
          throw new Error(
            `${SPEC_GUARD_VERDICT_TAG} unknown-policy: refusing to mutate ${path} because no spec-guard policy capture is bound to this session.`,
          );
        }
        if (mode !== "enforce") return;
        if (!isWriteToolInput(event.input)) return;
        const content = (event.input as Record<string, unknown>).content as unknown;
        if (typeof content !== "string") return;
        const { verdict } = await lintSpecGuardFile(deps, path, content);
        if (!verdict.ok) {
          // Throwing in execute.before fails the native tool call before mutation.
          throw new Error(
            `${SPEC_GUARD_VERDICT_TAG} enforce: refusing to write ${path} with ERROR-severity lint findings:\n${formatSpecGuardVerdict(verdict, false)}`,
          );
        }
      });
    },

    async after(event) {
      const mode = await deps.modeFor(event.sessionID);
      if (mode === "off") return;
      if (event.tool !== "read" && event.tool !== "edit" && event.tool !== "write") return;
      if (event.status !== "completed" || event.result === undefined) return;
      await guard("output annotation", async () => {
        const result = event.result as SpecGuardNativeResult;
        const rawPath = specGuardPathFromArgs(event.input);
        if (!rawPath) return;
        const path = await resolveGuardPath(deps, event.sessionID, rawPath);
        if (!isSpecGuardTargetPath(path)) return;
        if (mode === "unknown") {
          throw new Error(
            `${SPEC_GUARD_VERDICT_TAG} unknown-policy: refusing to hand off ${path} because no spec-guard policy capture is bound to this session.`,
          );
        }

        if (event.tool === "read") {
          // Lint the file from disk, never the tool's rendered output: read
          // tool results are host-specific renderings (line-number prefixes,
          // envelope tags), so the verdict must derive from the artifact bytes.
          const { verdict, cached } = await lintSpecGuardFile(deps, path);
          appendVerdict(result, formatSpecGuardVerdict(verdict, cached));
          return;
        }

        // edit and write: the resulting file state lives on disk now. In
        // enforce mode an ERROR full-content write already failed in before;
        // edits surface the verdict and a leading enforce marker.
        const { verdict, cached } = await lintSpecGuardFile(deps, path);
        if (mode === "enforce" && event.tool === "edit" && !verdict.ok) {
          prependVerdict(
            result,
            `${SPEC_GUARD_VERDICT_TAG} enforce: ${path} now contains ERROR-severity lint findings; fix them before continuing\n\n${formatSpecGuardVerdict(verdict, cached)}`,
          );
          return;
        }
        appendVerdict(result, formatSpecGuardVerdict(verdict, cached));
      });
    },
  };
}
// END_BLOCK_HANDLERS

// START_BLOCK_PLUGIN_ENTRY
/** Resolve the bound-family mode; unbound work fails closed to `"off"`. */
async function resolveFamilyMode(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<SpecGuardPolicyMode> {
  const read = async (): Promise<FamilyCapture | undefined> => {
    try {
      return await runtime.snapshots.configFor(sessionID);
    } catch {
      return undefined;
    }
  };
  let capture = await read();
  if (capture === undefined) {
    // A first accepted workload may be persisted but not yet published.
    try {
      await runtime.snapshots.accept({ sessionID });
    } catch {
      // fall through to the second read
    }
    capture = await read();
  }
  if (capture === undefined) return "unknown";
  if (!isVvocPluginEnabled(capture.vvoc, "spec-guard")) return "off";
  const entry = capture.vvoc.plugins?.["spec-guard"];
  if (entry && typeof entry === "object" && entry.mode === "enforce") return "enforce";
  return "warn";
}

function readTextFile(path: string): Promise<string | undefined> {
  return Bun.file(path)
    .text()
    .then((value) => value)
    .catch(() => undefined);
}

function createConsoleLog(): SpecGuardHookDependencies["log"] {
  return async (level, message, extra) => {
    if (level === "warn" || process.env.DEBUG?.includes("vvoc")) {
      const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
      console.log(`[spec-guard][${level}] ${message.slice(0, 1000)}${suffix}`);
    }
  };
}

export interface SpecGuardPluginOptions {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
}

/** Native spec-guard plugin factory; the default export uses the real shared runtime. */
export function createSpecGuardPlugin(options: SpecGuardPluginOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.spec-guard",
    setup: async (ctx) => {
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
      const cache = await createSpecLintCache();
      let clientPromise: Promise<unknown> | undefined;
      const locationFor = async (sessionID: string): Promise<string | undefined> => {
        try {
          const client = (await (clientPromise ??= runtime.client())) as unknown as {
            session: { get(input: { sessionID: string }): Promise<unknown> };
          };
          const info = (await client.session.get({ sessionID })) as {
            location?: { directory?: unknown };
          };
          const directory = info?.location?.directory;
          if (typeof directory === "string" && directory.length > 0) return directory;
        } catch {
          // fall through to the plugin location
        }
        return ctx.location?.directory;
      };
      const handlers = createSpecGuardHandlers({
        modeFor: (sessionID) => resolveFamilyMode(runtime, sessionID),
        locationFor,
        hostHome: () => process.env.OPENCODE_TEST_HOME ?? homedir(),
        cache,
        readFile: readTextFile,
        log: createConsoleLog(),
      });
      const before = await ctx.tool.hook("execute.before", (event) => handlers.before(event));
      const after = await ctx.tool.hook("execute.after", (event) => handlers.after(event));
      return async () => {
        await before.dispose();
        await after.dispose();
        await runtime.release();
      };
    },
  });
}

export const SpecGuardPlugin: Plugin.Plugin = createSpecGuardPlugin();
export default SpecGuardPlugin;
// END_BLOCK_PLUGIN_ENTRY
