// FILE: src/tui/peak-hours/banner.tsx
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a persistent warning banner at the top of the session composer while the current model's provider is in a peak window.
//   SCOPE: Current model resolution from the native TUI/data surfaces, connected provider suggestions, banner text composition, policy-gated native `session.composer.top` claim, and fail-soft rendering with a disposer.
//   DEPENDS: [@opencode/plugin/tui, @opentui/core, src/lib/peak-hours.ts, src/tui/policy.ts]
//   LINKS: [M-TUI-PEAK-HOURS-BANNER, M-PEAK-HOURS-SCHEDULES, M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PeakBannerModelRef - Resolved provider id for the currently selected model.
//   PeakHoursBannerDependencies - Injectable clock, entry, model, providers, and rendering dependencies for focused tests.
//   buildPeakBannerText - Compose the one-line banner label with window end and suggestions.
//   resolveBannerModelRef - Resolve the selected model provider, falling back to the latest message model.
//   registerPeakHoursBanner - Claim the native composer-top peak banner and return its disposer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Reads the shared loading/quarantine-aware policy snapshot and renders no banner while it is unavailable.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
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
import type { ContextPolicySnapshot } from "../policy.js";
import { policyPeakHours } from "../policy.js";

export type PeakBannerModelRef = {
  providerID: string;
};

export type PeakHoursBannerDependencies = {
  isEnabled: () => boolean;
  now: PeakHoursClock;
  entry: () => PeakHoursEntryConfig;
  currentModel: (ctx: Plugin.Context) => PeakBannerModelRef | undefined;
  connectedProviders: (ctx: Plugin.Context) => string[];
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
//   PURPOSE: Resolve the selected model provider, falling back to the most recent model-bearing message.
//   INPUTS: { ctx: Plugin.Context - native TUI context }
//   OUTPUTS: { PeakBannerModelRef | undefined - provider id of the selected model or the newest model-bearing message }
//   SIDE_EFFECTS: none
// END_CONTRACT: resolveBannerModelRef
export function resolveBannerModelRef(ctx: Plugin.Context): PeakBannerModelRef | undefined {
  const selected = ctx.ui.model.current();
  if (selected !== undefined && selected.providerID.length > 0) {
    return { providerID: selected.providerID };
  }
  const route = ctx.ui.router.current();
  if (route.type !== "session") return undefined;
  const messages = ctx.data.session.message.list(route.sessionID) as ReadonlyArray<{
    type?: string;
    model?: { providerID?: string };
  }>;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const providerID = message.model?.providerID;
    if (typeof providerID === "string" && providerID.length > 0) return { providerID };
  }
  return undefined;
}

// START_BLOCK_REGISTER_BANNER
/**
 * Claim the native `session.composer.top` slot and render the peak-hours banner.
 *
 * Placement note: the V1 banner lived in `app_bottom`; the native slot tree
 * publishes no global bottom slot, so the visible warning now renders at the
 * top of the session composer while the current model's provider is in peak.
 * Disabled policy, missing slot API, or registration failure leave the TUI
 * untouched.
 */
export function registerPeakHoursBanner(
  ctx: Plugin.Context,
  policy: () => ContextPolicySnapshot | undefined,
  dependencies: Partial<PeakHoursBannerDependencies> = {},
): () => void {
  const deps: PeakHoursBannerDependencies = {
    isEnabled: () => {
      const peakHours = policyPeakHours(policy());
      return peakHours !== undefined && peakHours.enabled;
    },
    now: () => new Date(),
    entry: () => parsePeakHoursEntry(policyPeakHours(policy())).entry,
    currentModel: resolveBannerModelRef,
    connectedProviders: (context) =>
      (context.data.location.provider.list() ?? [])
        .map((provider) => provider.id)
        .filter((id): id is string => typeof id === "string"),
    renderBanner: (text, color) => (
      <text>
        <span style={{ fg: color }}>{text}</span>
      </text>
    ),
    ...dependencies,
  };

  try {
    return ctx.ui.slot({
      append: "session.composer.top",
      render: () => {
        if (!deps.isEnabled()) return <></>;
        const entry = deps.entry();
        if (!entry.enabled) return <></>;

        const modelRef = deps.currentModel(ctx);
        if (modelRef === undefined) return <></>;

        const now = deps.now();
        const peak = findActivePeak(now, entry.schedules, modelRef.providerID);
        if (peak === undefined) return <></>;

        const suggestions = suggestOffPeakProviders(
          now,
          entry.schedules,
          deps.connectedProviders(ctx),
        ).filter(
          (candidate) =>
            normalizeProviderId(candidate) !== normalizeProviderId(modelRef.providerID),
        );

        return deps.renderBanner(
          buildPeakBannerText(modelRef.providerID, peak, suggestions),
          ctx.theme.text.feedback.warning.base,
        );
      },
    });
  } catch {
    // Fail-soft: no banner for this session.
    return () => undefined;
  }
}
// END_BLOCK_REGISTER_BANNER
