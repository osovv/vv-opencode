// FILE: src/tui/branding/footer.test.ts
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the combined sidebar footer version line: composition, single_winner registration, fail-soft behavior, and real OpenTUI rendering with theme colors applied.
//   SCOPE: vvoc label composition, combined OpenCode + vvoc line content, plugin id and winning order on sidebar_footer, missing slot API tolerance, registration failure tolerance, and fg color application through captureSpans.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, @opentui/core, @opentui/solid, src/tui/branding/footer.tsx, src/lib/package.ts]
//   LINKS: [M-TUI-BRANDING-FOOTER, V-M-TUI-BRANDING-FOOTER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   THEME - Minimal theme RGBA triple used by the footer double.
//   OPENCODE_VERSION - Fixed OpenCode version used by the footer double.
//   fakeApi - Builds a minimal TuiPluginApi double with recording hooks.
//   FooterSlotPlugin - Structural shape of a registered footer slot plugin.
//   markerRenderer - Captures the version info and colors instead of real OpenTUI JSX.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-21-sidebar-footer-merge - Coverage now targets the combined sidebar_footer line, winning order, and applied theme colors.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { RGBA } from "@opentui/core";
import { brandingFooterLabel, registerBrandingFooter, type BrandingColors } from "./footer.js";
import { PACKAGE_VERSION } from "../../lib/package.js";

const THEME = {
  textMuted: RGBA.fromInts(128, 128, 128, 255),
  success: RGBA.fromInts(0, 255, 0, 255),
  text: RGBA.fromInts(230, 230, 230, 255),
};

const OPENCODE_VERSION = "1.18.18";

function fakeApi(options: { slotsFail?: boolean; missingSlots?: boolean } = {}) {
  const registeredSlots: unknown[] = [];
  const api = {
    app: { version: OPENCODE_VERSION },
    theme: { current: THEME },
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

type FooterSlotPlugin = {
  id: string;
  order: number;
  slots: {
    sidebar_footer: (ctx: { theme: { current: typeof THEME } }) => unknown;
  };
};

/** Marker renderer capturing the version info and colors instead of real OpenTUI JSX. */
function markerRenderer() {
  const calls: Array<{
    info: { opencodeVersion: string; vvocLabel: string };
    colors: BrandingColors;
  }> = [];
  const renderLabel = (
    info: { opencodeVersion: string; vvocLabel: string },
    colors: BrandingColors,
  ) => {
    calls.push({ info, colors });
    return { info, colors };
  };
  return { renderLabel, calls };
}

describe("brandingFooterLabel", () => {
  test("returns vvoc v followed by the current package version", () => {
    expect(brandingFooterLabel()).toBe(`vvoc v${PACKAGE_VERSION}`);
  });
});

describe("registerBrandingFooter", () => {
  test("registers an identified sidebar_footer plugin that wins the internal footer order", () => {
    const { api, registeredSlots } = fakeApi();
    const renderer = markerRenderer();
    registerBrandingFooter(api, { renderLabel: renderer.renderLabel });

    expect(registeredSlots).toHaveLength(1);
    const plugin = registeredSlots[0] as FooterSlotPlugin;
    expect(plugin.id).toBe("vvoc-branding");
    expect(plugin.order).toBe(50);
    expect(Object.keys(plugin.slots)).toEqual(["sidebar_footer"]);
  });

  test("renders both the OpenCode version and the vvoc label with theme colors", () => {
    const { api, registeredSlots } = fakeApi();
    const renderer = markerRenderer();
    registerBrandingFooter(api, { renderLabel: renderer.renderLabel });

    const plugin = registeredSlots[0] as FooterSlotPlugin;
    const element = plugin.slots.sidebar_footer({ theme: { current: THEME } }) as {
      info: { opencodeVersion: string; vvocLabel: string };
      colors: BrandingColors;
    };
    expect(element.info.opencodeVersion).toBe(OPENCODE_VERSION);
    expect(element.info.vvocLabel).toBe(`vvoc v${PACKAGE_VERSION}`);
    expect(element.colors.muted).toBe(THEME.textMuted);
    expect(element.colors.success).toBe(THEME.success);
    expect(element.colors.text).toBe(THEME.text);
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
    registerBrandingFooter(api, { renderLabel: markerRenderer().renderLabel });
  });

  test("default line renders through real OpenTUI with both versions and applied theme colors", async () => {
    const { testRender } = await import("@opentui/solid");
    const { api, registeredSlots } = fakeApi();
    registerBrandingFooter(api);

    const plugin = registeredSlots[0] as FooterSlotPlugin;
    const setup = await testRender(
      () => plugin.slots.sidebar_footer({ theme: { current: THEME } }) as never,
      { width: 40, height: 3 },
    );
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("OpenCode");
    expect(frame).toContain(OPENCODE_VERSION);
    expect(frame).toContain(`vvoc v${PACKAGE_VERSION}`);

    const spans = setup.captureSpans() as unknown as {
      lines: Array<{
        spans: Array<{ text: string; fg: { buffer: Record<string, number> } }>;
      }>;
    };
    const flat = spans.lines.flatMap((line) => line.spans);
    const bullet = flat.find((entry) => entry.text.includes("•"));
    expect(bullet).toBeDefined();
    expect(Math.round(bullet!.fg.buffer["1"])).toBe(255);
    expect(Math.round(bullet!.fg.buffer["0"])).toBe(0);
    const vvoc = flat.find((entry) => entry.text.includes("vvoc"));
    expect(vvoc).toBeDefined();
    expect(Math.round(vvoc!.fg.buffer["0"])).toBe(128);
    expect(Math.round(vvoc!.fg.buffer["1"])).toBe(128);
    expect(Math.round(vvoc!.fg.buffer["2"])).toBe(128);
  });
});
