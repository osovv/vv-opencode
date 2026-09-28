// FILE: src/plugins/secrets-redaction/index.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Native OpenCode 2.0.18 plugin that redacts secrets from provider-bound request hooks (context/generate/compaction/title) and restores them in native tool inputs and streamed provider responses, strictly under the immutable policy capture bound to the session's family.
//   SCOPE: Native Plugin.define entry, strict per-family policy resolution through snapshot accept reconciliation BEFORE provider dispatch (unknown policy blocks provider-bound work; only an explicit captured disabled policy is a no-redaction path), family-scoped placeholder state with TTL/max bounds and cleanup, redaction of system text and message text/reasoning/tool-call/tool-result/metadata fields, native tool input restoration, SSE/non-SSE http.response restoration, experimental.ws.receive frame restoration, and credential-safe diagnostics. It never mutates the persisted user prompt, never falls back to the current or default config, and never formats a fabricated host logger.
//   DEPENDS: [@opencode/plugin, src/runtime/context.ts, src/runtime/types.ts, src/lib/plugin-toggle-config.ts, src/lib/vvoc-config.ts, src/plugins/secrets-redaction/config.ts, src/plugins/secrets-redaction/patterns.ts, src/plugins/secrets-redaction/engine.ts, src/plugins/secrets-redaction/deep.ts, src/plugins/secrets-redaction/session.ts, src/plugins/secrets-redaction/stream.ts]
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, M-NATIVE-RUNTIME, V-M-PLUGIN-SECRETS-REDACTION, DF-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLACEHOLDER_PREFIX - Placeholder namespace prefix for redacted secrets.
//   SecretsPolicyResolution - Family-scoped policy key plus normalized secrets config.
//   SecretsPolicyUnboundError - No trustworthy family policy exists, so provider-bound work is blocked.
//   SecretsRedactionHandlers - Native hook handlers for context/generate/compaction/title/tool/http/ws.
//   SecretsRedactionRegistration - Handlers plus cleanup-owning dispose.
//   SecretsRedactionDependencies - Injectable strict policy resolver and diagnostic sink.
//   createSecretsRedactionRegistration - Build per-family state plus native hook handlers.
//   SecretsRedactionPluginOptions - Optional injectable runtime acquisition for tests.
//   createSecretsRedactionPlugin - Native plugin factory; the default export acquires the real shared runtime.
//   SecretsRedactionPlugin - Default production native secrets-redaction plugin object.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 attempt 2 - Removed the persisted-prompt mutation, resolved policy strictly through accept reconciliation before provider dispatch, blocked provider-bound work on unknown policy, keyed state by family id (no current/default fallback), and restored streamed SSE/non-SSE bodies via content-type-aware transforms.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilyCapture } from "../../runtime/types.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { resolveSecretsRedactionRuntimeConfig, type SecretsRedactionConfig } from "./config.js";
import { buildPatternSet, type PatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { redactDeep, restoreDeep } from "./deep.js";
import { PlaceholderSession } from "./session.js";
import {
  createFrameRestoreState,
  createResponseByteTransform,
  restoreProviderFrame,
  type FrameRestoreState,
} from "./stream.js";

export const PLACEHOLDER_PREFIX = "__VVOC_SECRET_";

/** Family-scoped policy key plus normalized secrets config. */
export interface SecretsPolicyResolution {
  readonly key: string;
  readonly config: SecretsRedactionConfig;
}

/** A family whose captured policy disables secrets-redaction: the only legitimate no-redaction path. */
export type SecretsPolicyDecision = SecretsPolicyResolution | "disabled" | undefined;

/** No trustworthy family policy exists, so provider-bound work is blocked. */
export class SecretsPolicyUnboundError extends Error {
  readonly code = "SECRETS_POLICY_UNBOUND";

  constructor(sessionID: string) {
    super(
      `SECRETS_POLICY_UNBOUND: no immutable secrets-redaction policy is bound to session ${sessionID}; refusing to dispatch an unredacted provider request.`,
    );
    this.name = "SecretsPolicyUnboundError";
  }
}

// START_BLOCK_NATIVE_EVENTS
interface NativeSystemPart {
  type?: string;
  text?: string;
  metadata?: unknown;
}

interface NativeContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  result?: { type?: string; value?: unknown };
  metadata?: unknown;
}

interface NativeMessage {
  role?: string;
  content?: NativeContentPart[];
}

export interface SecretsContextEvent {
  sessionID: string;
  system?: NativeSystemPart[] | undefined;
  messages?: NativeMessage[] | undefined;
}

export interface SecretsToolBeforeEvent {
  readonly sessionID: string;
  readonly tool: string;
  input: unknown;
}

export interface SecretsHttpResponseEvent {
  readonly sessionID: string;
  response: Response;
}

export interface SecretsWsReceiveEvent {
  readonly sessionID: string;
  frame: string;
}
// END_BLOCK_NATIVE_EVENTS

