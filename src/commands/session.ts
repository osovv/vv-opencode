// FILE: src/commands/session.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide `vvoc session set` for explicit session-owned family-settings changes through the running host, plus the shared action parsing, application, and summary helpers reused by the native TUI /vv-settings command.
//   SCOPE: Discovery of the running native service, lineage-rooted read-modify-write metadata updates (preset, profile, role, plugin toggle, pull-defaults), and human-readable summaries. Config reads follow the scoped layering; credentials are never written into settings.
//   DEPENDS: [citty, @opencode/client, @opencode/client/service, src/lib/config-layers.ts, src/lib/model-roles.ts, src/lib/orchestration.ts, src/lib/plugin-toggle-config.ts, src/runtime/session-settings.ts, src/runtime/types.ts]
//   LINKS: [M-CLI-SESSION, M-NATIVE-RUNTIME, M-PLUGIN-CONTEXT-TUI, V-M-CLI-SESSION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SessionSettingsAction - One explicit settings change requested by name.
//   parseSessionSettingsAction - Parse the shared text action syntax used by the TUI.
//   applySessionSettingsAction - Resolve the family root and read-modify-write its settings key.
//   describeFamilySettings - Render a settings record as bounded summary lines.
//   readFamilySettingsViaClient - Read the current settings of a session's family root.
//   acquireSettingsClient - Discover the running native service and build an authenticated client.
//   default - Session command group with the `set` subcommand.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-003 - Added the explicit session-settings command set: preset, profile, role, plugin toggle, and pull-defaults through a lineage-rooted metadata read-modify-write.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { loadVvocConfigForRead } from "../lib/config-layers.js";
import { parseModelSelection } from "../lib/model-roles.js";
import { parseOrchestrationProfile } from "../lib/orchestration.js";
import { PLUGIN_TOGGLE_NAMES } from "../lib/plugin-toggle-config.js";
import {
  readSettingsFromMetadata,
  resolveFamilyRootViaClient,
  settingsFromConfig,
  updateFamilySettingsViaClient,
  type FamilySettings,
  type SessionSettingsClient,
} from "../runtime/session-settings.js";
import { isSupportedServiceVersion } from "../runtime/types.js";

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** One explicit settings change requested by name. */
export type SessionSettingsAction =
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "profile"; readonly profile: string }
  | { readonly kind: "role-set"; readonly roleId: string; readonly model: string }
  | { readonly kind: "role-unset"; readonly roleId: string }
  | { readonly kind: "plugin"; readonly plugin: string; readonly enabled: boolean }
  | { readonly kind: "pull-defaults" };

/**
 * Parse the shared text action syntax behind `/vv-settings`: an empty input is
 * a read (undefined), otherwise the first word selects the action. Unknown
 * actions throw with the accepted syntax so the caller can surface it.
 */
export function parseSessionSettingsAction(raw: string | undefined): SessionSettingsAction {
  const text = (raw ?? "").trim();
  if (text.length === 0) throw new Error("settings action required");
  const [head, ...rest] = text.split(/\s+/);
  switch (head) {
    case "preset": {
      const name = rest.join(" ").trim();
      if (!name) throw new Error("usage: preset <name>");
      return { kind: "preset", name };
    }
    case "profile": {
      const profile = rest.join(" ").trim();
      if (!profile) throw new Error("usage: profile <name>");
      return { kind: "profile", profile };
    }
    case "role": {
      const roleId = rest[0]?.trim() ?? "";
      const model = rest.slice(1).join(" ").trim();
      if (!roleId) throw new Error("usage: role <id> <model> | role unset <id>");
      if (roleId === "unset") {
        const unsetId = rest[1]?.trim() ?? "";
        if (!unsetId) throw new Error("usage: role unset <id>");
        return { kind: "role-unset", roleId: unsetId };
      }
      if (!model) throw new Error("usage: role <id> <model>");
      return { kind: "role-set", roleId, model };
    }
    case "plugin": {
      const plugin = rest[0]?.trim() ?? "";
      const state = rest[1]?.trim().toLowerCase() ?? "";
      if (!plugin || (state !== "on" && state !== "off")) {
        throw new Error("usage: plugin <name> on|off");
      }
      return { kind: "plugin", plugin, enabled: state === "on" };
    }
    case "pull-defaults":
      return { kind: "pull-defaults" };
    default:
      throw new Error(
        "unknown settings action; accepted: preset <name> | profile <name> | role <id> <model> | role unset <id> | plugin <name> on|off | pull-defaults",
      );
  }
}

function normalizeRoleId(roleId: string): string {
  const normalized = roleId.trim();
  if (!ROLE_ID_PATTERN.test(normalized)) {
    throw new Error(
      `invalid role id \`${roleId}\`; expected lowercase letters, digits, and hyphens`,
    );
  }
  return normalized;
}

