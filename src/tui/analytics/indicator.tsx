// FILE: src/tui/analytics/indicator.tsx
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a live per-session cache hit rate indicator in the native session prompt footer status slot.
//   SCOPE: Native usage-event accumulator, tone thresholds and label text, policy-gated registration, session-filtered event subscription, and fail-soft slot rendering with lifecycle cleanup.
//   DEPENDS: [@opencode/plugin/tui, @opentui/core, src/tui/policy.ts]
//   LINKS: [M-TUI-ANALYTICS-INDICATOR, M-PLUGIN-ANALYTICS, M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   IndicatorTokens - Rolling per-session token sums.
//   IndicatorLabel - Label text plus color tone for the current indicator state.
//   AnalyticsIndicatorDependencies - Injectable enablement and label renderer dependencies for focused tests.
//   IndicatorUsageLike - Structural native usage payload accepted by the accumulator.
//   createIndicatorAccumulator - Rolling per-session sums fed by native usage events.
//   indicatorLabel - Label and tone for the current state with threshold colors.
//   registerAnalyticsIndicator - Register the live prompt-footer indicator and return its disposer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Claims the slot before the policy resolves so the indicator appears once analytics is enabled, gated at render time.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import type { ContextPolicySnapshot } from "../policy.js";
import { policyAnalyticsEnabled } from "../policy.js";

export type IndicatorTokens = {
  steps: number;
  eligibleSteps: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
};

export type IndicatorLabel = {
  text: string;
  tone: "muted" | "red" | "yellow" | "green";
};

/** Structural native usage payload accepted by the accumulator. */
export type IndicatorUsageLike = {
  input?: unknown;
  cache?: { read?: unknown; write?: unknown } | undefined;
};

export type AnalyticsIndicatorDependencies = {
  isEnabled: () => boolean;
  renderLabel: (label: IndicatorLabel, color: RGBA) => JSX.Element;
};

// START_BLOCK_INDICATOR_ACCUMULATOR
/** Rolling per-session sums fed by native usage events. */
export function createIndicatorAccumulator(): {
  applyUsage(usage: IndicatorUsageLike): void;
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
    applyUsage(usage) {
      const cacheRead = toCount(usage.cache?.read);
      const cacheWrite = toCount(usage.cache?.write);
      state = {
        steps: state.steps + 1,
        eligibleSteps: state.eligibleSteps + (cacheRead + cacheWrite > 0 ? 1 : 0),
        cacheRead: state.cacheRead + cacheRead,
        cacheWrite: state.cacheWrite + cacheWrite,
        input: state.input + toCount(usage.input),
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
 * Register the live indicator for the active session in the native
 * `prompt.footer.status` slot (the native placement for the old
 * `session_prompt_right` slot). Disabled policy: no subscription and no slot.
 * Returns a disposer that unsubscribes and removes the claim.
 */
export function registerAnalyticsIndicator(
  ctx: Plugin.Context,
  policy: () => ContextPolicySnapshot | undefined,
  options: Readonly<Record<string, unknown>> | undefined,
  dependencies?: Partial<AnalyticsIndicatorDependencies>,
): () => void {
  if (options?.enabled === false) return () => undefined;
  const deps: AnalyticsIndicatorDependencies = {
    isEnabled: () => policyAnalyticsEnabled(policy()),
    renderLabel: (label, color) => (
      <text>
        <span style={{ fg: color }}>{label.text}</span>
      </text>
    ),
    ...dependencies,
  };
  // The slot is claimed even while the policy is still loading, so the
  // indicator appears as soon as an allowlisted policy enables analytics
  // without needing a plugin reload. Rendering stays policy-gated below.

  const accumulators = new Map<string, ReturnType<typeof createIndicatorAccumulator>>();
  const [tokensBySession, setTokensBySession] = createSignal<Record<string, IndicatorTokens>>({});
  const unsubscribe = ctx.data.on("session.usage.updated", (event) => {
    const sessionID = event.data.sessionID;
    let accumulator = accumulators.get(sessionID);
    if (accumulator === undefined) {
      accumulator = createIndicatorAccumulator();
      accumulators.set(sessionID, accumulator);
    }
    accumulator.applyUsage({
      input: event.data.tokens.input,
      cache: { read: event.data.tokens.cache.read, write: event.data.tokens.cache.write },
    });
    setTokensBySession((prev) => ({ ...prev, [sessionID]: accumulator.get() }));
  });

  let unregister: (() => void) | undefined;
  try {
    unregister = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        if (!deps.isEnabled()) return <></>;
        const sessionID = input.sessionID;
        if (sessionID === undefined) return <></>;
        const tokens = tokensBySession()[sessionID];
        if (tokens === undefined) return <></>;
        const label = indicatorLabel(tokens);
        if (label.tone === "muted") return <></>;
        return deps.renderLabel(label, toneColor(ctx, label.tone));
      },
    });
  } catch {
    // Fail-soft: no indicator for this session.
  }

  return () => {
    unsubscribe();
    unregister?.();
  };
}

/** Maps an indicator tone to a native theme feedback color. */
function toneColor(ctx: Plugin.Context, tone: IndicatorLabel["tone"]): RGBA {
  const feedback = ctx.theme.text.feedback;
  if (tone === "green") return feedback.success.base;
  if (tone === "yellow") return feedback.warning.base;
  if (tone === "red") return feedback.error.base;
  return ctx.theme.text.muted;
}
// END_BLOCK_REGISTER_INDICATOR
