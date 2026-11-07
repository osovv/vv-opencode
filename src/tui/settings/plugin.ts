// FILE: src/tui/settings/plugin.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the native OpenCode /vv-settings slash command that changes or shows the current session family's session-owned settings through the running host.
//   SCOPE: Keymap command registration through the native app slot, active-session gating, shared text action syntax, one bounded toast per outcome, and lifecycle disposal. All host access goes through the injected session client; no configuration file is read here.
//   DEPENDS: [@opencode/plugin/tui, src/commands/session.ts, src/runtime/session-settings.ts, src/tui/context/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-NATIVE-RUNTIME, M-CLI-SESSION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SETTINGS_COMMAND_ID - Stable native keymap command id behind /vv-settings.
//   SettingsTuiDependencies - Injectable apply/read seams for focused tests.
//   registerSettingsTuiCommand - Register /vv-settings on the native keymap layer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-005 - Added /vv-settings as the explicit family-settings command replacing the removed /vv-rebind marker command.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode/plugin/tui";
import {
  applySessionSettingsAction,
  describeFamilySettings,
  parseSessionSettingsAction,
  readFamilySettingsViaClient,
} from "../../commands/session.js";
import type { FamilySettings, SessionSettingsClient } from "../../runtime/session-settings.js";
import { activeSessionID } from "../context/plugin.js";

/** Stable native keymap command id behind the /vv-settings slash command. */
export const SETTINGS_COMMAND_ID = "vvoc.settings.set";

/** Injectable apply/read seams for focused tests. */
export type SettingsTuiDependencies = {
  readonly apply: (input: {
    readonly sessionID: string;
    readonly actionText: string;
  }) => Promise<{ readonly rootID: string; readonly settings: FamilySettings }>;
  readonly describe: (sessionID: string) => Promise<string | undefined>;
};

/**
 * Register /vv-settings on the native keymap layer, mirroring the /context
 * registration: the layer must be created inside a mounted slot render, so the
 * command claims the always-present `app` slot. With no argument the command
 * shows the current family settings; with the shared text action syntax
 * (`preset <name>`, `profile <name>`, `role <id> <model>`, `role unset <id>`,
 * `plugin <name> on|off`, `pull-defaults`) it applies exactly one change to the
 * active session's family root through a lineage-rooted metadata
 * read-modify-write. The command displays bounded summaries only and never
 * shows credential values.
 */
export function registerSettingsTuiCommand(
  ctx: Plugin.Context & { readonly client: SessionSettingsClient },
  dependencies: SettingsTuiDependencies = {
    async apply({ sessionID, actionText }) {
      return applySessionSettingsAction({
        client: ctx.client,
        sessionID,
        action: parseSessionSettingsAction(actionText),
        cwd: process.cwd(),
      });
    },
    async describe(sessionID) {
      const settings = await readFamilySettingsViaClient({ client: ctx.client, sessionID });
      return settings === undefined ? undefined : describeFamilySettings(settings).join("\n");
    },
  },
): () => void {
  return ctx.ui.slot({
    append: "app",
    render() {
      ctx.keymap.layer(() => ({
        // Global so the command stays reachable from the prompt input mode,
        // like /context; the default base layer is not.
        mode: "global",
        commands: [
          {
            id: SETTINGS_COMMAND_ID,
            title: "Session settings",
            description:
              "Show or change this session family's settings (preset, profile, roles, plugins)",
            group: "VVOC",
            palette: true,
            slash: { name: "vv-settings", arguments: true },
            enabled: () => activeSessionID(ctx) !== undefined,
            run: async (input?: string) => {
              const sessionID = activeSessionID(ctx);
              if (sessionID === undefined) {
                // Reachable only through the palette when no session is open.
                ctx.ui.toast.show({
                  variant: "warning",
                  title: "Session settings",
                  message: "Open a session before running /vv-settings.",
                });
                return;
              }
              const argument = (input ?? "").trim();
              if (argument.length === 0) {
                try {
                  const summary = await dependencies.describe(sessionID);
                  if (activeSessionID(ctx) !== sessionID) return;
                  ctx.ui.toast.show({
                    variant: "info",
                    title: "Session settings",
                    message:
                      summary ??
                      "No settings recorded yet; the family resolves the current defaults.",
                  });
                } catch (error) {
                  if (activeSessionID(ctx) !== sessionID) return;
                  ctx.ui.toast.show({
                    variant: "error",
                    title: "Session settings unavailable",
                    message: boundedError(error),
                  });
                }
                return;
              }
              try {
                const result = await dependencies.apply({ sessionID, actionText: argument });
                // A user who switched tabs mid-write did not see the outcome.
                if (activeSessionID(ctx) !== sessionID) return;
                ctx.ui.toast.show({
                  variant: "success",
                  title: "Session settings updated",
                  message: `${describeFamilySettings(result.settings).join(" · ")}`,
                });
              } catch (error) {
                if (activeSessionID(ctx) !== sessionID) return;
                ctx.ui.toast.show({
                  variant: "error",
                  title: "Session settings rejected",
                  message: boundedError(error),
                });
              }
            },
          },
        ],
      }));
      // The slot exists only to host the keymap layer; it renders nothing.
      return null;
    },
  });
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}