function assertToggleName(plugin: string): string {
  if (!PLUGIN_TOGGLE_NAMES.includes(plugin as (typeof PLUGIN_TOGGLE_NAMES)[number])) {
    throw new Error(
      `unknown plugin "${plugin}"; available plugins: ${PLUGIN_TOGGLE_NAMES.join(", ")}`,
    );
  }
  return plugin;
}

/** Read-modify-write the settings key of a session's family root. */
export async function applySessionSettingsAction(input: {
  readonly client: SessionSettingsClient;
  readonly sessionID: string;
  readonly action: SessionSettingsAction;
  readonly cwd?: string;
  readonly configDir?: string;
}): Promise<{ readonly rootID: string; readonly settings: FamilySettings }> {
  const action = input.action;
  if (action.kind === "pull-defaults") {
    const { config } = await loadVvocConfigForRead({
      scope: "effective",
      cwd: input.cwd ?? process.cwd(),
      configDir: input.configDir,
      allowDefault: true,
    });
    return updateFamilySettingsViaClient({
      client: input.client,
      sessionID: input.sessionID,
      apply: () => settingsFromConfig(config),
    });
  }
  return updateFamilySettingsViaClient({
    client: input.client,
    sessionID: input.sessionID,
    apply: (current) => applyToSettings(current, action, input),
  });
}

async function applyToSettings(
  current: FamilySettings | undefined,
  action: SessionSettingsAction,
  input: { readonly cwd?: string; readonly configDir?: string },
): Promise<FamilySettings> {
  const base: FamilySettings = current ?? (await settingsFromCurrentConfig(input));
  switch (action.kind) {
    case "preset": {
      const { config } = await loadVvocConfigForRead({
        scope: "effective",
        cwd: input.cwd ?? process.cwd(),
        configDir: input.configDir,
        allowDefault: true,
      });
      const presetName = action.name.trim();
      const preset = config.presets[presetName];
      if (preset === undefined) {
        const available = Object.keys(config.presets).sort().join(", ");
        throw new Error(
          `unknown preset: ${presetName}. Available presets: ${available || "<none>"}`,
        );
      }
      const roles: Record<string, string> = {};
      for (const [roleId, rawModel] of Object.entries(preset.agents)) {
        roles[normalizeRoleId(roleId)] = parseModelSelection(
          typeof rawModel === "string" ? rawModel : String(rawModel),
        ).normalized;
      }
      return {
        version: 1,
        preset: presetName,
        roles,
        profile:
          preset.orchestration === undefined
            ? base.profile
            : parseOrchestrationProfile(preset.orchestration.profile, `preset ${presetName}`),
        plugins: base.plugins,
      };
    }
    case "profile":
      return {
        ...base,
        preset: base.preset,
        profile: parseOrchestrationProfile(action.profile, "profile"),
      };
    case "role-set":
      return {
        ...base,
        preset: base.preset,
        roles: {
          ...base.roles,
          [normalizeRoleId(action.roleId)]: parseModelSelection(action.model).normalized,
        },
      };
    case "role-unset": {
      const roleId = normalizeRoleId(action.roleId);
      const { [roleId]: _removed, ...remaining } = base.roles;
      return { ...base, preset: base.preset, roles: remaining };
    }
    case "plugin":
      return {
        ...base,
        preset: base.preset,
        plugins: {
          ...base.plugins,
          [assertToggleName(action.plugin)]: action.enabled,
        },
      };
    case "pull-defaults":
      // Handled before apply; unreachable here.
      return base;
  }
}

async function settingsFromCurrentConfig(input: {
  readonly cwd?: string;
  readonly configDir?: string;
}): Promise<FamilySettings> {
  const { config } = await loadVvocConfigForRead({
    scope: "effective",
    cwd: input.cwd ?? process.cwd(),
    configDir: input.configDir,
    allowDefault: true,
  });
  return settingsFromConfig(config);
}

/** Render a settings record as bounded summary lines. */
export function describeFamilySettings(settings: FamilySettings): string[] {
  const lines: string[] = [];
  if (settings.preset !== undefined) lines.push(`preset: ${settings.preset}`);
  const roles = Object.entries(settings.roles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roleId, model]) => `${roleId}=${model}`);
  lines.push(roles.length === 0 ? "roles: (none)" : `roles: ${roles.join(", ")}`);
  lines.push(`profile: ${settings.profile}`);
  const plugins = Object.entries(settings.plugins)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, enabled]) => `${name}=${enabled ? "on" : "off"}`);
  lines.push(plugins.length === 0 ? "plugins: (defaults)" : `plugins: ${plugins.join(", ")}`);
  return lines;
}

