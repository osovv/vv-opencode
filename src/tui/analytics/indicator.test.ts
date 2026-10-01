// FILE: src/tui/analytics/indicator.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native usage accumulator, label thresholds, policy gating, session filtering, slot claim shape, and fail-soft registration.
//   SCOPE: Pure accumulator/label boundaries plus a structural native context double; no host process.
//   DEPENDS: [bun:test, @opentui/core, @opencode/plugin/tui, src/tui/analytics/indicator.tsx, src/tui/policy.ts]
//   LINKS: [V-M-TUI-ANALYTICS-INDICATOR, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   state - Build an IndicatorTokens fixture.
//   usageEvent - Build a native session.usage.updated event.
//   fakeContext - Minimal native context double that records slot claims.
//   allEnabledPolicy - Context policy snapshot with every feature enabled.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Rewrote indicator coverage for native usage events, policy gating, and the prompt.footer.status claim.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
import {
  createIndicatorAccumulator,
  indicatorLabel,
  registerAnalyticsIndicator,
  type IndicatorTokens,
} from "./indicator.js";
import { createPolicyController, type ContextPolicySnapshot } from "../policy.js";

function state(overrides: Partial<IndicatorTokens> = {}): IndicatorTokens {
  return { steps: 0, eligibleSteps: 0, cacheRead: 0, cacheWrite: 0, input: 0, ...overrides };
}

function usageEvent(sessionID: string, usage: { input: number; read: number; write: number }) {
  return {
    type: "session.usage.updated" as const,
    data: {
      sessionID,
      cost: 0,
      tokens: {
        input: usage.input,
        output: 0,
        reasoning: 0,
        cache: { read: usage.read, write: usage.write },
      },
    },
  };
}

describe("createIndicatorAccumulator", () => {
  test("counts each usage event once with eligibility", () => {
    const accumulator = createIndicatorAccumulator();
    accumulator.applyUsage({ input: 100, cache: { read: 900, write: 100 } });
    accumulator.applyUsage({ input: 50, cache: { read: 0, write: 0 } });
    expect(accumulator.get()).toEqual(
      state({ steps: 2, eligibleSteps: 1, cacheRead: 900, cacheWrite: 100, input: 150 }),
    );
  });

  test("ignores non-finite counters", () => {
    const accumulator = createIndicatorAccumulator();
    accumulator.applyUsage({ input: Number.NaN, cache: { read: -5, write: "x" } });
    expect(accumulator.get()).toEqual(state({ steps: 1 }));
  });
});

describe("indicatorLabel", () => {
  test("returns muted n/a before any eligible step", () => {
    expect(indicatorLabel(state({ steps: 3 }))).toEqual({ text: "cache n/a", tone: "muted" });
  });

  test("green at >= 80 percent, yellow at >= 50, red below", () => {
    const at = (rate: number) =>
      state({ eligibleSteps: 1, cacheRead: rate * 1000, cacheWrite: 0, input: (1 - rate) * 1000 });
    expect(indicatorLabel(at(0.8)).tone).toBe("green");
    expect(indicatorLabel(at(0.95)).text).toBe("cache 95%");
    expect(indicatorLabel(at(0.5)).tone).toBe("yellow");
    expect(indicatorLabel(at(0.79)).tone).toBe("yellow");
    expect(indicatorLabel(at(0.49)).tone).toBe("red");
  });
});

