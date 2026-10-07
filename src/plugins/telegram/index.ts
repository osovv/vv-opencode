// FILE: src/plugins/telegram/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Assemble the TelegramBridgePlugin native server plugin: resolve the telegram section and toggle, run exactly one Telegram gateway per process behind an app-identity singleton, wire topology, delivery, session bridge, interactions, commands, and the polling gateway over the plugin context and the shared native runtime, and tear everything down in reverse on cleanup.
//   SCOPE: Injectable config loader, environment, transport factory, and runtime acquisition for deterministic tests; structural native context and client seams with unknown-typed inputs decoded at checked boundaries; value-free disabled diagnostics; owner-scoped callback routing; a supervised background bootstrap (client acquisition, resync, General creation, pending-permission resurfacing, command registration, polling) with bounded backoff retries that never blocks plugin setup, because awaiting the native client during setup deadlocks server boot; partial-setup rollback through the returned cleanup.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/runtime/coordination.ts, src/runtime/context.ts, src/plugins/telegram/config.ts, src/plugins/telegram/bot-api.ts, src/plugins/telegram/topology.ts, src/plugins/telegram/delivery.ts, src/plugins/telegram/sessions.ts, src/plugins/telegram/commands.ts, src/plugins/telegram/gateway.ts, src/plugins/telegram/log.ts]
//   LINKS: [M-PLUGIN-TELEGRAM-BRIDGE, M-TELEGRAM-GATEWAY, M-TELEGRAM-TOPICS, M-TELEGRAM-DELIVERY, M-TELEGRAM-BOT-API, M-TELEGRAM-CONFIG, V-M-PLUGIN-TELEGRAM-BRIDGE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeClientLike - Structural full-client seam with unknown-typed inputs.
//   TelegramBridgeDependencies - Injectable config, environment, transport, and runtime seams.
//   toTelegramStore - Adapt the plugin storage domain to the durable store boundary.
//   nativeReadsAdapter - Adapt the full client to session reads.
//   nativeActionsAdapter - Adapt the plugin context session domain to prompt, interrupt, and model switch.
//   nativeEventsAdapter - Adapt the plugin context event domain to the bridge stream.
//   nativeProjectsAdapter - Adapt the context and client to project listing and session creation.
//   nativeModelsAdapter - Adapt the plugin context model domain to model listing.
//   nativeHistoryAdapter - Adapt the full client to message history, revert, and fork.
//   nativePermissionsAdapter - Adapt the full client to permission list and reply.
//   nativeQuestionsAdapter - Adapt the full client session forms to question replies.
//   createTelegramBridgePlugin - Build the native plugin with injectable dependencies.
//   TelegramBridgePlugin - Default production plugin.
//   default - Default export alias.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-006 - Wired the maxTopics rotation cap and the bounded file log into the plugin assembly.]
//   PREVIOUS: [DIRECT-FIX - The form adapter forwards the native answer record unchanged and the event routing follows the real V2 vocabulary.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { loadEffectiveVvocConfig } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { nativeObjectId } from "../../runtime/coordination.js";
import { acquireNativeSnapshotRuntime } from "../../runtime/context.js";
import { createTelegramTransport } from "./bot-api.js";
import type { TelegramTransport } from "./bot-api.js";
import { resolveTelegramConfig, telegramBotFingerprint } from "./config.js";
import { TelegramCommands, TelegramInteractions } from "./commands.js";
import { TelegramDelivery } from "./delivery.js";
import { TelegramGateway } from "./gateway.js";
import { createTelegramFileLog } from "./log.js";
import { SessionBridge, TELEGRAM_PROMPT_SOURCE } from "./sessions.js";
import type { NativeEventStream, NativeSessionActions, NativeSessionReads } from "./sessions.js";
import { TelegramTopology, type TelegramStore } from "./topology.js";
import type {
  NativeHistorySurface,
  NativeModelSurface,
  NativeProjectSurface,
  NativeQuestionSurface,
  NativePermissionSurface,
} from "./commands.js";

/** Structural plugin storage seam mirrored to the durable store boundary. */
interface NativeStorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: {
    prefix: string;
  }): Promise<{ entries: readonly { key: string; value: unknown }[] }>;
}

