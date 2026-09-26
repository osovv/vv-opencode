// FILE: src/plugins/secrets-redaction/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Redact secrets from outgoing model requests and restore placeholders in tool inputs on the OpenCode v2 runtime with per-session location resolution.
//   SCOPE: v2 setup only: redact message and tool-part state through the session context hook, restore placeholders in tool arguments through the execute.before hook, resolve the pattern configuration per session location, keep the placeholder session with its TTL cleanup, and stay fail-open on handler errors.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/plugins/secrets-redaction/config.ts, src/plugins/secrets-redaction/patterns.ts, src/plugins/secrets-redaction/restore.ts, src/plugins/secrets-redaction/deep.ts, src/plugins/secrets-redaction/session.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupSecretsRedactionV2 - Register the redaction and restoration hooks for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-003 - Ported secrets redaction onto v2 session context and tool hooks.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { resolveSecretsRedactionRuntimeConfig } from "./config.js";
import { buildPatternSet } from "./patterns.js";
import { redactDeep, restoreDeep } from "./deep.js";
import { PlaceholderSession } from "./session.js";
import { PLACEHOLDER_PREFIX, redactMessageParts } from "./index.js";

// START_BLOCK_SETUP_SECRETS_REDACTION_V2
/**
 * Register the secrets-redaction hooks on the v2 runtime.
 *
 * The v1 experimental.chat.messages.transform becomes the v2 session context
 * hook redacting the mutable request messages (including tool-part state),
 * and the v1 tool.execute.before restore keeps the identical role on the v2
 * tool hook. The v1 experimental.text.complete restore has no v2 equivalent;
 * transient ctx.session.generate results are covered by the generate hook.
 * Pattern configuration resolves per session location, and every handler
 * failure degrades fail-open with a logged warning.
 */
export async function setupSecretsRedactionV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  const perLocation = new Map<
    string,
    { patternSet: ReturnType<typeof buildPatternSet>; session: PlaceholderSession } | undefined
  >();

  async function resolveForSession(sessionID: string) {
    const snapshot = await adapter.resolver.forSession(sessionID, (input) =>
      adapter.ctx.session.get(input),
    );
    if (!snapshot || !isVvocPluginEnabled(snapshot.config, "secrets-redaction")) return undefined;
    const existing = perLocation.get(snapshot.directory);
    if (existing) return existing;
    const { config } = resolveSecretsRedactionRuntimeConfig({ config: snapshot.config } as never);
    const entry = {
      patternSet: buildPatternSet(config.patterns),
      session: new PlaceholderSession({
        prefix: PLACEHOLDER_PREFIX,
        ttlMs: config.ttlMs,
        maxMappings: config.maxMappings,
        secret: config.secret,
      }),
    };
    perLocation.set(snapshot.directory, entry);
    return entry;
  }

  const contextHook = await adapter.ctx.session.hook("context", async (event) => {
    try {
      const entry = await resolveForSession(String(event.sessionID));
      if (!entry) return;
      for (const message of event.messages as unknown as Array<{ parts?: unknown }>) {
        redactMessageParts((message.parts ?? []) as never, entry.patternSet, entry.session);
        // v2 tool parts carry their payload under part.state identically to v1.
        for (const part of (message.parts ?? []) as unknown as Array<Record<string, unknown>>) {
          if (part.type === "tool" && part.state && typeof part.state === "object") {
            redactDeep(part.state, entry.patternSet, entry.session);
            if (part.metadata) {
              redactDeep(part.metadata, entry.patternSet, entry.session);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`[vvoc][secrets-redaction] context hook failed (fail-open): ${String(error)}`);
    }
  });

  const beforeHook = await adapter.ctx.tool.hook("execute.before", async (event) => {
    try {
      const entry = await resolveForSession(String(event.sessionID));
      if (!entry) return;
      if (event.input && typeof event.input === "object") {
        restoreDeep(event.input, entry.session);
      }
    } catch (error) {
      console.warn(`[vvoc][secrets-redaction] restore hook failed (fail-open): ${String(error)}`);
    }
  });

  return async () => {
    await contextHook.dispose();
    await beforeHook.dispose();
  };
}
// END_BLOCK_SETUP_SECRETS_REDACTION_V2
