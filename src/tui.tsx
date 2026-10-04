// FILE: src/tui.tsx
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish the default @osovv/vv-opencode/tui native plugin module containing the /context inspector, /vv-rebind command, analytics indicator, branding footer, and peak-hours banner.
//   SCOPE: Native plugin definition (id/setup/cleanup), a shared selection-keyed policy controller over the context-inspection RPC that resolves the current selected session's native location, refresh on route and native policy-binding events, the /vv-rebind marker facade, and lifecycle cleanup of every slot/keymap/effect/subscription. It performs no local filesystem config read.
//   DEPENDS: [@opencode/plugin/tui, solid-js, src/runtime/context-inspection-contract.ts, src/tui/policy.ts, src/tui/context/collect.ts, src/tui/context/plugin.ts, src/tui/context/view.tsx, src/tui/rebind/plugin.ts, src/tui/analytics/indicator.tsx, src/tui/branding/footer.tsx, src/tui/peak-hours/banner.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-TUI-ANALYTICS-INDICATOR, M-TUI-BRANDING-FOOTER, M-TUI-PEAK-HOURS-BANNER, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   vvocContextTuiPlugin - Named native TUI plugin definition for direct consumers and tests.
//   default - Native OpenCode TUI plugin module registering /context, /vv-rebind, the analytics indicator, the branding footer, and the peak-hours banner.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-VV-REBIND-TUI-COMMAND T-001 - Registered /vv-rebind beside /context as a thin facade over the rebind request marker.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal } from "solid-js";
import { contextInspectionRpc } from "./runtime/context-inspection-contract.js";
import { registerAnalyticsIndicator } from "./tui/analytics/indicator.js";
import { registerBrandingFooter } from "./tui/branding/footer.js";
import { collectContextAnalysis, createTuiCollectionDependencies } from "./tui/context/collect.js";
import { activeSessionID, registerContextTuiPlugin } from "./tui/context/plugin.js";
import { openContextDialog } from "./tui/context/view.js";
import { registerPeakHoursBanner } from "./tui/peak-hours/banner.js";
import { registerRebindTuiCommand } from "./tui/rebind/plugin.js";
import {
  createPolicyController,
  createRpcPolicyFetch,
  policyContextSuppressed,
  type ContextPolicySnapshot,
} from "./tui/policy.js";

// START_BLOCK_TUI_MODULE
export const vvocContextTuiPlugin = Plugin.define({
  id: "vvoc-context",
  setup(ctx) {
    const fallbackDirectory = (): string =>
      ctx.location?.directory ?? ctx.data.location.default().directory;
    // The policy must follow the SELECTED session's current native location, not
    // a location captured once at plugin setup.
    const sessionDirectory = (sessionID: string | undefined): string => {
      if (sessionID === undefined) return fallbackDirectory();
      const location = ctx.data.session.get(sessionID)?.location;
      return location?.directory ?? fallbackDirectory();
    };

    const controller = createPolicyController(
      createRpcPolicyFetch((input, options) =>
        ctx.client.rpc(contextInspectionRpc).inspect(input, options),
      ),
    );
    const [policy, setPolicy] = createSignal<ContextPolicySnapshot | undefined>(undefined);
    const cleanups: Array<() => void> = [
      controller.subscribe(setPolicy),
      () => controller.dispose(),
    ];

    const refreshActive = (): void => {
      const sessionID = activeSessionID(ctx);
      void controller.refresh({ sessionID, directory: sessionDirectory(sessionID) });
    };
    createEffect(refreshActive);
    // An initially unbound/empty tab becomes captured without a tab change.
    // The family capture is committed from accepted-event handling, which can
    // lag the TUI's `session.inbox.enqueued`, so refresh again on native step
    // boundaries: pinned `session.step.started` is published when request
    // dispatch begins (after delivery) and `session.step.ended` after the step
    // settles, both strictly later than the enqueue that triggers the commit.
    cleanups.push(
      ctx.data.on("session.inbox.enqueued", (event) => {
        if (activeSessionID(ctx) === event.data.sessionID) refreshActive();
      }),
      ctx.data.on("session.step.started", (event) => {
        if (activeSessionID(ctx) === event.data.sessionID) refreshActive();
      }),
      ctx.data.on("session.step.ended", (event) => {
        if (activeSessionID(ctx) === event.data.sessionID) refreshActive();
      }),
      ctx.data.on("session.model.selected", (event) => {
        if (activeSessionID(ctx) === event.data.sessionID) refreshActive();
      }),
    );

    const collection = createTuiCollectionDependencies(ctx);
    cleanups.push(
      registerContextTuiPlugin(ctx, ctx.options, {
        isEnabled: () => !policyContextSuppressed(policy()),
        revalidate: async (_context, sessionID) => {
          await controller.refresh({ sessionID, directory: sessionDirectory(sessionID) });
          return !policyContextSuppressed(controller.current());
        },
        collect: (_context, sessionID) => collectContextAnalysis(sessionID, collection),
        open: (context, analysis) => openContextDialog(context, analysis),
      }),
      registerRebindTuiCommand(ctx),
      registerAnalyticsIndicator(ctx, policy, ctx.options),
      registerBrandingFooter(ctx),
      registerPeakHoursBanner(ctx, policy),
    );

    return () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  },
});
// END_BLOCK_TUI_MODULE

export default vvocContextTuiPlugin;