/** Native hook handlers for context/generate/compaction/title/tool/http/ws. */
export interface SecretsRedactionHandlers {
  context(event: SecretsContextEvent): Promise<void>;
  generate(event: SecretsContextEvent): Promise<void>;
  compaction(event: SecretsContextEvent): Promise<void>;
  title(event: SecretsContextEvent): Promise<void>;
  httpResponse(event: SecretsHttpResponseEvent): Promise<void>;
  wsReceive(event: SecretsWsReceiveEvent): Promise<void>;
  toolBefore(event: SecretsToolBeforeEvent): Promise<void>;
}

/** Handlers plus cleanup-owning dispose. */
export interface SecretsRedactionRegistration {
  readonly handlers: SecretsRedactionHandlers;
  dispose(): void;
}

/** Injectable strict policy resolver and diagnostic sink. */
export interface SecretsRedactionDependencies {
  configFor(sessionID: string): Promise<SecretsPolicyDecision>;
  log(event: { readonly level: "info" | "warn" | "debug"; readonly message: string }): void;
}

interface FamilyState {
  readonly session: PlaceholderSession;
  readonly patternSet: PatternSet;
  readonly ttlMs: number;
  readonly debug: boolean;
}

// START_BLOCK_STATE
function buildState(config: SecretsRedactionConfig): FamilyState {
  return {
    session: new PlaceholderSession({
      prefix: PLACEHOLDER_PREFIX,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
      secret: config.secret,
    }),
    patternSet: buildPatternSet(config.patterns),
    ttlMs: config.ttlMs,
    debug: config.debug,
  };
}
// END_BLOCK_STATE

// START_BLOCK_REDACTION
function redactContentPart(part: NativeContentPart, state: FamilyState): void {
  if (typeof part.type !== "string") return;
  switch (part.type) {
    case "text":
    case "reasoning": {
      if (typeof part.text === "string") {
        part.text = redactText(part.text, state.patternSet, state.session).text;
      }
      if (part.metadata !== undefined) {
        part.metadata = redactDeep(part.metadata, state.patternSet, state.session);
      }
      return;
    }
    case "tool-call": {
      if (part.input !== undefined) {
        part.input = redactDeep(part.input, state.patternSet, state.session);
      }
      if (part.metadata !== undefined) {
        part.metadata = redactDeep(part.metadata, state.patternSet, state.session);
      }
      return;
    }
    case "tool-result": {
      if (part.result !== undefined && part.result !== null && typeof part.result === "object") {
        const result = part.result as { type?: string; value?: unknown };
        result.value = redactDeep(result.value, state.patternSet, state.session);
      }
      if (part.metadata !== undefined) {
        part.metadata = redactDeep(part.metadata, state.patternSet, state.session);
      }
      return;
    }
    case "compaction": {
      if (typeof part.text === "string") {
        part.text = redactText(part.text, state.patternSet, state.session).text;
      }
      return;
    }
    default:
      // Media, effort and unknown/opaque parts are preserved unchanged.
      return;
  }
}

function redactContextRequest(event: SecretsContextEvent, state: FamilyState): void {
  if (Array.isArray(event.system)) {
    for (const part of event.system) {
      if (part !== null && typeof part === "object" && typeof part.text === "string") {
        part.text = redactText(part.text, state.patternSet, state.session).text;
      }
    }
  }
  if (Array.isArray(event.messages)) {
    for (const message of event.messages) {
      if (message === null || typeof message !== "object" || !Array.isArray(message.content))
        continue;
      for (const part of message.content) {
        if (part !== null && typeof part === "object") redactContentPart(part, state);
      }
    }
  }
}
// END_BLOCK_REDACTION