/** Structural plugin context seam the assembly consumes. */
interface NativePluginContext {
  readonly app?: object | undefined;
  readonly location: { readonly directory: string };
  readonly storage: NativeStorageLike;
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
  readonly session: {
    prompt(input: unknown): Promise<unknown>;
    interrupt(input: unknown): Promise<void>;
    switchModel(input: unknown): Promise<void>;
    create(input?: unknown): Promise<unknown>;
  };
  readonly model: { list(input?: unknown): Promise<unknown> };
}

/** Structural shared-runtime seam exposing the full client. */
interface NativeRuntimeLike {
  client(): Promise<NativeClientLike>;
  release(): Promise<void>;
}

/** Structural full-client seam with unknown-typed inputs decoded at checked boundaries. */
export interface NativeClientLike {
  readonly session: {
    list(input?: unknown): Promise<unknown>;
    active(): Promise<unknown>;
    fork(input: unknown): Promise<unknown>;
    readonly revert?: {
      stage(input: unknown): Promise<unknown>;
      commit(input: unknown): Promise<unknown>;
    };
    readonly form: {
      list(input: unknown): Promise<unknown>;
      reply(input: unknown): Promise<void>;
    };
  };
  readonly message: { list(input: unknown): Promise<unknown> };
  readonly project: { list(): Promise<unknown> };
  readonly permission: {
    list(input: unknown): Promise<unknown>;
    reply(input: unknown): Promise<void>;
  };
}

/** Injectable config, environment, transport, and runtime seams. */
export type TelegramBridgeDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadConfig?: (directory: string) => Promise<{ plugins?: unknown; telegram?: unknown }>;
  readonly createTransport?: (options: {
    readonly token: string;
    readonly chatId: number;
    readonly apiRoot?: string | undefined;
    readonly proxyUrl?: string | undefined;
  }) => TelegramTransport;
  readonly acquireRuntime?: (ctx: NativePluginContext) => Promise<NativeRuntimeLike>;
  readonly log?: (level: "info" | "warn", message: string) => void;
};

// START_BLOCK_ADAPTERS
/** Adapt the plugin storage domain to the durable store boundary. */
export function toTelegramStore(storage: NativeStorageLike): TelegramStore {
  return {
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, value),
    remove: (key) => storage.remove(key),
    scan: async (prefix) => (await storage.scan({ prefix })).entries,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One decoded native session summary. */
interface DecodedSession {
  readonly id: string;
  readonly title: string | undefined;
  readonly timeCreatedMs: number;
  readonly timeUpdatedMs: number;
  readonly parentID: string | undefined;
}

/** Adapt the full client to session reads. */
export function nativeReadsAdapter(client: NativeClientLike): NativeSessionReads {
  return {
    listSessions: async () => {
      const response = asRecord(await client.session.list({ limit: "100", order: "desc" }));
      const data = Array.isArray(response?.data) ? response.data : [];
      return data.flatMap((entry): DecodedSession[] => {
        const record = asRecord(entry);
        if (record === undefined) return [];
        const id = readString(record.id);
        if (id === undefined) return [];
        const time = asRecord(record.time);
        return [
          {
            id,
            title: readString(record.title),
            timeCreatedMs: typeof time?.created === "number" ? time.created : 0,
            timeUpdatedMs: typeof time?.updated === "number" ? time.updated : 0,
            parentID: readString(record.parentID),
          },
        ];
      });
    },
    activeSessionIds: async () => {
      const active = asRecord(await client.session.active());
      if (active === undefined) return [];
      return Object.entries(active)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key]) => key)
        .filter((key) => key.startsWith("ses_"));
    },
  };
}

/** Adapt the plugin context session domain to prompt, interrupt, and model switch. */
export function nativeActionsAdapter(ctx: NativePluginContext): NativeSessionActions {
  return {
    prompt: async (input) => {
      const admitted = asRecord(
        await ctx.session.prompt({
          sessionID: input.sessionID,
          text: input.text,
          delivery: input.delivery,
          metadata: { source: TELEGRAM_PROMPT_SOURCE },
          ...(input.files === undefined || input.files.length === 0
            ? {}
            : {
                files: input.files.map((file) => ({
                  uri: `data:${file.mimeType};base64,${file.base64}`,
                  name: file.filename,
                })),
              }),
        }),
      );
      const messageID = readString(asRecord(admitted?.info)?.id) ?? "msg_unknown";
      return { messageID };
    },
    interrupt: (input) => ctx.session.interrupt({ sessionID: input.sessionID, continue: false }),
    switchModel: (input) =>
      ctx.session.switchModel({ sessionID: input.sessionID, model: input.model }),
  };
}

