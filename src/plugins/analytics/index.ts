// FILE: src/plugins/analytics/index.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Collect per-step native token usage telemetry and session metadata into the analytics store with vvoc and native host version attribution, gated per bound family by its immutable captured policy.
//   SCOPE: Native Plugin.define entry, one native event subscription with per-event fail-soft handling, native session/step/renamed decoding, assistant-message attribution from session.step.started, usage records from session.step.ended/session.step.failed and session.compaction.ended/session.compaction.failed, buffered session records emitted once a session's family is bound, and lifecycle cleanup. No V1 event.properties.* shapes, no startup-global toggle, no fabricated zero tokens for unreported usage, and no double counting of internal session.usage.recorded or aggregate session.usage.updated. Disclosed native telemetry gap: session.generate is stateless and emits no durable usage event, so direct generate usage is not recordable from the native stream.
//   DEPENDS: [@opencode/plugin, src/lib/plugin-toggle-config.ts, src/lib/package.ts, src/runtime/context.ts, src/runtime/types.ts, src/lib/analytics/store.ts, src/lib/analytics/types.ts]
//   LINKS: [M-PLUGIN-ANALYTICS, M-ANALYTICS-STORE, M-ANALYTICS-TYPES, M-NATIVE-RUNTIME, V-M-PLUGIN-ANALYTICS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AnalyticsPluginDependencies - Injectable append, clock, runtime acquisition and diagnostic sink for focused tests.
//   createAnalyticsPlugin - Builds a native OpenCode analytics plugin with injectable dependencies.
//   AnalyticsPlugin - Default production native analytics plugin.
//   default - Default export alias of AnalyticsPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 attempt 2 - Added provider-reported usage from native session.step.failed and session.compaction.ended/failed with native event identity and compaction message-id projection; disclosed the stateless generate telemetry gap.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { getPackageVersionSync } from "../../lib/package.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilyCapture } from "../../runtime/types.js";
import { appendAnalyticsRecord } from "../../lib/analytics/store.js";
import type { AnalyticsRecord, UsageRecord, UsageTokens } from "../../lib/analytics/types.js";

type MessageAttribution = {
  providerID: string;
  modelID: string;
  agent: string;
};

type SessionMetadata = {
  title: string;
  version: string | undefined;
  emittedTitle: string | undefined;
};

export type AnalyticsPluginDependencies = {
  /** Append a persisted analytics record; failures are contained per event. */
  append: (record: AnalyticsRecord) => Promise<void>;
  /** Clock used for record timestamps (tests). Defaults to the wall clock. */
  now: () => Date;
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
  /** Bounded credential-safe diagnostic sink. Defaults to the console. */
  log?: (level: "warn", message: string) => void;
};

const DEFAULT_DEPENDENCIES = {
  append: (record: AnalyticsRecord) => appendAnalyticsRecord(record),
  now: () => new Date(),
} as const;

// START_BLOCK_DECODERS
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Native step usage tokens; every reported counter must be a finite number. */
function readTokens(value: unknown): UsageTokens | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const cache = asRecord(record.cache);
  if (cache === undefined) return undefined;
  const input = record.input;
  const output = record.output;
  const reasoning = record.reasoning;
  const cacheRead = cache.read;
  const cacheWrite = cache.write;
  for (const counter of [input, output, reasoning, cacheRead, cacheWrite]) {
    if (typeof counter !== "number" || !Number.isFinite(counter)) return undefined;
  }
  return {
    input: input as number,
    output: output as number,
    reasoning: reasoning as number,
    cacheRead: cacheRead as number,
    cacheWrite: cacheWrite as number,
  };
}
// END_BLOCK_DECODERS

