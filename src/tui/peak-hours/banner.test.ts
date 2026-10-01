// FILE: src/tui/peak-hours/banner.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native composer-top peak-hours banner: text composition, model resolution, policy-gated registration, placement, and fail-soft behavior.
//   SCOPE: Pure text helpers plus a structural native context double; no host process.
//   DEPENDS: [bun:test, @opentui/core, @opencode/plugin/tui, src/tui/peak-hours/banner.tsx, src/tui/policy.ts]
//   LINKS: [V-M-TUI-PEAK-HOURS-BANNER, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PEAK - Active peak window fixture.
//   peakPolicy - Build a context policy with peak-hours enabled.
//   fakeContext - Minimal native context double that records banner claims.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Rewrote banner coverage for the native composer-top claim and policy-driven schedule.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
import type { ActivePeak } from "../../lib/peak-hours.js";
import { buildPeakBannerText, registerPeakHoursBanner, resolveBannerModelRef } from "./banner.js";
import type { ContextPolicySnapshot } from "../policy.js";

const PEAK: ActivePeak = {
  providerKey: "deepseek",
  providerID: "deepseek",
  window: {
    startMinutes: 60,
    endMinutes: 240,
    crossMidnight: false,
    tz: "UTC",
    days: [0, 1, 2, 3, 4, 5, 6],
  },
  endsAt: new Date(Date.UTC(2026, 0, 1, 4, 0, 0)),
  startedAt: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)),
  minutesRemaining: 120,
};

function peakPolicy(enabled = true): ContextPolicySnapshot {
  return {
    status: "preview",
    scope: "current-runtime",
    contextEnabled: true,
    analyticsEnabled: true,
    peakHours: {
      enabled,
      mode: "soft",
      graceActiveSessions: true,
      schedules: { deepseek: { windows: [{ start: "01:00", end: "04:00", tz: "UTC" }] } },
    },
  };
}

function fakeContext(
  options: {
    model?: { providerID: string; modelID: string } | undefined;
    providers?: string[];
    route?: "session" | "home";
    slotFails?: boolean;
  } = {},
) {
  const claims: Array<{ claim: unknown; render: (input: { sessionID: string }) => unknown }> = [];
  const context = {
    theme: { text: { feedback: { warning: { base: RGBA.fromInts(255, 200, 0, 255) } } } },
    ui: {
      model: { current: () => options.model },
      router: {
        current: () =>
          options.route === "home" ? { type: "home" } : { type: "session", sessionID: "ses_1" },
      },
      slot: (claim: unknown) => {
        if (options.slotFails) throw new Error("slot registration failed");
        const record = claim as { render: (input: { sessionID: string }) => unknown };
        claims.push({ claim, render: record.render });
        return () => undefined;
      },
    },
    data: {
      session: {
        message: {
          list: () => [
            { type: "user", model: { providerID: "qwen", modelID: "chat" } },
            { type: "assistant", model: { providerID: "deepseek", modelID: "chat" } },
          ],
        },
      },
      location: {
        provider: { list: () => (options.providers ?? []).map((id) => ({ id })) },
      },
    },
  } as unknown as Plugin.Context;
  return { context, claims };
}

describe("buildPeakBannerText", () => {
  test("includes provider, window end, and suggestions", () => {
    const text = buildPeakBannerText("deepseek", PEAK, ["qwen"]);
    expect(text).toContain("PEAK deepseek");
    expect(text).toContain("off-peak now: qwen");
    expect(text).toContain("elevated pricing");
  });

  test("degrades without suggestions", () => {
    const text = buildPeakBannerText("deepseek", PEAK, []);
    expect(text).toContain("every connected provider is in peak or unscheduled");
  });
});

describe("resolveBannerModelRef", () => {
  test("prefers the selected native model", () => {
    const { context } = fakeContext({ model: { providerID: "z-ai", modelID: "glm" } });
    expect(resolveBannerModelRef(context)).toEqual({ providerID: "z-ai" });
  });

  test("falls back to the latest model-bearing message", () => {
    const { context } = fakeContext();
    expect(resolveBannerModelRef(context)).toEqual({ providerID: "deepseek" });
  });

  test("returns undefined on the home route without a selection", () => {
    const { context } = fakeContext({ route: "home" });
    expect(resolveBannerModelRef(context)).toBeUndefined();
  });
});

describe("registerPeakHoursBanner", () => {
  test("claims the native composer-top slot and renders while the provider is in peak", () => {
    const { context, claims } = fakeContext({
      model: { providerID: "deepseek", modelID: "chat" },
      providers: ["deepseek", "qwen"],
    });
    const marked: string[] = [];
    registerPeakHoursBanner(context, () => peakPolicy(), {
      now: () => new Date(Date.UTC(2026, 0, 1, 2, 0, 0)),
      renderBanner: (text) => {
        marked.push(text);
        return { text } as never;
      },
    });
    expect((claims[0]!.claim as { append?: string }).append).toBe("session.composer.top");
    const rendered = claims[0]!.render({ sessionID: "ses_1" }) as { text: string };
    expect(rendered.text).toContain("PEAK deepseek");
    expect(rendered.text).toContain("qwen");
    expect(marked).toHaveLength(1);
  });

  test("hides the banner outside peak windows", () => {
    const { context, claims } = fakeContext({ model: { providerID: "deepseek", modelID: "chat" } });
    registerPeakHoursBanner(context, () => peakPolicy(), {
      now: () => new Date(Date.UTC(2026, 0, 1, 8, 0, 0)),
      renderBanner: () => ({ marker: true }) as never,
    });
    const rendered = claims[0]!.render({ sessionID: "ses_1" });
    expect((rendered as { marker?: boolean }).marker).toBeUndefined();
  });

  test("hides the banner when no model reference resolves", () => {
    const { context, claims } = fakeContext({ route: "home" });
    registerPeakHoursBanner(context, () => peakPolicy(), {
      now: () => new Date(Date.UTC(2026, 0, 1, 2, 0, 0)),
      renderBanner: () => ({ marker: true }) as never,
    });
    const rendered = claims[0]!.render({ sessionID: "ses_1" });
    expect((rendered as { marker?: boolean }).marker).toBeUndefined();
  });

  test("disabled policy registers but never renders the warning", () => {
    const { context, claims } = fakeContext({ model: { providerID: "deepseek", modelID: "chat" } });
    registerPeakHoursBanner(context, () => peakPolicy(false), {
      now: () => new Date(Date.UTC(2026, 0, 1, 2, 0, 0)),
      renderBanner: () => ({ marker: true }) as never,
    });
    const rendered = claims[0]!.render({ sessionID: "ses_1" });
    expect((rendered as { marker?: boolean }).marker).toBeUndefined();
  });

  test("tolerates slot registration failures", () => {
    const { context } = fakeContext({ slotFails: true });
    expect(() => registerPeakHoursBanner(context, () => peakPolicy())).not.toThrow();
  });
});