/** Adapt the plugin context event domain to the bridge stream. */
export function nativeEventsAdapter(ctx: NativePluginContext): NativeEventStream {
  return {
    subscribe: (signal) =>
      ctx.event.subscribe(signal === undefined ? undefined : { signal }) as AsyncIterable<
        import("./sessions.js").NativeEventEnvelope
      >,
  };
}

/** Adapt the context and client to project listing and session creation. */
export function nativeProjectsAdapter(
  ctx: NativePluginContext,
  client: NativeClientLike,
): NativeProjectSurface {
  return {
    listProjects: async () => {
      const response = asRecord(await client.project.list());
      const data = Array.isArray(response?.data) ? response.data : [];
      return data.flatMap((entry) => {
        const record = asRecord(entry);
        const id = readString(record?.id);
        const directory = readString(record?.directory);
        if (id === undefined || directory === undefined) return [];
        return [{ id, directory }];
      });
    },
    createSession: async (input) => {
      const created = asRecord(
        await ctx.session.create({ location: { directory: input.directory } }),
      );
      return { id: readString(created?.id) ?? "ses_unknown" };
    },
  };
}

/** Adapt the plugin context model domain to model listing. */
export function nativeModelsAdapter(ctx: NativePluginContext): NativeModelSurface {
  return {
    listModels: async () => {
      const response = asRecord(await ctx.model.list());
      const data = Array.isArray(response?.data) ? response.data : [];
      return data.flatMap((entry) => {
        const record = asRecord(entry);
        const providerID = readString(record?.providerID);
        const modelID = readString(record?.id);
        if (providerID === undefined || modelID === undefined) return [];
        return [{ providerID, modelID }];
      });
    },
  };
}

/** Adapt the full client to message history, revert, and fork. */
export function nativeHistoryAdapter(client: NativeClientLike): NativeHistorySurface {
  return {
    listUserMessages: async (input) => {
      const response = asRecord(await client.message.list({ sessionID: input.sessionID }));
      const data = Array.isArray(response?.data) ? response.data : [];
      const messages: { messageID: string; text: string }[] = [];
      for (const entry of data) {
        const record = asRecord(entry);
        const info = asRecord(record?.info);
        if (info?.role !== "user") continue;
        const id = readString(info.id);
        if (id === undefined) continue;
        const parts = Array.isArray(record?.parts) ? record.parts : [];
        const text = parts
          .map((part) => readString(asRecord(part)?.text) ?? "")
          .join("\n")
          .trim();
        messages.push({ messageID: id, text });
      }
      return messages;
    },
    revert: async (input) => {
      await client.session.revert?.stage({ sessionID: input.sessionID, before: input.messageID });
      await client.session.revert?.commit({ sessionID: input.sessionID });
    },
    fork: async (input) => {
      const forked = asRecord(
        await client.session.fork({ sessionID: input.sessionID, before: input.messageID }),
      );
      return { id: readString(forked?.id) ?? "ses_unknown" };
    },
  };
}

/** Adapt the full client to permission list and reply. */
export function nativePermissionsAdapter(client: NativeClientLike): NativePermissionSurface {
  return {
    listPending: async (input) => {
      const response = await client.permission.list({ sessionID: input.sessionID });
      const data = Array.isArray(response) ? response : (asRecord(response)?.data ?? []);
      return (data as unknown[]).flatMap((entry) => {
        const record = asRecord(entry);
        const requestID = readString(record?.id) ?? readString(record?.requestID);
        if (requestID === undefined) return [];
        const action = asRecord(record?.action);
        return [
          { requestID, summary: readString(record?.summary) ?? readString(action?.resource) },
        ];
      });
    },
    reply: (input) => client.permission.reply(input),
  };
}

/** Adapt the full client session forms to question replies. */
export function nativeQuestionsAdapter(client: NativeClientLike): NativeQuestionSurface {
  return {
    reply: (input) =>
      client.session.form.reply({
        sessionID: input.sessionID,
        formID: input.questionID,
        answers: input.answers,
      }),
  };
}
// END_BLOCK_ADAPTERS

