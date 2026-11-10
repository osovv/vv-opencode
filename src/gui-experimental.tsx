/** @jsxImportSource solid-js */
// FILE: src/gui-experimental.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the minimal `./gui-experimental` window part of the GUI spike: a "vvoc" settings page stub and a composer pill that show the orchestration profile from the effective vvoc defaults through the versioned GUI RPC, plus the platform/app badge that makes the web-versus-desktop loading verdict observable in the DOM.
//   SCOPE: One GUI plugin definition with an English i18n catalog, a SettingsPage contribution rendered with host ui components, one ComposerPill that opens the page, and a bounded RPC read with strict reply decoding. It registers no server behavior and owns no stores; the full settings panels are later, separately planned work.
//   DEPENDS: [solid-js, @opencode/plugin/gui, src/rpc.ts]
//   LINKS: [M-GUI-SPIKE, DF-GUI-RPC, V-M-PLUGIN-GUI-SETTINGS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - The `./gui-experimental` GUI definition (settings page stub plus profile composer pill).
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added the minimal vvoc settings page stub and profile composer pill over the versioned GUI RPC, with host ui components and an English i18n catalog.]
// END_CHANGE_SUMMARY

import { createResource, Show, type Accessor } from "solid-js";
import { ComposerPill, Plugin, SettingsPage, type ComposerPillView } from "@opencode/plugin/gui";
import {
  VVOC_GUI_METHODS,
  decodeDefaultsGetOutput,
  vvocGuiRpc,
  type DefaultsGetOutput,
} from "./rpc.js";

const SETTINGS_PAGE_ID = "vvoc";

// START_BLOCK_GUI_DEFINITION
export default Plugin.define({
  i18n: {
    en: {
      "settings.title": "vvoc",
      "settings.description":
        "GUI spike: the vvoc window part loaded and reached the server plugin over its versioned RPC.",
      "settings.profile": "Orchestration profile",
      "settings.source": "Config source",
      "settings.platform": "Platform",
      "settings.unavailable": "vvoc defaults are unavailable right now.",
      "settings.retry": "Retry",
      "pill.label": "vvoc · {{profile}}",
      "pill.missing": "vvoc · no profile",
    },
  },
  setup(ctx) {
    const [defaults, { refetch }] = createResource(async () => {
      const reply = await ctx.client
        .rpc(vvocGuiRpc)
        [VVOC_GUI_METHODS.defaultsGet]({}, { signal: ctx.signal });
      return decodeDefaultsGetOutput(reply);
    });

    const profile = () => {
      const value: DefaultsGetOutput | undefined = defaults();
      return value?.status === "available" ? value.profile : undefined;
    };

    ctx.add(SettingsPage, {
      id: SETTINGS_PAGE_ID,
      title: ctx.t("settings.title"),
      icon: "sliders",
      entries: [
        {
          id: SETTINGS_PAGE_ID,
          title: ctx.t("settings.title"),
          description: ctx.t("settings.description"),
        },
      ],
      render: () => (
        <div class="vvoc-gui-spike" data-vvoc-page={SETTINGS_PAGE_ID}>
          <h3>{ctx.t("settings.title")}</h3>
          <p>{ctx.t("settings.description")}</p>
          <div data-vvoc-platform={ctx.app.platform}>
            {ctx.t("settings.platform")}: {ctx.app.platform} ({ctx.app.version})
          </div>
          <Show
            when={!defaults.error}
            fallback={
              <div data-vvoc-state="unavailable">
                <p>{ctx.t("settings.unavailable")}</p>
                <ctx.ui.Button onClick={() => void refetch()}>
                  {ctx.t("settings.retry")}
                </ctx.ui.Button>
              </div>
            }
          >
            <Show
              when={defaults()}
              fallback={
                <div data-vvoc-state="loading">
                  <ctx.ui.Loader />
                </div>
              }
            >
              {(value: Accessor<DefaultsGetOutput>) => (
                <div data-vvoc-state="loaded">
                  <div data-vvoc-profile={value().profile ?? ""}>
                    {ctx.t("settings.profile")}: {value().profile ?? "—"}
                  </div>
                  <Show when={value().source}>
                    {(source: Accessor<NonNullable<DefaultsGetOutput["source"]>>) => (
                      <div data-vvoc-source={source().kind}>
                        {ctx.t("settings.source")}: {source().kind}
                        {source().path === undefined ? "" : ` (${source().path})`}
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </div>
      ),
    });

    ctx.add(ComposerPill, {
      id: "profile",
      show: () => {
        const current = profile();
        const view: ComposerPillView = {
          icon: "flask",
          label:
            current === undefined
              ? ctx.t("pill.missing")
              : ctx.t("pill.label", { profile: current }),
          title: ctx.t("settings.title"),
          run: () => ctx.layout.settings(SETTINGS_PAGE_ID),
        };
        return view;
      },
    });
  },
});
// END_BLOCK_GUI_DEFINITION