function fakeContext(options: { slotFails?: boolean } = {}) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const claims: Array<{ claim: unknown; render: (input: { sessionID?: string }) => unknown }> = [];
  const theme = {
    text: {
      muted: RGBA.fromInts(128, 128, 128, 255),
      feedback: {
        success: { base: RGBA.fromInts(0, 255, 0, 255) },
        warning: { base: RGBA.fromInts(255, 255, 0, 255) },
        error: { base: RGBA.fromInts(255, 0, 0, 255) },
      },
    },
  };
  const context = {
    theme,
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        return () =>
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((entry) => entry !== handler),
          );
      },
    },
    ui: {
      slot: (claim: unknown) => {
        if (options.slotFails) throw new Error("slot registration failed");
        const record = claim as { render: (input: { sessionID?: string }) => unknown };
        claims.push({ claim, render: record.render });
        return () => undefined;
      },
    },
  } as unknown as Plugin.Context;

  const emit = (event: unknown): void => {
    const type = (event as { type: string }).type;
    for (const handler of listeners.get(type) ?? []) handler(event);
  };
  return { context, emit, claims, theme };
}

function allEnabledPolicy(): ContextPolicySnapshot {
  return {
    status: "preview",
    scope: "current-runtime",
    contextEnabled: true,
    analyticsEnabled: true,
    peakHours: { enabled: false, mode: "soft", graceActiveSessions: true, schedules: {} },
  };
}

describe("registerAnalyticsIndicator", () => {
  test("claims the prompt footer status slot and filters by session", () => {
    const { context, emit, claims } = fakeContext();
    const marked: Array<{ text: string; color: RGBA }> = [];
    registerAnalyticsIndicator(context, allEnabledPolicy, undefined, {
      renderLabel: (label, color) => {
        marked.push({ text: label.text, color });
        return { label, color } as never;
      },
    });

    expect((claims[0]!.claim as { append?: string }).append).toBe("prompt.footer.status");
    emit(usageEvent("ses_other", { input: 100, read: 900, write: 100 }));
    expect(claims[0]!.render({ sessionID: "ses_1" })).toBeTruthy();

    emit(usageEvent("ses_1", { input: 100, read: 900, write: 100 }));
    const element = claims[0]!.render({ sessionID: "ses_1" }) as {
      label: { text: string };
      color: RGBA;
    };
    expect(element.label.text).toBe("cache 82%");
    expect(marked).toHaveLength(1);
  });

  test("renders nothing while muted or before any usage", () => {
    const { context, claims } = fakeContext();
    registerAnalyticsIndicator(context, allEnabledPolicy, undefined, {
      renderLabel: () => ({ marker: true }) as never,
    });
    const rendered = claims[0]!.render({ sessionID: "ses_1" });
    expect(typeof rendered).toBe("object");
    expect((rendered as { marker?: boolean }).marker).toBeUndefined();
  });

  test("disabled analytics policy keeps the slot claimed but renders nothing", () => {
    const { context, claims, emit } = fakeContext();
    const disabled: ContextPolicySnapshot = {
      status: "preview",
      scope: "current-runtime",
      contextEnabled: true,
      analyticsEnabled: false,
      peakHours: { enabled: false, mode: "soft", graceActiveSessions: true, schedules: {} },
    };
    registerAnalyticsIndicator(context, () => disabled, undefined, {});
    expect(claims).toHaveLength(1);
    emit(usageEvent("ses_1", { input: 100, read: 900, write: 100 }));
    const rendered = claims[0]!.render({ sessionID: "ses_1" });
    expect((rendered as { marker?: boolean }).marker).toBeUndefined();
  });

  test("options.enabled === false skips registration", () => {
    const { context, claims } = fakeContext();
    registerAnalyticsIndicator(context, allEnabledPolicy, { enabled: false }, {});
    expect(claims).toHaveLength(0);
  });

  test("slot registration failure does not propagate", () => {
    const { context } = fakeContext({ slotFails: true });
    expect(() =>
      registerAnalyticsIndicator(context, allEnabledPolicy, undefined, {}),
    ).not.toThrow();
  });

  test("policy controller from the shared store gates the indicator", async () => {
    const controller = createPolicyController(async () => undefined);
    await controller.refresh({ sessionID: "ses_1", directory: "/a" });
    const snapshot = controller.current();
    expect(snapshot?.status).toBe("unavailable");
    controller.dispose();
  });
});