interface SharedGateway {
  refs: number;
  stop(): Promise<void>;
}

const sharedGateways = new Map<number, SharedGateway>();

/** Build the native Telegram bridge plugin with injectable dependencies. */
export function createTelegramBridgePlugin(
  dependencies: TelegramBridgeDependencies = {},
): Plugin.Plugin {
  const env = dependencies.env ?? process.env;
  const loadConfig =
    dependencies.loadConfig ??
    (async (directory: string) => (await loadEffectiveVvocConfig({ cwd: directory })).config);
  const createTransport = dependencies.createTransport ?? createTelegramTransport;
  const log =
    dependencies.log ??
    (() => {
      const fileLog = createTelegramFileLog();
      return (level: "info" | "warn", message: string) => {
        console.log(`[vvoc.telegram][${level}] ${message}`);
        fileLog(level, message);
      };
    })();
  const acquireRuntime =
    dependencies.acquireRuntime ??
    (async (ctx: NativePluginContext) => {
      const runtime = await acquireNativeSnapshotRuntime(ctx as never);
      return {
        client: () => runtime.client() as Promise<NativeClientLike>,
        release: () => runtime.release(),
      };
    });

  return Plugin.define({
    id: "vvoc.telegram",
    setup: async (rawCtx) => {
      const ctx = rawCtx as unknown as NativePluginContext;
      const config = await loadConfig(ctx.location.directory);
      const toggleEnabled = isVvocPluginEnabled(config as { plugins?: never }, "telegram");
      const resolved = resolveTelegramConfig(
        (config as { telegram?: import("../../lib/vvoc-config.js").VvocTelegramConfig | undefined })
          .telegram,
        env,
      );
      if (!toggleEnabled) {
        log("info", "gateway not started — toggle disabled");
        return () => undefined;
      }
      if (!resolved.enabled) {
        const missing =
          resolved.missingVars.length > 0 ? ` (missing: ${resolved.missingVars.join(", ")})` : "";
        log("info", `gateway not started — ${resolved.reason}${missing}`);
        return () => undefined;
      }

      const appKey = ctx.app === undefined ? -1 : nativeObjectId(ctx.app);
      const existing = sharedGateways.get(appKey);
      if (existing !== undefined) {
        existing.refs += 1;
        return async () => {
          existing.refs -= 1;
          if (existing.refs <= 0 && sharedGateways.get(appKey) === existing) {
            sharedGateways.delete(appKey);
            await existing.stop();
          }
        };
      }

      const ownerChatId = resolved.allowedUserIds[0] ?? 0;
      const transport = createTransport({
        token: resolved.botToken,
        chatId: ownerChatId,
        apiRoot: resolved.apiRoot,
        proxyUrl: resolved.proxyUrl,
      });
      const store = toTelegramStore(ctx.storage);
      const clock = { now: () => Date.now() };

      // START_BLOCK_BACKGROUND_STARTUP
      // Startup never blocks plugin setup: acquiring the native client during
      // setup deadlocks server boot (the server waits for plugin setup while the
      // client waits for the server). The whole bootstrap — client acquisition,
      // topology and delivery initialization, bridge resync, General creation,
      // permission resurfacing, command registration, and polling — runs in a
      // supervised background task with bounded backoff retries; every failure
      // is contained and retried, and cleanup aborts and joins it.
      const abort = new AbortController();
      const aborted = new Promise<void>((resolve) => {
        abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const abortableSleep = async (ms: number): Promise<void> => {
        await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms)), aborted]);
      };
      /** Race one bootstrap await against cleanup so a never-ready client cannot wedge teardown. */
      const raceAborted = <T>(promise: Promise<T>): Promise<T> =>
        Promise.race([
          promise,
          aborted.then(() => {
            throw new Error("startup aborted");
          }),
        ]);
      let started:
        | { gateway: TelegramGateway; bridge: SessionBridge; runtime: NativeRuntimeLike }
        | undefined;

      const done = (async () => {
        const backoffMs = [1_000, 2_000, 5_000, 15_000, 30_000] as const;
        let attempt = 0;
        while (!abort.signal.aborted) {
          let runtime: NativeRuntimeLike | undefined;
          let bridge: SessionBridge | undefined;
          let gateway: TelegramGateway | undefined;
          try {
            runtime = await raceAborted(acquireRuntime(ctx));
            const client = await raceAborted(runtime.client());
            const reads = nativeReadsAdapter(client);
            const topology = new TelegramTopology({
              transport,
              store,
              clock,
              windowMinutes: resolved.activityWindowMinutes,
              maxTopics: resolved.maxTopics,
            });
            const delivery = new TelegramDelivery({
              transport,
              store,
              clock,
              defaults: resolved.settings,
            });
            bridge = new SessionBridge({
              topology,
              delivery,
              reads,
              actions: nativeActionsAdapter(ctx),
              events: nativeEventsAdapter(ctx),
              clock,
              log,
            });
            const interactions = new TelegramInteractions({
              transport,
              topology,
              permissions: nativePermissionsAdapter(client),
              questions: nativeQuestionsAdapter(client),
            });
            bridge.setInteractions(interactions);
            const commands = new TelegramCommands({
              transport,
              topology,
              delivery,
              bridge,
              interactions,
              projects: nativeProjectsAdapter(ctx, client),
              models: nativeModelsAdapter(ctx),
              history: nativeHistoryAdapter(client),
              reads,
              clock,
            });
            gateway = new TelegramGateway({
              transport,
              store,
              ownerIds: resolved.allowedUserIds,
              dispatch: {
                handleMessage: (input) => commands.handleMessage(input),
                handleCallback: async (update) => {
                  const query = update.callback_query;
                  if (query === undefined) return;
                  if (!resolved.allowedUserIds.includes(query.from.id)) {
                    log("warn", "ignored callback from non-owner sender");
                    return;
                  }
                  await commands.handleCallback(query);
                },
              },
              clock,
              log,
            });

            await raceAborted(topology.initialize(telegramBotFingerprint(resolved.botToken)));
            await raceAborted(delivery.initialize());
            await raceAborted(bridge.start());
            await raceAborted(topology.ensureGeneral());
            const sessions = await raceAborted(reads.listSessions());
            await raceAborted(interactions.resurfacePending(sessions.map((session) => session.id)));
            await raceAborted(
              transport.setMyCommands([
                { command: "new", description: "Create a session in a picked project" },
                { command: "sync", description: "Reconcile topics with active sessions" },
                { command: "status", description: "Show active sessions and context usage" },
                { command: "model", description: "Switch the session model" },
                { command: "rename", description: "Rename the current session" },
                { command: "messages", description: "Browse messages, revert or fork" },
                { command: "abort", description: "Abort the current task" },
                { command: "settings", description: "Change delivery settings" },
                { command: "help", description: "Show commands" },
              ]),
            );
            void gateway.start().catch(() => undefined);
            started = { gateway, bridge, runtime };
            log("info", "gateway started");
            await aborted;
            return;
          } catch (error) {
            // Contain a failed bootstrap attempt: stop partials and retry with backoff.
            const name = error instanceof Error ? error.name : typeof error;
            log("warn", `gateway bootstrap attempt ${attempt + 1} failed (${name}); retrying`);
            try {
              if (gateway !== undefined) await gateway.stop();
              if (bridge !== undefined) await bridge.stop();
              if (runtime !== undefined) await runtime.release();
            } catch {
              // Teardown failures during a failed attempt never block the retry.
            }
            if (abort.signal.aborted) return;
            await abortableSleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
            attempt += 1;
          }
        }
      })();
      void done.catch(() => undefined);
      // END_BLOCK_BACKGROUND_STARTUP

      const shared: SharedGateway = {
        refs: 1,
        stop: async () => {
          abort.abort();
          await done.catch(() => undefined);
          if (started !== undefined) {
            await started.gateway.stop();
            await started.bridge.stop();
            await started.runtime.release();
          }
        },
      };
      sharedGateways.set(appKey, shared);

      return async () => {
        shared.refs -= 1;
        if (shared.refs <= 0 && sharedGateways.get(appKey) === shared) {
          sharedGateways.delete(appKey);
          await shared.stop();
        }
      };
    },
  });
}

export const TelegramBridgePlugin: Plugin.Plugin = createTelegramBridgePlugin();
export default TelegramBridgePlugin;
