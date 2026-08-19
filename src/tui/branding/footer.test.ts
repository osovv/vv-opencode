// FILE: src/tui/branding/footer.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the vvoc branding label text, app_bottom slot registration, config independence, fail-soft behavior, and real OpenTUI rendering with the theme color applied.
//   SCOPE: Label version composition, app_bottom slot targeting with plugin id, missing slot API tolerance, registration failure tolerance, render injection, and fg color application through captureSpans.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, @opentui/core, @opentui/solid, src/tui/branding/footer.tsx, src/lib/package.ts]
//   LINKS: [M-TUI-BRANDING-FOOTER, V-M-TUI-BRANDING-FOOTER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   fakeApi - Builds a minimal TuiPluginApi double with recording hooks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-21-slot-mode-fix - Coverage now targets app_bottom, plugin id, and the applied fg color.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { RGBA } from "@opentui/core";
import { brandingFooterLabel, registerBrandingFooter } from "./footer.js";
import { PACKAGE_VERSION } from "../../lib/package.js";

const MUTED = RGBA.fromInts(128, 128, 128, 255);

function fakeApi(options: { slotsFail?: boolean; missingSlots?: boolean } = {}) {
  const registeredSlots: unknown[] = [];
  const api = {
    theme: {
      current: { textMuted: MUTED },
    },
    ...(options.missingSlots
      ? {}
      : {
          slots: {
            register: (plugin: unknown) => {
              if (options.slotsFail) throw new Error("slot registration failed");
              registeredSlots.push(plugin);
              return () => {};
            },
          },
        }),
  } as unknown as TuiPluginApi;
  return { api, registeredSlots };
}

/** Marker renderer capturing the label and color instead of real OpenTUI JSX. */
function markerRenderer() {
  const calls: Array<{ text: string; color: RGBA }> = [];
  const renderLabel = (text: string, color: RGBA) => {
    calls.push({ text, color });
    return { text, color };
  };
  return { renderLabel, calls };
}

describe("brandingFooterLabel", () => {
  test("returns vvoc v followed by the current package version", () => {
    expect(brandingFooterLabel()).toBe(`vvoc v${PACKAGE_VERSION}`);
  });
});

describe("registerBrandingFooter", () => {
  test("registers an identified app_bottom slot rendering the label with the theme color", () => {
    const { api, registeredSlots } = fakeApi();
    const renderer = markerRenderer();
    registerBrandingFooter(api, { renderLabel: renderer.renderLabel as never });

    expect(registeredSlots).toHaveLength(1);
    const plugin = registeredSlots[0] as {
      id: string;
      slots: { app_bottom: (ctx: { theme: { current: { textMuted: RGBA } } }) => unknown };
    };
    expect(plugin.id).toBe("vvoc-branding");
    const element = plugin.slots.app_bottom({ theme: { current: { textMuted: MUTED } } }) as {
      text: string;
      color: RGBA;
    };
    expect(element.text).toBe(`vvoc v${PACKAGE_VERSION}`);
    expect(element.color).toBe(MUTED);
  });

  test("returns silently when api.slots is missing", () => {
    const { api } = fakeApi({ missingSlots: true });
    expect(() => registerBrandingFooter(api)).not.toThrow();
  });

  test("returns silently when slot registration throws", () => {
    const { api } = fakeApi({ slotsFail: true });
    expect(() => registerBrandingFooter(api)).not.toThrow();
  });

  test("does not read analytics config", () => {
    const { api } = fakeApi();
    const state = api as unknown as { state?: unknown };
    expect(state.state).toBeUndefined();
    registerBrandingFooter(api, { renderLabel: markerRenderer().renderLabel as never });
  });

  test("default label renders through real OpenTUI with the muted fg color applied", async () => {
    const { testRender } = await import("@opentui/solid");
    const { api, registeredSlots } = fakeApi();
    registerBrandingFooter(api);

    const plugin = registeredSlots[0] as {
      slots: { app_bottom: (ctx: { theme: { current: { textMuted: RGBA } } }) => unknown };
    };
    const setup = await testRender(
      () => plugin.slots.app_bottom({ theme: { current: { textMuted: MUTED } } }) as never,
      { width: 30, height: 3 },
    );
    await setup.flush();
    expect(setup.captureCharFrame()).toContain(brandingFooterLabel());
    const spans = setup.captureSpans() as unknown as {
      lines: Array<{ spans: Array<{ text: string; fg: { buffer: Record<string, number> } }> }>;
    };
    const span = spans.lines
      .flatMap((line) => line.spans)
      .find((entry) => entry.text.includes("vvoc"));
    expect(span).toBeDefined();
    expect(Math.round(span!.fg.buffer["0"])).toBe(128);
    expect(span).toBeDefined();
    expect(Math.round(span!.fg.buffer["1"])).toBe(128);
    expect(span).toBeDefined();
    expect(Math.round(span!.fg.buffer["2"])).toBe(128);
  });
});
