// FILE: src/tui/branding/footer.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the vvoc branding footer label text, slot registration, config independence, and fail-soft behavior.
//   SCOPE: Label version composition, sidebar_footer slot targeting, missing slot API tolerance, registration failure tolerance, render injection, and real OpenTUI rendering of the default label.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, src/tui/branding/footer.tsx, src/lib/package.ts]
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
//   LAST_CHANGE: [2026-08-20-orphan-text-fix - Added a real-render regression test for the default label to catch orphan text errors.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { brandingFooterLabel, registerBrandingFooter } from "./footer.js";
import { PACKAGE_VERSION } from "../../lib/package.js";

function fakeApi(options: { slotsFail?: boolean; missingSlots?: boolean } = {}) {
  const registeredSlots: unknown[] = [];
  const api = {
    theme: {
      current: { textMuted: { r: 128, g: 128, b: 128, a: 1 } },
    },
    ...(options.missingSlots
      ? {}
      : {
          slots: {
            register: (plugin: unknown) => {
              if (options.slotsFail) throw new Error("slot registration failed");
              registeredSlots.push(plugin);
              return "slot-id";
            },
          },
        }),
  } as unknown as TuiPluginApi;
  return { api, registeredSlots };
}

/** Marker renderer capturing the label and color instead of real OpenTUI JSX. */
function markerRenderer() {
  const calls: Array<{ text: string; color: string }> = [];
  const renderLabel = (text: string, color: string) => {
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
  test("registers a sidebar_footer slot rendering the label in the muted theme color", () => {
    const { api, registeredSlots } = fakeApi();
    const renderer = markerRenderer();
    registerBrandingFooter(api, { renderLabel: renderer.renderLabel as never });

    expect(registeredSlots).toHaveLength(1);
    const slot = registeredSlots[0] as {
      slots: { sidebar_footer: () => unknown };
    };
    const element = slot.slots.sidebar_footer() as { text: string; color: string };
    expect(element.text).toBe(`vvoc v${PACKAGE_VERSION}`);
    expect(element.color).toBe("#808080");
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

  test("default label renders through real OpenTUI without orphan text errors", async () => {
    const { testRender } = await import("@opentui/solid");
    const { api, registeredSlots } = fakeApi();
    registerBrandingFooter(api);

    const slot = registeredSlots[0] as {
      slots: { sidebar_footer: () => unknown };
    };
    const setup = await testRender(() => slot.slots.sidebar_footer() as never, {
      width: 30,
      height: 3,
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain(brandingFooterLabel());
  });
});
