// FILE: src/plugins/spec-guard/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register spec-guard read annotation and write enforcement on the OpenCode v2 tool hooks with per-session location resolution.
//   SCOPE: v2 setup only: annotate read and edit tool results with lint verdicts, refuse enforce-mode full-content writes carrying ERROR findings by failing the tool call, resolve mode and toggle per session location, and degrade fail-open with logged warnings.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/lib/spec-lint-cache.ts, src/plugins/spec-guard/index.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-SPEC-GUARD, V-M-PLUGIN-SPEC-GUARD, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupSpecGuardV2 - Register the spec-guard tool hooks for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-003 - Ported spec-guard onto v2 tool hooks with per-session mode resolution.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { createSpecLintCache } from "../../lib/spec-lint-cache.js";
import { readFile } from "node:fs/promises";
import {
  formatSpecGuardVerdict,
  isSpecGuardTargetPath,
  lintSpecGuardFile,
  SPEC_GUARD_VERDICT_TAG,
  specGuardPathFromArgs,
} from "./index.js";

// START_BLOCK_RESOLVE_V2_MODE
async function resolveMode(
  adapter: V2AdapterContext,
  sessionID: string,
): Promise<"warn" | "enforce" | "off"> {
  try {
    const snapshot = await adapter.resolver.forSession(sessionID, (input) =>
      adapter.ctx.session.get(input),
    );
    if (!snapshot) return "off";
    const entry = (snapshot.config.plugins as Record<string, unknown> | undefined)?.["spec-guard"];
    if (entry === undefined || entry === true) return "warn";
    if (entry === false) return "off";
    if (typeof entry === "object" && entry !== null) {
      const mode = (entry as { mode?: unknown }).mode;
      if (mode === "enforce" || mode === "warn") return mode;
      return "off";
    }
    return "warn";
  } catch {
    return "off";
  }
}
// END_BLOCK_RESOLVE_V2_MODE

// START_BLOCK_SETUP_SPEC_GUARD_V2
/**
 * Register the spec-guard hooks on the v2 runtime.
 *
 * The v1 tool.execute.before write refusal becomes a throwing v2
 * execute.before hook (the only v2 hook whose failure rejects the tool call),
 * and the v1 output annotation becomes a mutation of the completed tool
 * result's content. Mode and toggle resolve per session location, and every
 * non-enforce failure degrades fail-open with a logged warning.
 */
export async function setupSpecGuardV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  const cache = await createSpecLintCache();
  const readFileDependency = (path: string) => readFile(path, "utf8").catch(() => undefined);
  const log = async (level: "info" | "warn", message: string, _extra?: Record<string, unknown>) => {
    if (level === "warn" || process.env.DEBUG?.includes("vvoc")) {
      console.log(`[spec-guard][${level}] ${message}`);
    }
  };
  const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Error && error.message.includes(SPEC_GUARD_VERDICT_TAG)) throw error;
      await log("warn", `spec-guard ${operation} failed open: ${String(error)}`);
      return undefined;
    }
  };

  const before = await adapter.ctx.tool.hook("execute.before", async (event) => {
    const mode = await resolveMode(adapter, String(event.sessionID));
    if (mode !== "enforce") return;
    await guard("before-write inspection", async () => {
      const path = specGuardPathFromArgs(event.input);
      if (!path || !isSpecGuardTargetPath(path)) return;
      const content = (event.input as Record<string, unknown> | undefined)?.content;
      if (typeof content !== "string") return;
      const { verdict } = await lintSpecGuardFile(
        { mode: () => "enforce", cache, readFile: readFileDependency, log },
        path,
        content,
      );
      if (!verdict.ok) {
        throw new Error(
          `${SPEC_GUARD_VERDICT_TAG} enforce: refusing to write ${path} with ERROR-severity lint findings:\n${formatSpecGuardVerdict(verdict, false)}`,
        );
      }
    });
  });

  const after = await adapter.ctx.tool.hook("execute.after", async (event) => {
    const tool = String(event.tool);
    if (tool !== "read" && tool !== "edit" && tool !== "write") return;
    if (event.status !== "completed") return;
    const mode = await resolveMode(adapter, String(event.sessionID));
    if (mode === "off") return;
    await guard("output annotation", async () => {
      const path = specGuardPathFromArgs(event.input);
      if (!path || !isSpecGuardTargetPath(path)) return;
      const { verdict, cached } = await lintSpecGuardFile(
        { mode: () => mode, cache, readFile: readFileDependency, log },
        path,
      );

      const result = event.result as { content?: string | Array<{ type: string; text?: string }> };
      const appendAnnotation = (annotation: string, leading = false) => {
        if (typeof result.content === "string") {
          result.content = leading
            ? `${annotation}\n\n${result.content}`
            : `${result.content}\n\n${annotation}`;
        } else if (Array.isArray(result.content)) {
          result.content = leading
            ? [{ type: "text", text: annotation }, ...result.content]
            : [...result.content, { type: "text", text: annotation }];
        } else {
          result.content = annotation;
        }
      };

      if (tool === "read") {
        appendAnnotation(formatSpecGuardVerdict(verdict, cached));
        return;
      }
      if (mode === "enforce" && tool === "edit" && !verdict.ok) {
        appendAnnotation(
          `${SPEC_GUARD_VERDICT_TAG} enforce: ${path} now contains ERROR-severity lint findings; fix them before continuing\n\n${formatSpecGuardVerdict(verdict, cached)}`,
          true,
        );
        return;
      }
      appendAnnotation(formatSpecGuardVerdict(verdict, cached));
    });
  });

  return async () => {
    await before.dispose();
    await after.dispose();
  };
}
// END_BLOCK_SETUP_SPEC_GUARD_V2
