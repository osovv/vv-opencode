// FILE: src/tui/analytics/indicator.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a live per-session cache hit rate indicator in the OpenCode session prompt slot.
//   SCOPE: Rolling step-finish accumulator, tone thresholds and label text, toggle-gated registration, session-filtered event subscription, and fail-soft slot rendering.
//   DEPENDS: [@opencode-ai/plugin/tui, @opencode-ai/sdk, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/lib/analytics/types.ts]
//   LINKS: [M-TUI-ANALYTICS-INDICATOR, M-ANALYTICS-TYPES, M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   IndicatorLabel - Label text plus color tone for the current indicator state.
//   StepFinishLike - Structural step-finish part shape accepted from either SDK generation.
//   createIndicatorAccumulator - Rolling per-session sums fed by step-finish parts.
//   indicatorLabel - Label and tone for the current state with threshold colors.
//   registerAnalyticsIndicator - Registers the live session_prompt_right indicator.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added live cache hit rate indicator for the session prompt slot.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { PluginOptions } from "@opencode-ai/plugin";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import type { IndicatorTokens } from "../../lib/analytics/types.js";

/** Structural step-finish shape accepted from either SDK generation. */
export type StepFinishLike = {
  type: string;
  tokens?: { input?: unknown; cache?: { read?: unknown; write?: unknown } };
};

export type IndicatorLabel = {
  text: string;
  tone: "muted" | "red" | "yellow" | "green";
};

export type IndicatorDependencies = {
  enabled: (api: TuiPluginApi) => Promise<boolean>;
  /** Renders the label node; defaults to the themed span. */
  renderLabel: (label: IndicatorLabel, color: string) => JSX.Element;
};

const DEFAULT_DEPENDENCIES: IndicatorDependencies = {
  enabled: async (api) => {
    const vvoc = await loadVvocConfigForRead({
      scope: "effective",
      allowDefault: true,
      cwd: api.state.path.directory,
    });
    return isVvocPluginEnabled(vvoc.config, "analytics");
  },
  renderLabel: (label, color) => <span style={{ color }}>{label.text}</span>,
};

// START_BLOCK_INDICATOR_ACCUMULATOR
/** Rolling per-session sums fed by step-finish parts. Same eligibility rule as metrics. */
export function createIndicatorAccumulator(): {
  applyPart(part: StepFinishLike): void;
  get(): IndicatorTokens;
} {
  let state: IndicatorTokens = {
    steps: 0,
    eligibleSteps: 0,
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
  };
  return {
    applyPart(part: StepFinishLike) {
      if (part.type !== "step-finish") return;
      const tokens = (part.tokens ?? {}) as {
        input?: unknown;
        cache?: { read?: unknown; write?: unknown };
      };
      const cacheRead = toCount(tokens.cache?.read);
      const cacheWrite = toCount(tokens.cache?.write);
      state = {
        steps: state.steps + 1,
        eligibleSteps: state.eligibleSteps + (cacheRead + cacheWrite > 0 ? 1 : 0),
        cacheRead: state.cacheRead + cacheRead,
        cacheWrite: state.cacheWrite + cacheWrite,
        input: state.input + toCount(tokens.input),
      };
    },
    get: () => state,
  };
}

/** Label and tone for the current state; muted "cache n/a" until the first eligible step. */
export function indicatorLabel(state: IndicatorTokens): IndicatorLabel {
  if (state.eligibleSteps === 0) return { text: "cache n/a", tone: "muted" };
  const rate = state.cacheRead / (state.cacheRead + state.cacheWrite + state.input);
  const tone = rate >= 0.8 ? "green" : rate >= 0.5 ? "yellow" : "red";
  return { text: `cache ${(rate * 100).toFixed(0)}%`, tone };
}

/** Normalizes an untrusted token counter to a finite non-negative number. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
// END_BLOCK_INDICATOR_ACCUMULATOR

// START_BLOCK_REGISTER_INDICATOR
/**
 * Registers the live indicator for the current session route.
 * Disabled toggle or options.enabled === false: returns without subscribing or
 * registering. Subscribes to message.part.updated (session-filtered), renders
 * through the "session_prompt_right" host slot, and cleans up the subscription
 * via api.lifecycle.onDispose. Slot registration failures disable the visual
 * element silently for the session.
 */
export async function registerAnalyticsIndicator(
  api: TuiPluginApi,
  options?: PluginOptions,
  dependencies: IndicatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (options?.enabled === false) return;
  if (!(await dependencies.enabled(api))) return;

  const accumulator = createIndicatorAccumulator();
  const unsubscribe = api.event.on("message.part.updated", (event) => {
    const sessionID = currentSessionID(api);
    if (event.properties.part.sessionID === sessionID) {
      accumulator.applyPart(event.properties.part);
    }
  });
  api.lifecycle.onDispose(unsubscribe);

  try {
    api.slots.register({
      slots: {
        session_prompt_right: (_ctx, props) => {
          if (props.session_id !== currentSessionID(api)) return undefined;
          const label = indicatorLabel(accumulator.get());
          if (label.tone === "muted") return undefined;
          return dependencies.renderLabel(label, toneColor(api, label.tone));
        },
      },
    });
  } catch {
    // Fail-soft: no indicator for this session.
  }
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

/** Maps an indicator tone to a theme color expression. */
function toneColor(api: TuiPluginApi, tone: IndicatorLabel["tone"]): string {
  const theme = api.theme.current;
  const rgba =
    tone === "green"
      ? theme.success
      : tone === "yellow"
        ? theme.warning
        : tone === "red"
          ? theme.error
          : theme.textMuted;
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`;
}
// END_BLOCK_REGISTER_INDICATOR
