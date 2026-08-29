// FILE: src/plugins/spec-guard/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Annotate reads and validate writes of active .vvoc spec-package XML artifacts with lint verdicts, failing writes in enforce mode only when ERROR-severity findings exist.
//   SCOPE: Startup vvoc snapshot resolution and spec-guard entry parsing, active-vs-archive path gating, cache-backed lint runs with cross-file sibling spec resolution for plans, read annotation through tool.execute.after output mutation, write validation through tool.execute.before for full-content writes and tool.execute.after for edits, enforce throwing only on ERROR findings, and fail-open degradation to warning logs.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/lib/spec-lint.ts, src/lib/spec-lint-cache.ts]
//   LINKS: [M-PLUGIN-SPEC-GUARD, M-SPEC-LINT, M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SpecGuardMode - Enforcement modes warn and enforce.
//   SpecGuardPluginDependencies - Injectable mode resolver, lint cache, file reader, and logging for focused tests.
//   SPEC_GUARD_VERDICT_TAG - Bounded wrapper tag for appended verdict text.
//   SPEC_GUARD_MAX_APPENDED_FINDINGS - Cap on findings surfaced in one verdict text.
//   isSpecGuardTargetPath - True for active .vvoc specs XML artifacts (never archived ones).
//   specGuardPathFromArgs - Extracts the file path from read/edit/write tool args.
//   formatSpecGuardVerdict - Renders a bounded verdict line for tool output.
//   lintSpecGuardFile - Runs a cache-backed lint for one artifact with its sibling spec when applicable.
//   createSpecGuardPlugin - Builds the spec-guard server plugin with injectable dependencies.
//   SpecGuardPlugin - Default production spec-guard server plugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Read-path verdicts now derive from the artifact file on disk instead of the tool's rendered output, whose envelope tags and line prefixes are host-specific.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode-ai/plugin";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  isSpecArchivePath,
  type SpecLintArtifactInput,
  type SpecLintVerdict,
} from "../../lib/spec-lint.js";
import { createSpecLintCache, type SpecLintCache } from "../../lib/spec-lint-cache.js";

// START_BLOCK_CONSTANTS
export type SpecGuardMode = "warn" | "enforce";

export const SPEC_GUARD_VERDICT_TAG = "[spec-guard]";
export const SPEC_GUARD_MAX_APPENDED_FINDINGS = 5;
const SPEC_GUARD_MAX_MESSAGE_CHARS = 160;
const SPEC_GUARD_ARTIFACT_NAMES = new Set(["spec.xml", "plan.xml", "design-context.xml"]);

export type SpecGuardPluginDependencies = {
  mode: () => SpecGuardMode | "off";
  cache: Pick<SpecLintCache, "lint">;
  readFile: (path: string) => Promise<string | undefined>;
  log: (level: "info" | "warn", message: string, extra?: Record<string, unknown>) => Promise<void>;
};
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

/** Extract the target file path from read/edit/write tool args across arg spellings. */
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
  deps: SpecGuardPluginDependencies,
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

// START_BLOCK_PLUGIN_ENTRY
async function resolveStartupMode(directory?: string): Promise<SpecGuardMode | "off"> {
  try {
    const vvoc = await loadVvocConfig(directory ? { cwd: directory } : undefined);
    if (!isVvocPluginEnabled(vvoc.config, "spec-guard")) return "off";
    const entry = vvoc.config.plugins["spec-guard"];
    if (entry && typeof entry === "object" && entry.mode === "enforce") return "enforce";
    return "warn";
  } catch {
    // Fail open: a broken config must not break tool execution.
    return "warn";
  }
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

/**
 * Builds the spec-guard OpenCode server plugin.
 *
 * tool.execute.after annotates reads of active spec-package artifacts with the
 * lint verdict (archived files and foreign paths are never touched) and
 * validates the post-write state of edit/write calls through the cache-backed
 * engine. tool.execute.before fails enforce-mode full-content writes that
 * would leave ERROR-severity findings; draft-status incompleteness never
 * produces ERROR findings, so incremental composition is never blocked. Every
 * guard path fails open with a warning log instead of breaking the tool.
 */
export function createSpecGuardPlugin(
  dependencies: Partial<SpecGuardPluginDependencies> = {},
): Plugin {
  return async ({ directory }) => {
    const mode =
      dependencies.mode !== undefined ? dependencies.mode() : await resolveStartupMode(directory);
    if (mode === "off") return {};

    const deps: SpecGuardPluginDependencies = {
      mode: () => mode,
      cache: await createSpecLintCache(),
      readFile: readTextFile,
      log: async (level, message, extra) => {
        if (level === "warn" || process.env.DEBUG?.includes("vvoc")) {
          console.log(
            `[spec-guard][${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`,
          );
        }
      },
      ...dependencies,
    };

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
      config: async () => {},
      event: async () => {},
      "tool.execute.before": async (_input, output) => {
        if (deps.mode() !== "enforce") return;
        await guard("before-write inspection", async () => {
          const path = specGuardPathFromArgs(output.args);
          if (!path || !isSpecGuardTargetPath(path)) return;
          if (!isWriteToolArgs(output.args)) return;
          const content = (output.args as Record<string, unknown>).content as unknown;
          if (typeof content !== "string") return;
          const { verdict } = await lintSpecGuardFile(deps, path, content);
          if (!verdict.ok) {
            // Proven fail path (hashline-edit precedent): throwing in before fails the tool call.
            throw new Error(
              `${SPEC_GUARD_VERDICT_TAG} enforce: refusing to write ${path} with ERROR-severity lint findings:\n${formatSpecGuardVerdict(verdict, false)}`,
            );
          }
        });
      },
      "tool.execute.after": async (input, output) => {
        if (deps.mode() === "off") return;
        if (input.tool !== "read" && input.tool !== "edit" && input.tool !== "write") return;
        await guard("output annotation", async () => {
          const path = specGuardPathFromArgs(input.args);
          if (!path || !isSpecGuardTargetPath(path)) return;
          const currentMode = deps.mode();

          if (input.tool === "read") {
            // Lint the file from disk, never the tool's rendered output: read
            // tool results are host-specific renderings (line-number prefixes,
            // envelope tags), so the verdict must derive from the artifact bytes.
            const { verdict, cached } = await lintSpecGuardFile(deps, path);
            output.output = `${output.output}\n\n${formatSpecGuardVerdict(verdict, cached)}`;
            return;
          }

          // edit and write: the resulting file state lives on disk now. In
          // enforce mode an ERROR full-content write already failed in before;
          // edits surface the verdict and a leading enforce marker.
          const { verdict, cached } = await lintSpecGuardFile(deps, path);
          if (currentMode === "enforce" && input.tool === "edit" && !verdict.ok) {
            output.output = `${SPEC_GUARD_VERDICT_TAG} enforce: ${path} now contains ERROR-severity lint findings; fix them before continuing\n\n${formatSpecGuardVerdict(verdict, cached)}\n\n${output.output}`;
            return;
          }
          output.output = `${output.output}\n\n${formatSpecGuardVerdict(verdict, cached)}`;
        });
      },
    };
  };
}

function isWriteToolArgs(args: unknown): boolean {
  return (
    !!args &&
    typeof args === "object" &&
    typeof (args as Record<string, unknown>).content === "string"
  );
}

export const SpecGuardPlugin: Plugin = createSpecGuardPlugin();
// END_BLOCK_PLUGIN_ENTRY
