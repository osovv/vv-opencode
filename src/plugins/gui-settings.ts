// FILE: src/plugins/gui-settings.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the versioned GUI RPC (`vvoc.gui.v1`) on the native server context so the `./gui-experimental` window part can read the effective vvoc defaults, write the orchestration profile through the conservative CLI write path, and receive honest stub/unsupported session-settings verdicts.
//   SCOPE: Structural server-context seam, bounded effective-defaults projection (orchestration profile, three plugin toggles, config source), CLI-reused conservative profile write with explicit global/project scope, session-existence validation via ctx.session.get, and value-free stable error mapping. It never patches session-owned settings, never writes anything but the canonical vvoc.json orchestration section, and never exposes credentials, model settings, or raw error messages.
//   DEPENDS: [@opencode/plugin, src/rpc.ts, src/commands/orchestration.ts, src/lib/config-layers.ts, src/lib/orchestration.ts, src/lib/plugin-toggle-config.ts, src/runtime/types.ts]
//   LINKS: [M-PLUGIN-GUI-SETTINGS, M-GUI-SPIKE, DF-GUI-RPC, V-M-PLUGIN-GUI-SETTINGS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   STUB_SETTINGS_NOTE - Fixed value-free note carried by every session.get stub reply.
//   GuiSettingsServerContext - Structural native server plugin context accepted by the registration helper.
//   GuiSettingsSourceKind - Bounded config-source kind accepted and returned by the handlers.
//   GuiSettingsDeps - Injected defaults/read/write/session seams used by the handlers.
//   createGuiSettingsHandlers - Build the four bounded handlers with injected seams.
//   registerGuiSettingsRpc - Register the versioned GUI RPC and return its registration handle.
//   GuiSettingsPlugin - Native server plugin that registers the GUI RPC on setup.
//   default - Alias of GuiSettingsPlugin for the native default-import contract.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added the native server-side GUI RPC registration with the CLI-reused conservative profile write and stub/unsupported session verdicts.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { loadVvocConfigForRead } from "../lib/config-layers.js";
import { resolveOrchestrationPolicy, type OrchestrationProfile } from "../lib/orchestration.js";
import { isVvocPluginEnabled } from "../lib/plugin-toggle-config.js";
import {
  VVOC_GUI_METHODS,
  VVOC_GUI_RPC_VERSION,
  vvocGuiRpc,
  type DefaultsGetInput,
  type DefaultsGetOutput,
  type DefaultsSetInput,
  type DefaultsSetOutput,
  type SessionGetInput,
  type SessionGetOutput,
  type SessionPatchInput,
  type SessionPatchOutput,
} from "../rpc.js";
import { setOrchestrationProfile } from "../commands/orchestration.js";
import type { RuntimeRpcRegistrar, RuntimeRpcRegistration } from "../runtime/types.js";

/** Fixed value-free note carried by every `session.get` stub reply. */
export const STUB_SETTINGS_NOTE =
  "session-owned settings are not implemented yet; values are read from the effective vvoc defaults";

/** Bounded config-source kind accepted and returned by the handlers. */
export type GuiSettingsSourceKind = "env" | "project" | "global" | "default" | "missing";

/** Structural native server plugin context accepted by the registration helper. */
export interface GuiSettingsServerContext {
  readonly location: { readonly directory: string };
  readonly rpc: RuntimeRpcRegistrar;
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<unknown>;
  };
}

/**
 * Injected defaults/read/write/session seams. The production wiring reuses the
 * CLI's layered reader and conservative orchestration writer verbatim; tests
 * replace them with in-memory seams.
 */
export interface GuiSettingsDeps {
  /** Reads the bounded effective-defaults projection for the server's project directory. */
  readonly readDefaults: () => Promise<{
    readonly profile: OrchestrationProfile;
    readonly plugins: { guardian: boolean; analytics: boolean; peakHours: boolean };
    readonly source: { kind: GuiSettingsSourceKind; path?: string };
  }>;
  /** Writes one orchestration profile through the conservative CLI write path. */
  readonly writeProfile: (
    profile: OrchestrationProfile,
    scope: "global" | "project",
  ) => Promise<{ action: "updated" | "kept"; path: string }>;
  /** Resolves whether one session id exists on this server. */
  readonly sessionExists: (sessionID: string) => Promise<boolean>;
}

type GuiHandlers = {
  [VVOC_GUI_METHODS.defaultsGet]: (input: DefaultsGetInput) => Promise<DefaultsGetOutput>;
  [VVOC_GUI_METHODS.defaultsSet]: (input: DefaultsSetInput) => Promise<DefaultsSetOutput>;
  [VVOC_GUI_METHODS.sessionGet]: (input: SessionGetInput) => Promise<SessionGetOutput>;
  [VVOC_GUI_METHODS.sessionPatch]: (input: SessionPatchInput) => Promise<SessionPatchOutput>;
};

// START_BLOCK_HANDLERS
/**
 * Builds the four bounded handlers. Every failure becomes a value-free stable
 * verdict: config problems degrade to `unavailable` codes, a failed write is
 * `rejected`, and session settings stay explicitly `stub`/`unsupported`.
 */