/** Read the current settings of a session's family root (undefined when unborn). */
export async function readFamilySettingsViaClient(input: {
  readonly client: SessionSettingsClient;
  readonly sessionID: string;
}): Promise<FamilySettings | undefined> {
  const root = await resolveFamilyRootViaClient(input.client, input.sessionID);
  const read = readSettingsFromMetadata(root.metadata);
  if (read === undefined) return undefined;
  if ("error" in read) {
    throw new Error(`Family settings for ${root.id} are invalid: ${read.error}`);
  }
  return read.settings;
}

/** Discover the running native service and build an authenticated client. */
export async function acquireSettingsClient(): Promise<SessionSettingsClient> {
  const endpoint = await Service.discover({ version: isSupportedServiceVersion });
  if (endpoint === undefined) {
    throw new Error(
      "No running OpenCode service was discovered. Start the host (`opencode` or `vvoc launch`) and retry.",
    );
  }
  const headers = Service.headers(endpoint);
  return OpenCode.make({ baseUrl: endpoint.url, headers });
}

const sessionArg = {
  type: "string" as const,
  required: true,
  description: "Session id of any member of the target family.",
};

const presetArg = {
  type: "string" as const,
  description: "Apply a configured preset's roles and profile to the family.",
};

const profileArg = {
  type: "string" as const,
  description: "Set the orchestration profile (e.g. single-session, orchestrated).",
};

const roleArg = {
  type: "string" as const,
  description: "Set one role: --role <id>=<model>, or remove one: --role unset:<id>.",
};

const pluginArg = {
  type: "string" as const,
  description: "Toggle one vvoc-managed plugin: --plugin <name>=on|off.",
};

const pullDefaultsArg = {
  type: "boolean" as const,
  description: "Replace the family settings with the current effective defaults.",
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home.",
};

const sessionSet = defineCommand({
  meta: {
    name: "set",
    description: "Change the session-owned settings of one session family.",
  },
  args: {
    session: sessionArg,
    preset: presetArg,
    profile: profileArg,
    role: roleArg,
    plugin: pluginArg,
    "pull-defaults": pullDefaultsArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const actions: SessionSettingsAction[] = [];
    if (typeof args.preset === "string" && args.preset.trim().length > 0) {
      actions.push({ kind: "preset", name: args.preset });
    }
    if (typeof args.profile === "string" && args.profile.trim().length > 0) {
      actions.push({ kind: "profile", profile: args.profile });
    }
    if (typeof args.role === "string" && args.role.trim().length > 0) {
      const raw = args.role.trim();
      if (raw.startsWith("unset:")) {
        actions.push({ kind: "role-unset", roleId: raw.slice("unset:".length) });
      } else {
        const separator = raw.indexOf("=");
        if (separator <= 0) {
          throw new Error("--role expects <id>=<model> or unset:<id>");
        }
        actions.push({
          kind: "role-set",
          roleId: raw.slice(0, separator),
          model: raw.slice(separator + 1),
        });
      }
    }
    if (typeof args.plugin === "string" && args.plugin.trim().length > 0) {
      const separator = args.plugin.indexOf("=");
      if (separator <= 0) {
        throw new Error("--plugin expects <name>=on|off");
      }
      const state = args.plugin
        .slice(separator + 1)
        .trim()
        .toLowerCase();
      if (state !== "on" && state !== "off") {
        throw new Error("--plugin expects <name>=on|off");
      }
      actions.push({
        kind: "plugin",
        plugin: args.plugin.slice(0, separator),
        enabled: state === "on",
      });
    }
    if (args["pull-defaults"] === true) {
      actions.push({ kind: "pull-defaults" });
    }
    if (actions.length === 0) {
      throw new Error(
        "nothing to set; pass --preset, --profile, --role, --plugin, or --pull-defaults",
      );
    }
    if (actions.length > 1) {
      throw new Error("pass exactly one settings action per invocation");
    }
    const sessionID =
      typeof args.session === "string" && args.session.trim().length > 0
        ? args.session.trim()
        : undefined;
    if (sessionID === undefined) {
      throw new Error("--session <id> is required");
    }

    const client = await acquireSettingsClient();
    const result = await applySessionSettingsAction({
      client,
      sessionID,
      action: actions[0]!,
      configDir: typeof args["config-dir"] === "string" ? args["config-dir"] : undefined,
    });
    console.log(`Family ${result.rootID} settings updated:`);
    for (const line of describeFamilySettings(result.settings)) {
      console.log(`  ${line}`);
    }
  },
});

export default defineCommand({
  meta: {
    name: "session",
    description: "Inspect and change session-owned family settings.",
  },
  subCommands: {
    set: sessionSet,
  },
});