// START_BLOCK_CREATE_ANALYTICS_PLUGIN
/**
 * Builds the native analytics plugin.
 * One event subscription records one usage record per native `session.step.ended`
 * and session records for `session.created`/`session.renamed`. The native event
 * envelope id is the stable usage dedupe identity (`partID`), replacing the V1
 * step-finish part id; `messageID` is the native assistantMessageID. Agent/
 * provider/model attribution comes from `session.step.started` keyed by
 * assistantMessageID. All handler errors are contained per event so one
 * transient append or decode failure never ends later collection.
 */
export function createAnalyticsPlugin(
  dependencies: Partial<AnalyticsPluginDependencies> = {},
): Plugin.Plugin {
  const deps: AnalyticsPluginDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  };
  return Plugin.define({
    id: "vvoc.analytics",
    setup: async (ctx) => {
      const acquire =
        deps.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
      const log =
        deps.log ??
        ((level: "warn", message: string) =>
          console.error(`[vvoc analytics][${level}] ${message}`));
      const vvocVersion = getPackageVersionSync();
      const projectID = ctx.location.project.id;
      const projectDirectory = ctx.location.directory;

      const messageAttribution = new Map<string, MessageAttribution>();
      const sessionMetadata = new Map<string, SessionMetadata>();
      const sessionPolicy = new Map<string, boolean>();

      const resolveEnabled = async (sessionID: string): Promise<boolean | undefined> => {
        const cached = sessionPolicy.get(sessionID);
        if (cached !== undefined) return cached;
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
        const enabled = isVvocPluginEnabled(capture.vvoc, "analytics");
        sessionPolicy.set(sessionID, enabled);
        return enabled;
      };

      const emitSessionRecord = async (sessionID: string): Promise<void> => {
        const meta = sessionMetadata.get(sessionID);
        if (meta === undefined) return;
        const enabled = await resolveEnabled(sessionID);
        if (enabled !== true) return;
        if (meta.emittedTitle === meta.title) return;
        const record = {
          kind: "session",
          ts: deps.now().toISOString(),
          sessionID,
          projectID,
          title: meta.title,
        } satisfies AnalyticsRecord;
        await deps.append(record);
        meta.emittedTitle = meta.title;
      };

      const handleEvent = async (event: {
        type?: unknown;
        id?: unknown;
        data?: unknown;
      }): Promise<void> => {
        const type = readString(event.type);
        const data = asRecord(event.data);
        if (type === undefined || data === undefined) return;
        if (type === "session.created") {
          const sessionID = readString(data.sessionID);
          if (sessionID === undefined) return;
          const title = readString(data.title) ?? "";
          sessionMetadata.set(sessionID, {
            title,
            version: readString(data.version),
            emittedTitle: undefined,
          });
          await emitSessionRecord(sessionID);
          return;
        }
        if (type === "session.renamed") {
          const sessionID = readString(data.sessionID);
          if (sessionID === undefined) return;
          const meta = sessionMetadata.get(sessionID);
          const title = readString(data.title) ?? meta?.title ?? "";
          if (meta === undefined) {
            sessionMetadata.set(sessionID, { title, version: undefined, emittedTitle: undefined });
          } else {
            meta.title = title;
          }
          await emitSessionRecord(sessionID);
          return;
        }
        if (type === "session.step.started") {
          const assistantMessageID = readString(data.assistantMessageID);
          if (assistantMessageID === undefined) return;
          const model = asRecord(data.model);
          messageAttribution.set(assistantMessageID, {
            providerID: readString(model?.providerID) ?? "",
            modelID: readString(model?.id) ?? "",
            agent: readString(data.agent) ?? "",
          });
          return;
        }
        if (type === "session.step.ended" || type === "session.step.failed") {
          await handleStepUsage(event, data);
          return;
        }
        if (type === "session.compaction.ended" || type === "session.compaction.failed") {
          await handleCompactionUsage(event, data);
        }
      };

      const appendUsage = async (input: {
        readonly eventId: string | undefined;
        readonly sessionID: string;
        readonly messageID: string;
        readonly providerID: string;
        readonly modelID: string;
        readonly agent: string;
        readonly tokens: UsageTokens;
        readonly cost: unknown;
      }): Promise<void> => {
        const record: UsageRecord = {
          kind: "usage",
          ts: deps.now().toISOString(),
          projectID,
          projectDirectory,
          sessionID: input.sessionID,
          messageID: input.messageID,
          // Stable native observation identity: the durable event envelope id.
          partID: input.eventId ?? input.messageID,
          providerID: input.providerID,
          modelID: input.modelID,
          agent: input.agent,
          tokens: input.tokens,
          cost: typeof input.cost === "number" && Number.isFinite(input.cost) ? input.cost : 0,
          vvocVersion,
          opencodeVersion: sessionMetadata.get(input.sessionID)?.version ?? "unknown",
        };
        await deps.append(record);
      };

      /**
       * Record one completed or failed native model step. Both boundaries carry
       * provider-reported usage; unreported or malformed usage produces no record
       * rather than a fabricated zero. Attribution comes from the matching
       * `session.step.started` message id.
       */
      const handleStepUsage = async (
        event: { id?: unknown },
        data: Record<string, unknown>,
      ): Promise<void> => {
        const sessionID = readString(data.sessionID);
        const assistantMessageID = readString(data.assistantMessageID);
        if (sessionID === undefined || assistantMessageID === undefined) return;
        const tokens = readTokens(data.tokens);
        if (tokens === undefined) return;
        const enabled = await resolveEnabled(sessionID);
        if (enabled !== true) return;
        await emitSessionRecord(sessionID);

        const attribution = messageAttribution.get(assistantMessageID);
        await appendUsage({
          eventId: readString(event.id),
          sessionID,
          messageID: assistantMessageID,
          providerID: attribution?.providerID ?? "",
          modelID: attribution?.modelID ?? "",
          agent: attribution?.agent ?? "",
          tokens,
          cost: data.cost,
        });
      };

      /**
       * Record one completed or failed native compaction request. The event
       * carries its own reported usage and, on success, the compaction model; the
       * session-message identity is derived the same way the native projector
       * does (`SessionMessage.ID.fromEvent`, core/session/message-updater.ts).
       * Agent is unknown at this boundary and is reported as empty.
       */
      const handleCompactionUsage = async (
        event: { id?: unknown },
        data: Record<string, unknown>,
      ): Promise<void> => {
        const sessionID = readString(data.sessionID);
        if (sessionID === undefined) return;
        const tokens = readTokens(data.tokens);
        if (tokens === undefined) return;
        const enabled = await resolveEnabled(sessionID);
        if (enabled !== true) return;
        await emitSessionRecord(sessionID);

        const eventId = readString(event.id);
        const messageID = eventId === undefined ? "" : eventId.replace(/^evt_/, "msg_");
        const model = asRecord(data.model);
        await appendUsage({
          eventId,
          sessionID,
          messageID,
          providerID: readString(model?.providerID) ?? "",
          modelID: readString(model?.id) ?? "",
          agent: "",
          tokens,
          cost: data.cost,
        });
      };

      const abort = new AbortController();
      const iterator = ctx.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]();
      const pump = (async () => {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            try {
              await handleEvent(next.value as { type?: unknown; id?: unknown; data?: unknown });
            } catch (error) {
              // Contain one event's failure; later events are still observed.
              log(
                "warn",
                `collection error: ${error instanceof Error ? error.name : typeof error}`,
              );
            }
          }
        } catch {
          // A closed or overflowed native stream ends collection; cleanup aborts it.
        }
      })();
      void pump;

      return async () => {
        abort.abort();
        await iterator.return?.();
        await runtime.release();
      };
    },
  });
}

export const AnalyticsPlugin: Plugin.Plugin = createAnalyticsPlugin();
export default AnalyticsPlugin;
// END_BLOCK_CREATE_ANALYTICS_PLUGIN