export function createGuiSettingsHandlers(deps: GuiSettingsDeps): GuiHandlers {
  return {
    async [VVOC_GUI_METHODS.defaultsGet]() {
      try {
        const defaults = await deps.readDefaults();
        return {
          version: VVOC_GUI_RPC_VERSION,
          status: "available",
          profile: defaults.profile,
          plugins: defaults.plugins,
          source: {
            kind: defaults.source.kind,
            ...(defaults.source.path === undefined ? {} : { path: defaults.source.path }),
          },
        } satisfies DefaultsGetOutput;
      } catch {
        return {
          version: VVOC_GUI_RPC_VERSION,
          status: "unavailable",
          error: "config_unavailable",
        } satisfies DefaultsGetOutput;
      }
    },
    async [VVOC_GUI_METHODS.defaultsSet](input) {
      try {
        const result = await deps.writeProfile(input.profile, input.scope);
        return {
          version: VVOC_GUI_RPC_VERSION,
          action: result.action,
          profile: input.profile,
          path: result.path,
        } satisfies DefaultsSetOutput;
      } catch {
        return {
          version: VVOC_GUI_RPC_VERSION,
          action: "unavailable",
          profile: input.profile,
          error: "config_unavailable",
        } satisfies DefaultsSetOutput;
      }
    },
    async [VVOC_GUI_METHODS.sessionGet](input) {
      try {
        if (!(await deps.sessionExists(input.sessionID))) {
          return {
            version: VVOC_GUI_RPC_VERSION,
            status: "unavailable",
            note: STUB_SETTINGS_NOTE,
            error: "session_lookup_failed",
          } satisfies SessionGetOutput;
        }
        try {
          const defaults = await deps.readDefaults();
          return {
            version: VVOC_GUI_RPC_VERSION,
            status: "stub",
            profile: defaults.profile,
            note: STUB_SETTINGS_NOTE,
          } satisfies SessionGetOutput;
        } catch {
          return {
            version: VVOC_GUI_RPC_VERSION,
            status: "unavailable",
            note: STUB_SETTINGS_NOTE,
            error: "config_unavailable",
          } satisfies SessionGetOutput;
        }
      } catch {
        return {
          version: VVOC_GUI_RPC_VERSION,
          status: "unavailable",
          note: STUB_SETTINGS_NOTE,
          error: "session_lookup_failed",
        } satisfies SessionGetOutput;
      }
    },
    async [VVOC_GUI_METHODS.sessionPatch](input) {
      try {
        if (!(await deps.sessionExists(input.sessionID))) {
          return {
            version: VVOC_GUI_RPC_VERSION,
            status: "unavailable",
            error: "session_lookup_failed",
          } satisfies SessionPatchOutput;
        }
        return {
          version: VVOC_GUI_RPC_VERSION,
          status: "unsupported",
          error: "session_settings_unsupported",
        } satisfies SessionPatchOutput;
      } catch {
        return {
          version: VVOC_GUI_RPC_VERSION,
          status: "unavailable",
          error: "session_lookup_failed",
        } satisfies SessionPatchOutput;
      }
    },
  };
}
// END_BLOCK_HANDLERS

/** Register the versioned GUI RPC; the returned handle disposes only this registration. */
export async function registerGuiSettingsRpc(
  ctx: GuiSettingsServerContext,
): Promise<RuntimeRpcRegistration> {
  const handlers = createGuiSettingsHandlers(productionDeps(ctx));
  return ctx.rpc.register(vvocGuiRpc, handlers);
}

/** Production seams: the CLI's layered reader and conservative writer, unchanged. */
function productionDeps(ctx: GuiSettingsServerContext): GuiSettingsDeps {
  const directory = ctx.location.directory;
  return {
    async readDefaults() {
      const { config, source } = await loadVvocConfigForRead({
        scope: "effective",
        cwd: directory,
        allowDefault: true,
      });
      return {
        profile: resolveOrchestrationPolicy(config).profile,
        plugins: {
          guardian: isVvocPluginEnabled(config, "guardian"),
          analytics: isVvocPluginEnabled(config, "analytics"),
          peakHours: isVvocPluginEnabled(config, "peak-hours"),
        },
        source: { kind: source.kind, ...(source.path === undefined ? {} : { path: source.path }) },
      };
    },
    writeProfile: (profile, scope) => setOrchestrationProfile(profile, { cwd: directory, scope }),
    sessionExists: async (sessionID) => {
      await ctx.session.get({ sessionID });
      return true;
    },
  };
}

// START_BLOCK_PLUGIN_ENTRY
/**
 * Native server plugin that registers the versioned GUI RPC. Composed inside
 * the aggregate `vvoc` server plugin; teardown disposes only its own
 * registration.
 */
const GuiSettingsPlugin = Plugin.define({
  id: "vvoc-gui-settings",
  async setup(ctx) {
    const registration = await registerGuiSettingsRpc(ctx as GuiSettingsServerContext);
    return async () => {
      await registration.dispose();
    };
  },
});

export { GuiSettingsPlugin };
export default GuiSettingsPlugin;
// END_BLOCK_PLUGIN_ENTRY
