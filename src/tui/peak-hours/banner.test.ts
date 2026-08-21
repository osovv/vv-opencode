// FILE: src/tui/peak-hours/banner.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify peak-hours banner text composition, model resolution, registration gating, show and hide cases, and fail-soft behavior.
//   SCOPE: Banner label with and without suggestions, current model resolution from session messages and config fallback, toggle and entry gating, peak and off-peak rendering, missing slot API tolerance, and registration failure tolerance.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, @opentui/core, src/tui/peak-hours/banner.tsx, src/lib/peak-hours.ts]
//   LINKS: [M-TUI-PEAK-HOURS-BANNER, V-M-TUI-PEAK-HOURS-BANNER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NOW - Fixed Friday 07:00 UTC evaluation instant used by default fixtures.
//   deepseekSchedules - Schedule fixture with the deepseek peak window active at NOW.
//   BannerCall - Captured banner render call shape.
//   deepseekEntry - Entry fixture with the deepseek peak windows active at NOW.
//   THEME - Minimal theme double exposing the warning color.
//   fakeApi - Builds a TuiPluginApi double with a session route, messages, providers, and slot capture.
//   makeDeps - Builds banner dependencies with a marker renderer and captured calls.
//   renderBannerSlot - Invokes the first registered app_bottom renderer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Added deterministic banner coverage without real OpenTUI rendering.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  buildPeakBannerText,
  registerPeakHoursBanner,
  resolveBannerModelRef,
  type PeakHoursBannerDependencies,
} from "./banner.js";
import type { PeakHoursEntryConfig, PeakSchedules } from "../../lib/peak-hours.js";

// Friday 2026-08-21T07:00:00Z: inside the deepseek 06:00-10:00 UTC window.
const NOW = new Date("2026-08-21T07:00:00.000Z");

const deepseekSchedules: PeakSchedules = {
  deepseek: {
    windows: [{ start: "06:00", end: "10:00", tz: "UTC" }],
  },
};

function deepseekEntry(overrides: Partial<PeakHoursEntryConfig> = {}): PeakHoursEntryConfig {
  return {
    enabled: true,
    mode: "hard",
    graceActiveSessions: true,
    schedules: deepseekSchedules,
    ...overrides,
  };
}

const THEME = {
  warning: RGBA.fromInts(255, 165, 0, 255),
};

type BannerCall = { text: string; color: RGBA };

function fakeApi(
  options: {
    messages?: Array<{ role?: string; providerID?: string; model?: { providerID?: string } }>;
    providers?: Array<{ id: string }>;
    configModel?: string;
    routeName?: string;
    slotsFail?: boolean;
    missingSlots?: boolean;
  } = {},
) {
  const registeredSlots: unknown[] = [];
  const api = {
    route: {
      current:
        options.routeName === "home"
          ? { name: "home" }
          : { name: "session", params: { sessionID: "ses_1" } },
    },
    state: {
      config: options.configModel ? { model: options.configModel } : {},
      provider: options.providers ?? [{ id: "deepseek" }, { id: "z-ai" }, { id: "qwen" }],
      session: {
        messages: () => options.messages ?? [],
      },
    },
    theme: { current: THEME },
    ...(options.missingSlots
      ? {}
      : {
          slots: {
            register: (plugin: unknown) => {
              if (options.slotsFail) throw new Error("slot registration failed");
              registeredSlots.push(plugin);
              return "vvoc-peak-hours";
            },
          },
        }),
  } as unknown as TuiPluginApi;
  return { api, registeredSlots };
}

function makeDeps(overrides: Partial<PeakHoursBannerDependencies> = {}) {
  const calls: BannerCall[] = [];
  const deps: PeakHoursBannerDependencies = {
    enabled: async () => true,
    now: () => NOW,
    entry: () => deepseekEntry(),
    currentModel: () => ({ providerID: "deepseek" }),
    connectedProviders: () => ["deepseek", "z-ai", "qwen"],
    renderBanner: (text, color) => {
      calls.push({ text, color });
      return { text, color } as never;
    },
    ...overrides,
  };
  return { deps, calls };
}

function renderBannerSlot(registeredSlots: unknown[]): unknown {
  const slot = registeredSlots[0] as {
    slots: { app_bottom: (ctx: unknown) => unknown };
  };
  return slot.slots.app_bottom({ theme: { current: THEME } });
}

