// FILE: src/plugins/tool-history-compaction/index.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the native tool-history-compaction plugin: acquire the shared snapshot runtime, register the native session context hook unconditionally, and rewrite only the in-memory provider-context copy the model is about to receive, gated per bound family by its immutable captured policy.
//   SCOPE: Native Plugin.define entry, per-family policy resolution from the captured vvoc config (unknown policy compacts nothing), per-request native message-time correlation through the authenticated client's session context, and lifecycle cleanup. No V1 fake SDK, no startup-global toggle, no cross-request time cache (a running turn's stored timestamps can still change), and no mutation of stored session messages or user inputs.
//   DEPENDS: [@opencode/plugin, src/lib/plugin-toggle-config.ts, src/runtime/context.ts, src/runtime/types.ts, src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/transform.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION, M-NATIVE-RUNTIME, V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ToolHistoryCompactionPolicy - Resolved per-family compaction policy.
//   ToolHistoryCompactionDiagnostic - Bounded credential-safe diagnostic event.
//   ToolHistoryCompactionPluginOptions - Optional injectable runtime acquisition and diagnostic sink for tests.
//   createToolHistoryCompactionPlugin - Native plugin factory; the default export acquires the real shared runtime.
//   ToolHistoryCompactionPlugin - Default production native tool-history-compaction plugin object.
//   default - Default export alias of ToolHistoryCompactionPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 attempt 2 - Correlation is re-read per request instead of cached, and logical grouping over the pinned split multi-call representation lives in transform.ts.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilyCapture } from "../../runtime/types.js";
import {
  parseToolHistoryCompactionEntry,
  type ResolvedToolHistoryCompactionEntry,
} from "./config.js";
import { compactMessages } from "./transform.js";

const MAX_LOG_CHARS = 500;

/** Resolved per-family compaction policy. */
export type ToolHistoryCompactionPolicy =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly config: ResolvedToolHistoryCompactionEntry["config"] };

/** Bounded credential-safe diagnostic event. */
export interface ToolHistoryCompactionDiagnostic {
  readonly level: "warn" | "info";
  readonly message: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface ToolHistoryCompactionPluginOptions {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
  /** Test-only diagnostic sink override; defaults to the console sink. */
  log?: (event: ToolHistoryCompactionDiagnostic) => void;
}

// START_BLOCK_LOG
/** Bounded credential-safe console diagnostic. */
function createConsoleLog(): (event: ToolHistoryCompactionDiagnostic) => void {
  return (event) => {
    const line = `[tool-history-compaction][${event.level}] ${event.message}`;
    console.error(line.length > MAX_LOG_CHARS ? `${line.slice(0, MAX_LOG_CHARS)}…` : line);
  };
}
// END_BLOCK_LOG

// START_BLOCK_POLICY
/**
 * Resolve the bound-family compaction policy; never falls back to current or
 * default config. An unbound but staged family is reconciled through native
 * acceptance before a second read. Unknown policy compacts nothing.
 */
async function resolvePolicy(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
  log: (event: ToolHistoryCompactionDiagnostic) => void,
): Promise<ToolHistoryCompactionPolicy | undefined> {
  const read = async (): Promise<FamilyCapture | undefined> => {
    try {
      return await runtime.snapshots.configFor(sessionID);
    } catch {
      return undefined;
    }
  };
  let capture = await read();
  if (capture === undefined) {
    try {
      await runtime.snapshots.accept({ sessionID });
    } catch {
      // fall through to the second read; absence is unknown policy below
    }
    capture = await read();
  }
  if (capture === undefined) return undefined;
  if (!isVvocPluginEnabled(capture.vvoc, "tool-history-compaction")) return { enabled: false };
  try {
    const entry = parseToolHistoryCompactionEntry(
      capture.vvoc.plugins?.["tool-history-compaction"],
    );
    return { enabled: entry.enabled, config: entry.config };
  } catch {
    // A corrupt captured entry is unknown policy, never a silent rewrite with defaults.
    log({ level: "warn", message: "captured compaction config could not be resolved; skipping" });
    return undefined;
  }
}
// END_BLOCK_POLICY

// START_BLOCK_TIMES
/**
 * Read an epoch-millisecond time from a native session message timestamp. The
 * host's generated client type declares `time.created` as a number, while the
 * decoded Effect `DateTime.Utc` value also exposes epoch milliseconds; accept
 * both so correlation survives either representation.
 */
function readTimeValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null) {
    const record = value as { epochMilliseconds?: unknown; epochMillis?: unknown };
    if (typeof record.epochMilliseconds === "number" && Number.isFinite(record.epochMilliseconds)) {
      return record.epochMilliseconds;
    }
    if (typeof record.epochMillis === "number" && Number.isFinite(record.epochMillis)) {
      return record.epochMillis;
    }
  }
  return undefined;
}

function readRecencyTime(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const time = (message as { time?: unknown }).time;
  if (typeof time !== "object" || time === null) return undefined;
  const record = time as { completed?: unknown; created?: unknown; streamed?: unknown };
  for (const value of [record.completed, record.created, record.streamed]) {
    const parsed = readTimeValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Correlate native stored-message recency by message id. The dispatched AI
 * context carries no time, so the authenticated client's `session.context`
 * (the same post-compaction history the request was built from) supplies the
 * trustworthy id-to-time mapping. The read is fresh on every request because a
 * running turn's stored timestamps can still change. Failures degrade to no
 * correlation, which falls back to deterministic array-position ordering.
 */
async function fetchMessageTimes(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  try {
    const client = await runtime.client();
    const messages = await client.session.context({ sessionID });
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      const id = (message as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const time = readRecencyTime(message);
      if (time !== undefined) times.set(id, time);
    }
  } catch {
    // Unavailable correlation degrades to no times; callers use array order.
  }
  return times;
}
// END_BLOCK_TIMES

// START_BLOCK_PLUGIN_ENTRY
/** Native plugin factory; the default export acquires the real shared runtime. */
export function createToolHistoryCompactionPlugin(
  options: ToolHistoryCompactionPluginOptions = {},
): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.tool-history-compaction",
    setup: async (ctx) => {
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
      const log = options.log ?? createConsoleLog();

      const registration = await ctx.session.hook("context", async (event) => {
        try {
          const policy = await resolvePolicy(runtime, String(event.sessionID), log);
          if (policy === undefined || !policy.enabled) return;
          const messages = event.messages;
          if (!Array.isArray(messages) || messages.length === 0) return;
          const sessionID = String(event.sessionID);
          const times = await fetchMessageTimes(runtime, sessionID);
          compactMessages(messages, policy.config, times);
        } catch (error) {
          // Compaction must never fail a request; report a bounded diagnostic only.
          log({
            level: "warn",
            message: "compaction pass failed",
            extra: { error: error instanceof Error ? error.name : typeof error },
          });
        }
      });

      return async () => {
        await registration.dispose();
        await runtime.release();
      };
    },
  });
}

export const ToolHistoryCompactionPlugin: Plugin.Plugin = createToolHistoryCompactionPlugin();
export default ToolHistoryCompactionPlugin;
// END_BLOCK_PLUGIN_ENTRY