// START_BLOCK_HANDLERS
function createHandlers(deps: SecretsRedactionDependencies): {
  registration: SecretsRedactionRegistration;
} {
  const states = new Map<string, FamilyState>();
  const frameState = new Map<string, FrameRestoreState>();
  const intervals: ReturnType<typeof setInterval>[] = [];

  const stateFromResolution = (resolved: SecretsPolicyResolution): FamilyState => {
    let state = states.get(resolved.key);
    if (state === undefined) {
      state = buildState(resolved.config);
      states.set(resolved.key, state);
      if (resolved.config.ttlMs > 0) {
        const interval = setInterval(
          () => {
            for (const candidate of states.values()) candidate.session.cleanup(Date.now());
          },
          Math.min(resolved.config.ttlMs, 60_000),
        );
        interval.unref?.();
        intervals.push(interval);
      }
    }
    return state;
  };

  const requireState = async (sessionID: string): Promise<FamilyState | undefined> => {
    const resolved = await deps.configFor(sessionID);
    if (resolved === "disabled") return undefined;
    if (resolved === undefined) throw new SecretsPolicyUnboundError(sessionID);
    return stateFromResolution(resolved);
  };

  const redactProviderEvent = async (event: SecretsContextEvent): Promise<void> => {
    const state = await requireState(event.sessionID);
    if (state === undefined) return;
    redactContextRequest(event, state);
  };

  const handlers: SecretsRedactionHandlers = {
    context: redactProviderEvent,
    generate: redactProviderEvent,
    compaction: redactProviderEvent,
    title: redactProviderEvent,
    async httpResponse(event) {
      const state = await requireState(event.sessionID);
      if (state === undefined) return;
      const body = event.response.body;
      if (body === null) return;
      const contentType = event.response.headers.get("content-type") ?? "";
      const transformed = body.pipeThrough(createResponseByteTransform(state.session, contentType));
      event.response = new Response(transformed, {
        status: event.response.status,
        statusText: event.response.statusText,
        headers: event.response.headers,
      });
    },
    async wsReceive(event) {
      // A missing policy never blocks socket frames (they may not be provider text),
      // but no restoration happens without a trustworthy family map.
      const resolved = await deps.configFor(event.sessionID);
      if (resolved === "disabled" || resolved === undefined) return;
      const state = stateFromResolution(resolved);
      let frames = frameState.get(resolved.key);
      if (frames === undefined) {
        frames = createFrameRestoreState(state.session);
        frameState.set(resolved.key, frames);
      }
      event.frame = restoreProviderFrame(state.session, event.frame, frames);
    },
    async toolBefore(event) {
      // Restoration requires a bound family map; without one there is nothing to
      // restore and no map may be borrowed from another family.
      const resolved = await deps.configFor(event.sessionID);
      if (resolved === "disabled" || resolved === undefined) return;
      if (event.input === undefined) return;
      const state = stateFromResolution(resolved);
      event.input = restoreDeep(event.input, state.session);
    },
  };

  return {
    registration: {
      handlers,
      dispose() {
        for (const interval of intervals) clearInterval(interval);
        intervals.length = 0;
        states.clear();
        frameState.clear();
      },
    },
  };
}
// END_BLOCK_HANDLERS

// START_BLOCK_PLUGIN_ENTRY
/** Resolve the bound-family secrets policy; never falls back to current/default config. */
async function resolvePolicy(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<SecretsPolicyDecision> {
  const read = async (): Promise<FamilyCapture | undefined> => {
    try {
      return await runtime.snapshots.configFor(sessionID);
    } catch {
      return undefined;
    }
  };
  let capture = await read();
  if (capture === undefined) {
    // A first accepted workload may be persisted but not yet published; reconcile
    // through the native acceptance service before deciding, then read again.
    try {
      await runtime.snapshots.accept({ sessionID });
    } catch {
      // fall through to the second read; absence blocks below
    }
    capture = await read();
  }
  if (capture === undefined) return undefined;
  if (!isVvocPluginEnabled(capture.vvoc, "secrets-redaction")) return "disabled";
  const resolved = resolveSecretsRedactionRuntimeConfig({
    config: capture.vvoc,
    source: { kind: "project" },
    warnings: [],
  });
  return { key: capture.familyId, config: resolved.config };
}

function createConsoleLog(): SecretsRedactionDependencies["log"] {
  return (event) => {
    if (event.level === "warn" || process.env.DEBUG?.includes("vvoc")) {
      console.error(`[secrets-redaction][${event.level}] ${event.message.slice(0, 1000)}`);
    }
  };
}

/** Build per-family state plus native hook handlers with injectable dependencies. */
export function createSecretsRedactionRegistration(
  deps: SecretsRedactionDependencies,
): SecretsRedactionRegistration {
  return createHandlers(deps).registration;
}

export interface SecretsRedactionPluginOptions {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
  /** Test-only diagnostic sink override. */
  log?: SecretsRedactionDependencies["log"];
}

/** Native secrets-redaction plugin factory; the default export uses the real shared runtime. */
export function createSecretsRedactionPlugin(
  options: SecretsRedactionPluginOptions = {},
): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.secrets-redaction",
    setup: async (ctx) => {
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
      const log = options.log ?? createConsoleLog();
      const registration = createSecretsRedactionRegistration({
        configFor: (sessionID) => resolvePolicy(runtime, sessionID),
        log,
      });
      const h = registration.handlers;
      const hooks = await Promise.all([
        ctx.session.hook("context", (event) => h.context(event as never)),
        ctx.session.hook("generate", (event) => h.generate(event as never)),
        ctx.session.hook("compaction", (event) => h.compaction(event as never)),
        ctx.session.hook("title", (event) => h.title(event as never)),
        ctx.session.hook("http.response", (event) => h.httpResponse(event as never)),
        ctx.session.hook("experimental.ws.receive", (event) => h.wsReceive(event as never)),
        ctx.tool.hook("execute.before", (event) => h.toolBefore(event as never)),
      ]);
      return async () => {
        for (const hook of hooks) await hook.dispose();
        registration.dispose();
        await runtime.release();
      };
    },
  });
}

export const SecretsRedactionPlugin: Plugin.Plugin = createSecretsRedactionPlugin();
export default SecretsRedactionPlugin;
// END_BLOCK_PLUGIN_ENTRY
