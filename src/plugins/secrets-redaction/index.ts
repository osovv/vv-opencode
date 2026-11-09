// FILE: src/plugins/secrets-redaction/index.ts
// VERSION: 2.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Native OpenCode 2.x plugin that redacts secrets from provider-bound request hooks (context/generate/compaction/title) and restores them in native tool inputs and streamed provider responses, strictly under the immutable policy capture bound to the session's family.
//   SCOPE: Native Plugin.define entry, strict per-family policy resolution through snapshot accept reconciliation BEFORE provider dispatch (unknown policy blocks provider-bound work with a reasoned, actionable error; only an explicit captured disabled policy is a no-redaction path), family-scoped placeholder state with TTL/max bounds and cleanup, per-native-session WebSocket framing discarded at each experimental.ws.handshake request boundary (so an abandoned stream cannot poison later frames) while family placeholder mappings stay shared, credentials-first redaction of system text and message text/reasoning/tool-call/tool-result/metadata fields with opaque media leaves preserved byte-for-byte in structured payloads, strict native tool input restoration that fails closed with a credential-safe error before any side effect when a secret reference has no mapping, SSE/non-SSE http.response restoration, experimental.ws.receive frame restoration, and credential-safe diagnostics. It never mutates the persisted user prompt, never falls back to the current or default config, never formats a fabricated host logger, and never fuzzy-matches or borrows mappings.
//   DEPENDS: [@opencode/plugin, src/runtime/context.ts, src/runtime/types.ts, src/lib/plugin-toggle-config.ts, src/lib/vvoc-config.ts, src/plugins/secrets-redaction/config.ts, src/plugins/secrets-redaction/patterns.ts, src/plugins/secrets-redaction/engine.ts, src/plugins/secrets-redaction/deep.ts, src/plugins/secrets-redaction/restore.ts, src/plugins/secrets-redaction/session.ts, src/plugins/secrets-redaction/stream.ts]
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, M-NATIVE-RUNTIME, V-M-PLUGIN-SECRETS-REDACTION, DF-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLACEHOLDER_PREFIX - Placeholder namespace prefix for redacted secrets.
//   SecretsPolicyResolution - Family-scoped policy key plus normalized secrets config.
//   SecretsPolicyUnboundReason - Why no trustworthy family policy exists (lineage vs config load).
//   SecretsPolicyUnbound - Unbound decision carrying its fail-closed reason.
//   SecretsPolicyDecision - Enabled resolution, explicit disable, unbound with reason, or unknown.
//   SecretsPolicyUnboundError - No trustworthy family policy exists, so provider-bound work is blocked.
//   SecretsReferenceUnresolvedError - Re-export of the strict tool-input restore failure.
//   SecretsRedactionHandlers - Native hook handlers for context/generate/compaction/title/tool/http/ws.
//   SecretsRedactionRegistration - Handlers plus cleanup-owning dispose.
//   SecretsRedactionDependencies - Injectable strict policy resolver and diagnostic sink.
//   createSecretsRedactionRegistration - Build per-family state plus native hook handlers.
//   SecretsRedactionPluginOptions - Optional injectable runtime acquisition for tests.
//   createSecretsRedactionPlugin - Native plugin factory; the default export acquires the real shared runtime.
//   SecretsRedactionPlugin - Default production native secrets-redaction plugin object.
//   SecretsContextEvent - Native context/generate/compaction/title request surface.
//   SecretsToolBeforeEvent - Native tool execute.before input surface.
//   SecretsHttpResponseEvent - Native http.response surface.
//   SecretsWsReceiveEvent - Native experimental.ws.receive frame surface.
//   SecretsWsHandshakeEvent - Native experimental.ws.handshake per-model-call request boundary surface.
//   default - Default export alias of SecretsRedactionPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Tool input restoration became strict: an unresolved well-formed secret reference throws SecretsReferenceUnresolvedError (SECRETS_REFERENCE_UNRESOLVED) naming tool, session, and the safe placeholder token BEFORE any side effect instead of silently executing with a placeholder path; structured tool-call/tool-result payloads redact with the media guard so base64/data-URL payloads stay byte-identical; SECRETS_POLICY_UNBOUND now distinguishes an unresolvable settings lineage from a config load failure and names value-free recovery guidance.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilySettingsView } from "../../runtime/session-settings.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { resolveSecretsRedactionRuntimeConfig, type SecretsRedactionConfig } from "./config.js";
import { buildPatternSet, type PatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { redactDeep, redactDeepMediaAware, restoreDeepStrict } from "./deep.js";
import { PlaceholderSession } from "./session.js";
import { SecretsReferenceUnresolvedError } from "./restore.js";
import {
  createFrameRestoreState,
  createResponseByteTransform,
  restoreProviderFrame,
  type FrameRestoreState,
} from "./stream.js";

export const PLACEHOLDER_PREFIX = "__VVOC_SECRET_";

export { SecretsReferenceUnresolvedError };

/** Family-scoped policy key plus normalized secrets config. */
export interface SecretsPolicyResolution {
  readonly key: string;
  readonly config: SecretsRedactionConfig;
}

/**
 * Why no trustworthy family policy exists. Fail-closed dispatch is unchanged;
 * the reason only makes the block actionable.
 */
export type SecretsPolicyUnboundReason = "settings-lineage-unresolvable" | "config-load-failed";

/** Unbound decision carrying its fail-closed reason. */
export interface SecretsPolicyUnbound {
  readonly unbound: true;
  readonly reason: SecretsPolicyUnboundReason;
}

/** A family whose captured policy disables secrets-redaction: the only legitimate no-redaction path. */
export type SecretsPolicyDecision =
  | SecretsPolicyResolution
  | "disabled"
  | SecretsPolicyUnbound
  | undefined;

/** No trustworthy family policy exists, so provider-bound work is blocked. */
export class SecretsPolicyUnboundError extends Error {
  readonly code = "SECRETS_POLICY_UNBOUND";
  readonly reason: SecretsPolicyUnboundReason;

  constructor(
    sessionID: string,
    reason: SecretsPolicyUnboundReason = "settings-lineage-unresolvable",
  ) {
    const cause =
      reason === "config-load-failed"
        ? "the family's vvoc configuration could not be loaded"
        : "no immutable secrets-redaction policy is bound to the session's settings lineage";
    super(
      `SECRETS_POLICY_UNBOUND: ${cause} (session ${sessionID}); refusing to dispatch an unredacted provider request. Recovery: repair the vvoc configuration and restart OpenCode (run \`vvoc doctor\` to inspect the effective config), or explicitly disable the secrets-redaction plugin for this scope if you intend to work without credential redaction.`,
    );
    this.name = "SecretsPolicyUnboundError";
    this.reason = reason;
  }
}

function isUnbound(resolved: SecretsPolicyDecision): resolved is SecretsPolicyUnbound {
  return (
    typeof resolved === "object" && resolved !== null && "unbound" in resolved && resolved.unbound
  );
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

/**
 * Native `experimental.ws.handshake` event: the request boundary a WebSocket-backed
 * model call crosses once, before the session socket is selected or reused.
 */
export interface SecretsWsHandshakeEvent {
  readonly sessionID: string;
}
// END_BLOCK_NATIVE_EVENTS

/** Native hook handlers for context/generate/compaction/title/tool/http/ws. */
export interface SecretsRedactionHandlers {
  context(event: SecretsContextEvent): Promise<void>;
  generate(event: SecretsContextEvent): Promise<void>;
  compaction(event: SecretsContextEvent): Promise<void>;
  title(event: SecretsContextEvent): Promise<void>;
  httpResponse(event: SecretsHttpResponseEvent): Promise<void>;
  wsHandshake(event: SecretsWsHandshakeEvent): Promise<void>;
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
        // Media-aware: base64/data-URL leaves in structured arguments stay
        // byte-identical while textual leaves redact.
        part.input = redactDeepMediaAware(part.input, state.patternSet, state.session);
      }
      if (part.metadata !== undefined) {
        part.metadata = redactDeep(part.metadata, state.patternSet, state.session);
      }
      return;
    }
    case "tool-result": {
      if (part.result !== undefined && part.result !== null && typeof part.result === "object") {
        const result = part.result as { type?: string; value?: unknown };
        // Media-aware: tool results carry image/PDF/audio/video payloads as
        // base64 or data URLs; rewriting those into placeholders corrupts
        // every subsequent provider request. Textual values still redact.
        result.value = redactDeepMediaAware(result.value, state.patternSet, state.session);
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
    if (resolved === undefined || isUnbound(resolved)) {
      throw new SecretsPolicyUnboundError(
        sessionID,
        isUnbound(resolved) ? resolved.reason : undefined,
      );
    }
    return stateFromResolution(resolved);
  };

  /**
   * Restore framing isolated to one native session. The session's family map is
   * shared across sessions, but partial carries, lane restorers and SSE framing
   * must never cross a session boundary.
   */
  const frameStateFor = (sessionID: string, session: PlaceholderSession): FrameRestoreState => {
    let frames = frameState.get(sessionID);
    if (frames === undefined) {
      frames = createFrameRestoreState(session);
      frameState.set(sessionID, frames);
    }
    return frames;
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
    async wsHandshake(event) {
      // `experimental.ws.handshake` runs once per model call before the session
      // socket is selected or reused. Discard only this session's abandoned
      // framing so a terminal-less SSE stream or partial carry cannot poison a
      // later request; family placeholder mappings are deliberately untouched.
      frameState.delete(event.sessionID);
    },
    async wsReceive(event) {
      // A missing policy never blocks socket frames (they may not be provider text),
      // but no restoration happens without a trustworthy family map.
      const resolved = await deps.configFor(event.sessionID);
      if (resolved === "disabled" || resolved === undefined || isUnbound(resolved)) return;
      const state = stateFromResolution(resolved);
      const frames = frameStateFor(event.sessionID, state.session);
      event.frame = restoreProviderFrame(state.session, event.frame, frames);
    },
    async toolBefore(event) {
      // Restoration requires a bound family map; without one there is nothing to
      // restore and no map may be borrowed from another family. With a bound
      // map the restore is strict: an unresolved well-formed reference throws
      // BEFORE the tool runs, so a placeholder never substitutes for a real
      // path or value at execution time.
      const resolved = await deps.configFor(event.sessionID);
      if (resolved === "disabled" || resolved === undefined || isUnbound(resolved)) return;
      if (event.input === undefined) return;
      const state = stateFromResolution(resolved);
      event.input = restoreDeepStrict(event.input, state.session, {
        tool: event.tool,
        sessionID: event.sessionID,
      });
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
/**
 * Resolve the family-settings secrets policy. Both failure shapes stay
 * fail-closed; they differ only in the reason surfaced to the operator:
 * an unresolvable settings lineage vs. a config snapshot that could not load.
 */
async function resolvePolicy(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<SecretsPolicyDecision> {
  let view: FamilySettingsView | undefined;
  try {
    view = await runtime.settings.configFor(sessionID);
  } catch {
    return { unbound: true, reason: "config-load-failed" };
  }
  if (view === undefined) return { unbound: true, reason: "settings-lineage-unresolvable" };
  if (!isVvocPluginEnabled(view.vvoc, "secrets-redaction")) return "disabled";
  const resolved = resolveSecretsRedactionRuntimeConfig({
    config: view.vvoc,
    source: { kind: "project" },
    warnings: [],
  });
  return { key: view.familyId, config: resolved.config };
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
        ctx.session.hook("experimental.ws.handshake", (event) => h.wsHandshake(event as never)),
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
