// FILE: src/tui/branding/footer.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native sidebar footer claim, combined version rendering, theme mapping, and fail-soft behavior.
//   SCOPE: Label composition, native slot claim shape, injected renderer, and real OpenTUI rendering of the default line.
//   DEPENDS: [bun:test, @opentui/core, @opentui/solid, @opencode/plugin/tui, src/tui/branding/footer.tsx]
//   LINKS: [V-M-TUI-BRANDING-FOOTER, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   OPENCODE_VERSION - Pinned host version used by the branding-footer assertion.
//   fakeContext - Minimal native context double that records footer claims.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Rewrote footer coverage for the native sidebar.footer claim and native theme tokens.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
import { brandingFooterLabel, registerBrandingFooter } from "./footer.js";
import { getPackageVersionSync } from "../../lib/package.js";

const OPENCODE_VERSION = "2.0.18";

function fakeContext(options: { slotFails?: boolean } = {}) {
  const claims: Array<{ claim: unknown; render: () => unknown }> = [];
  const textBase = RGBA.fromInts(220, 220, 220, 255);
  const textMuted = RGBA.fromInts(128, 128, 128, 255);
  const success = RGBA.fromInts(0, 255, 0, 255);
  const context = {
    app: { version: OPENCODE_VERSION, channel: "stable" },
    theme: {
      text: {
        base: textBase,
        muted: textMuted,
        feedback: {
          warning: { base: RGBA.fromInts(255, 200, 0, 255) },
          error: { base: RGBA.fromInts(255, 0, 0, 255) },
          success: { base: success },
        },
      },
      hue: { accent: { 200: textBase } },
    },
    ui: {
      slot: (claim: unknown) => {
        if (options.slotFails) throw new Error("slot registration failed");
        const record = claim as { render: () => unknown };
        claims.push({ claim, render: record.render });
        return () => undefined;
      },
    },
  } as unknown as Plugin.Context;
  return { context, claims, colors: { textBase, textMuted, success } };
}

describe("brandingFooterLabel", () => {
  test("returns vvoc v followed by the current package version", () => {
    expect(brandingFooterLabel()).toBe(`vvoc v${getPackageVersionSync()}`);
  });
});

describe("registerBrandingFooter", () => {
  test("claims the native sidebar footer with replace", () => {
    const { context, claims } = fakeContext();
    registerBrandingFooter(context, { renderLabel: () => ({ marker: true }) as never });
    expect(claims).toHaveLength(1);
    expect((claims[0]!.claim as { replace?: string }).replace).toBe("sidebar.footer");
  });

  test("renders both the OpenCode version and the vvoc label with theme colors", () => {
    const { context, claims, colors } = fakeContext();
    let captured:
      | { info: { opencodeVersion: string; vvocLabel: string }; colors: Record<string, RGBA> }
      | undefined;
    registerBrandingFooter(context, {
      renderLabel: (info, themeColors) => {
        captured = { info, colors: themeColors };
        return { info, colors: themeColors } as never;
      },
    });
    claims[0]!.render();
    expect(captured?.info.opencodeVersion).toBe(OPENCODE_VERSION);
    expect(captured?.info.vvocLabel).toBe(`vvoc v${getPackageVersionSync()}`);
    expect(captured?.colors.muted).toBe(colors.textMuted);
    expect(captured?.colors.text).toBe(colors.textBase);
  });

  test("returns silently when slot registration throws", () => {
    const { context } = fakeContext({ slotFails: true });
    expect(() => registerBrandingFooter(context)).not.toThrow();
  });

  test("default line renders through real OpenTUI with both versions", async () => {
    const { context, claims } = fakeContext();
    registerBrandingFooter(context);
    const { testRender } = await import("@opentui/solid");
    const setup = await testRender(() => claims[0]!.render() as never, { width: 60, height: 3 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("OpenCode");
    expect(frame).toContain(OPENCODE_VERSION);
    expect(frame).toContain(`vvoc v${getPackageVersionSync()}`);
  });
});