describe("buildPeakBannerText", () => {
  test("includes provider, window end, and suggestions", () => {
    const text = buildPeakBannerText(
      "deepseek",
      {
        providerKey: "deepseek",
        providerID: "deepseek",
        window: {
          startMinutes: 360,
          endMinutes: 600,
          crossMidnight: false,
          tz: "UTC",
          days: [0, 1, 2, 3, 4, 5, 6],
        },
        endsAt: new Date("2026-08-21T10:00:00.000Z"),
        startedAt: new Date("2026-08-21T06:00:00.000Z"),
        minutesRemaining: 180,
      },
      ["z-ai", "qwen"],
    );
    expect(text).toContain("⚠ PEAK deepseek until 10:00 UTC");
    expect(text).toContain("off-peak now: z-ai, qwen");
  });

  test("degrades without suggestions", () => {
    const text = buildPeakBannerText(
      "deepseek",
      {
        providerKey: "deepseek",
        providerID: "deepseek",
        window: {
          startMinutes: 360,
          endMinutes: 600,
          crossMidnight: false,
          tz: "UTC",
          days: [0, 1, 2, 3, 4, 5, 6],
        },
        endsAt: new Date("2026-08-21T10:00:00.000Z"),
        startedAt: new Date("2026-08-21T06:00:00.000Z"),
        minutesRemaining: 180,
      },
      [],
    );
    expect(text).toContain("every connected provider is in peak or unscheduled");
    expect(text).not.toContain("off-peak now");
  });
});

describe("resolveBannerModelRef", () => {
  test("prefers the latest assistant providerID", () => {
    const { api } = fakeApi({
      messages: [
        { role: "user", model: { providerID: "qwen" } },
        { role: "assistant", providerID: "z-ai" },
      ],
    });
    expect(resolveBannerModelRef(api)).toEqual({ providerID: "z-ai" });
  });

  test("falls back to the latest user message model", () => {
    const { api } = fakeApi({
      messages: [
        { role: "user", model: { providerID: "qwen" } },
        { role: "user", model: { providerID: "deepseek" } },
      ],
    });
    expect(resolveBannerModelRef(api)).toEqual({ providerID: "deepseek" });
  });

  test("falls back to the config default model on an empty session", () => {
    const { api } = fakeApi({ messages: [], configModel: "z-ai/glm-5.3" });
    expect(resolveBannerModelRef(api)).toEqual({ providerID: "z-ai" });
  });

  test("returns undefined on the home route", () => {
    const { api } = fakeApi({ routeName: "home" });
    expect(resolveBannerModelRef(api)).toBeUndefined();
  });
});

describe("registerPeakHoursBanner", () => {
  test("registers and renders the banner while the current provider is in peak", async () => {
    const { api, registeredSlots } = fakeApi();
    const { deps, calls } = makeDeps();

    await registerPeakHoursBanner(api, deps);
    expect(registeredSlots).toHaveLength(1);

    const rendered = renderBannerSlot(registeredSlots);
    expect(rendered).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("⚠ PEAK deepseek until 10:00 UTC");
    expect(calls[0]?.text).toContain("off-peak now: z-ai, qwen");
    expect(calls[0]?.color).toBe(THEME.warning);
  });

  test("hides the banner outside peak windows", async () => {
    const { api, registeredSlots } = fakeApi();
    const { deps } = makeDeps({
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });

    await registerPeakHoursBanner(api, deps);
    expect(renderBannerSlot(registeredSlots)).toBeUndefined();
  });

  test("hides the banner when no model reference resolves", async () => {
    const { api, registeredSlots } = fakeApi({ routeName: "home" });
    const { deps } = makeDeps({ currentModel: () => undefined });

    await registerPeakHoursBanner(api, deps);
    expect(renderBannerSlot(registeredSlots)).toBeUndefined();
  });

  test("excludes the current provider from suggestions", async () => {
    const { api, registeredSlots } = fakeApi();
    const { deps, calls } = makeDeps({
      connectedProviders: () => ["deepseek", "qwen", "openai"],
    });

    await registerPeakHoursBanner(api, deps);
    renderBannerSlot(registeredSlots);
    expect(calls[0]?.text).toContain("off-peak now: qwen, openai");
    expect(calls[0]?.text).not.toContain(
      "deepseek until 10:00 UTC · elevated pricing · off-peak now: deepseek",
    );
  });

  test("does not register when the toggle or entry is disabled", async () => {
    const disabledToggle = fakeApi();
    await registerPeakHoursBanner(
      disabledToggle.api,
      makeDeps({ enabled: async () => false }).deps,
    );
    expect(disabledToggle.registeredSlots).toHaveLength(0);

    const disabledEntry = fakeApi();
    await registerPeakHoursBanner(
      disabledEntry.api,
      makeDeps({ entry: () => deepseekEntry({ enabled: false }) }).deps,
    );
    expect(disabledEntry.registeredSlots).toHaveLength(1);
    expect(renderBannerSlot(disabledEntry.registeredSlots)).toBeUndefined();
  });

  test("tolerates a missing slot API and registration failures", async () => {
    const missing = fakeApi({ missingSlots: true });
    await registerPeakHoursBanner(missing.api, makeDeps().deps);
    expect(missing.registeredSlots).toHaveLength(0);

    const failing = fakeApi({ slotsFail: true });
    await expect(registerPeakHoursBanner(failing.api, makeDeps().deps)).resolves.toBeUndefined();
  });

  test("registers with the expected plugin id and order", async () => {
    const { api, registeredSlots } = fakeApi();
    await registerPeakHoursBanner(api, makeDeps().deps);
    const plugin = registeredSlots[0] as { id: string; order: number };
    expect(plugin.id).toBe("vvoc-peak-hours");
    expect(plugin.order).toBe(100);
  });
});
