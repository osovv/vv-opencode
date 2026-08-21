// FILE: src/tui/peak-hours/banner.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a persistent orange peak-hours warning banner in the OpenCode app_bottom slot while the current model's provider is in peak.
//   SCOPE: Current model resolution from the open session and config fallback, connected provider suggestions, banner text composition, toggle-gated app_bottom registration, and fail-soft slot rendering.
//   DEPENDS: [@opencode-ai/plugin/tui, @opentui/solid, @opentui/core, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/lib/peak-hours.ts]
//   LINKS: [M-TUI-PEAK-HOURS-BANNER, M-PEAK-HOURS-SCHEDULES, M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PeakBannerModelRef - Resolved provider id for the currently selected model.
//   PeakHoursBannerDependencies - Injectable enablement, clock, entry, model, providers, and rendering dependencies for focused tests.
//   buildPeakBannerText - Composes the one-line banner label with window end and suggestions.
//   resolveBannerModelRef - Resolves the current model reference from session messages with a config default fallback.
//   registerPeakHoursBanner - Registers the persistent app_bottom peak banner.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Added the app_bottom peak-hours banner with dynamic provider suggestions.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  findActivePeak,
  formatPeakEndTime,
  normalizeProviderId,
  parsePeakHoursEntry,
  suggestOffPeakProviders,
  type ActivePeak,
  type PeakHoursClock,
  type PeakHoursEntryConfig,
} from "../../lib/peak-hours.js";

export type PeakBannerModelRef = {
  providerID: string;
};

export type PeakHoursBannerDependencies = {
  enabled: (api: TuiPluginApi) => Promise<boolean>;
  now: PeakHoursClock;
  entry: () => PeakHoursEntryConfig;
  currentModel: (api: TuiPluginApi) => PeakBannerModelRef | undefined;
  connectedProviders: (api: TuiPluginApi) => string[];
  renderBanner: (text: string, color: RGBA) => JSX.Element;
};

// START_CONTRACT: buildPeakBannerText
//   PURPOSE: Compose the one-line banner label with window end and suggestions.
//   INPUTS: { providerID: string - peak provider id; peak: ActivePeak - active window hit; suggestions: readonly string[] - connected off-peak provider ids }
//   OUTPUTS: { string - banner label text }
//   SIDE_EFFECTS: none
//   LINKS: formatPeakEndTime
// END_CONTRACT: buildPeakBannerText
export function buildPeakBannerText(
  providerID: string,
  peak: ActivePeak,
  suggestions: readonly string[],
): string {
  const until = formatPeakEndTime(peak.endsAt);
  const suffix =
    suggestions.length > 0
      ? ` · off-peak now: ${suggestions.join(", ")}`
      : " · every connected provider is in peak or unscheduled";
  return `⚠ PEAK ${providerID} until ${until} · elevated pricing${suffix}`;
}

// START_CONTRACT: resolveBannerModelRef
//   PURPOSE: Resolve the current model reference from the open session's messages with a config default fallback.
//   INPUTS: { api: TuiPluginApi - TUI plugin api }
//   OUTPUTS: { PeakBannerModelRef | undefined - provider id of the most recent model-bearing message, the config default model, or undefined }
//   SIDE_EFFECTS: none
//   LINKS: currentSessionID
// END_CONTRACT: resolveBannerModelRef
export function resolveBannerModelRef(api: TuiPluginApi): PeakBannerModelRef | undefined {
  const sessionID = currentSessionID(api);
  if (!sessionID) return undefined;

  const messages = api.state.session.messages(sessionID) as ReadonlyArray<{
    role?: string;
    providerID?: string;
    model?: { providerID?: string };
  }>;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant" && typeof message.providerID === "string") {
      return { providerID: message.providerID };
    }
    if (typeof message.model?.providerID === "string") {
      return { providerID: message.model.providerID };
    }
  }

  const configModel = (api.state.config as { model?: unknown }).model;
  if (typeof configModel === "string" && configModel.includes("/")) {
    const providerID = configModel.split("/")[0];
    if (providerID) return { providerID };
  }
  return undefined;
}

/** Reads the currently open sessionID from the TUI route, or "". */
function currentSessionID(api: TuiPluginApi): string {
  const route = api.route.current;
  if (route.name === "session" && "params" in route) {
    const sessionID = route.params?.sessionID;
    return typeof sessionID === "string" ? sessionID : "";
  }
  return "";
}

// START_BLOCK_REGISTER_BANNER
/**
 * Registers the persistent peak-hours banner for the app_bottom host slot.
 *
 * The banner renders in warning colors only while the current model's provider
 * is inside an active peak window, naming the provider, the window end, and
 * connected providers that are currently outside peak. Disabled toggle or
 * entry, missing slot API, or registration failure leave the TUI untouched.
 */
export async function registerPeakHoursBanner(
  api: TuiPluginApi,
  dependencies: Partial<PeakHoursBannerDependencies> = {},
): Promise<void> {
  if (typeof api.slots?.register !== "function") return;

  // Populated by the default enabled() config read; kept for the sync entry().
  let cachedEntry: PeakHoursEntryConfig | undefined;

  const deps: PeakHoursBannerDependencies = {
    enabled: async (apiInstance) => {
      const vvoc = await loadVvocConfigForRead({
        scope: "effective",
        allowDefault: true,
        cwd: apiInstance.state.path.directory,
      });
      if (!isVvocPluginEnabled(vvoc.config, "peak-hours")) return false;
      const parsed = parsePeakHoursEntry(vvoc.config.plugins?.["peak-hours"]);
      cachedEntry = parsed.entry;
      return parsed.entry.enabled;
    },
    now: () => new Date(),
    entry: () => cachedEntry ?? parsePeakHoursEntry(undefined).entry,
    currentModel: (apiInstance) => resolveBannerModelRef(apiInstance),
    connectedProviders: (apiInstance) =>
      apiInstance.state.provider
        .map((provider) => (provider as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    renderBanner: (text, color) => (
      <text>
        <span style={{ fg: color }}>{text}</span>
      </text>
    ),
    ...dependencies,
  };

  if (!(await deps.enabled(api))) return;

  try {
    // OpenCode's runtime requires a string plugin id on slot registrations, while
    // the SDK's TuiSlotPlugin type still types id as never; cast bridges the two.
    const plugin = {
      id: "vvoc-peak-hours",
      order: 100,
      slots: {
        app_bottom: (_ctx: TuiSlotContext) => {
          const entry = deps.entry();
          if (!entry.enabled) return undefined;

          const modelRef = deps.currentModel(api);
          if (!modelRef) return undefined;

          const now = deps.now();
          const peak = findActivePeak(now, entry.schedules, modelRef.providerID);
          if (!peak) return undefined;

          const suggestions = suggestOffPeakProviders(
            now,
            entry.schedules,
            deps.connectedProviders(api),
          ).filter(
            (candidate) =>
              normalizeProviderId(candidate) !== normalizeProviderId(modelRef.providerID),
          );

          return deps.renderBanner(
            buildPeakBannerText(modelRef.providerID, peak, suggestions),
            api.theme.current.warning,
          );
        },
      },
    } as unknown as Parameters<TuiPluginApi["slots"]["register"]>[0];
    api.slots.register(plugin);
  } catch {
    // Fail-soft: no banner for this session.
  }
}
// END_BLOCK_REGISTER_BANNER
