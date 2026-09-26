// FILE: src/plugins/hashline-edit/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Route per-model edit tooling on the OpenCode v2 runtime: expose exactly one edit tool per model, validate owned arguments, and transform read output for hashline sessions.
//   SCOPE: v2 setup only: track the session model from the context hook, enforce edit-tool visibility by deleting non-visible tools from the request, register hashline_edit and str_replace_editor with their strict JSON Schema inputs through the tool transform, run the shared visibility and argument guards on execute.before, apply the routed read transformation on execute.after, and resolve routing per session location.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/plugins/hashline-edit/index.ts, src/plugins/hashline-edit/routing.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/hashline-edit/session-state.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupHashlineEditV2 - Register edit routing, owned tools, and the read transformer for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-004 - Ported edit routing onto v2 context and tool hooks.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import {
  assertEditToolVisible,
  EDIT_VISIBILITY_TOOLS,
  executeHashlineEdit,
  executeStrReplaceEditor,
  isEditTypeTool,
  isHashlineEligibleReadOutput,
  isReadTool,
  readArgFilePath,
  readSourceLines,
  statSnapshot,
  transformReadOutput,
  visibleToolsForMode,
} from "./index.js";
import { hashlineEditContract, strReplaceEditorContract } from "./schemas.js";
import { parseHashlineEditPluginEntry, resolveEditMode, type RoutingConfig } from "./routing.js";
import { SessionFileCache, SessionModelCache } from "./session-state.js";

// START_BLOCK_SETUP_HASHLINE_EDIT_V2
/**
 * Register the edit routing on the v2 runtime.
 *
 * The v1 chat.message visibility mutation becomes deletion of non-visible
 * edit tools from the context hook's request tools, model tracking moves to
 * the same hook's model reference, and the owned tools publish through the
 * tool transform with their strict JSON Schema inputs. Routing resolves per
 * session location through the shared adapter.
 */
export async function setupHashlineEditV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  const directory = adapter.ctx.location.directory;
  const read = await loadVvocConfigForRead({
    cwd: directory,
    scope: "effective",
    allowDefault: true,
  });
  const settings = parseHashlineEditPluginEntry(
    (read.config.plugins as Record<string, unknown> | undefined)?.["hashline-edit"],
  );
  if (!settings.enabled) return undefined;
  const routing: RoutingConfig = settings.routing;

  const modelCache = new SessionModelCache();
  const fileCache = new SessionFileCache();
  const resolveSessionMode = (sessionID: string) =>
    resolveEditMode(routing, modelCache.get(sessionID));

  const contextHook = await adapter.ctx.session.hook("context", (event) => {
    const model = event.model as { providerID?: string; id?: string } | undefined;
    if (model?.providerID && model?.id) {
      modelCache.set(String(event.sessionID), { providerID: model.providerID, modelID: model.id });
    }
    const mode = resolveEditMode(routing, {
      providerID: model?.providerID,
      modelID: model?.id,
    });
    const visible = new Set<string>(visibleToolsForMode(mode));
    for (const toolName of EDIT_VISIBILITY_TOOLS) {
      if (toolName === "edit" && mode === "edit") continue;
      if (!visible.has(toolName)) {
        delete event.tools[toolName];
      }
    }
  });

  const beforeHook = await adapter.ctx.tool.hook("execute.before", (event) => {
    const tool = String(event.tool);
    if (!isEditTypeTool(tool)) return;
    assertEditToolVisible(tool, String(event.sessionID), resolveSessionMode);
  });

  const afterHook = await adapter.ctx.tool.hook("execute.after", async (event) => {
    if (!isReadTool(String(event.tool))) return;
    if (event.status !== "completed") return;
    const sessionID = String(event.sessionID);
    const filePath = readArgFilePath(event.input);
    if (filePath) {
      const snapshot = await statSnapshot(filePath);
      if (snapshot) {
        fileCache.record(sessionID, filePath, snapshot);
      }
    }
    if (resolveSessionMode(sessionID) !== "hashline_edit") return;
    const result = event.result as { content?: string | Array<{ type: string; text?: string }> };
    const current =
      typeof result.content === "string"
        ? result.content
        : Array.isArray(result.content) && result.content.every((part) => part.type === "text")
          ? result.content.map((part) => part.text ?? "").join("\n")
          : undefined;
    if (typeof current !== "string" || !isHashlineEligibleReadOutput(current)) return;
    const transformed = transformReadOutput(current, await readSourceLines(event.input));
    result.content = transformed;
  });

  const toolRegistration = await adapter.ctx.tool.transform((editor) => {
    editor.add({
      name: "hashline_edit",
      description: hashlineEditContract.description,
      input: hashlineEditContract.inputJsonSchema as never,
      execute: (async (input: never, context: { sessionID?: string; signal?: AbortSignal }) => {
        const sessionID = String((context as { sessionID?: unknown }).sessionID ?? "");
        assertEditToolVisible("hashline_edit", sessionID, resolveSessionMode);
        const model = modelCache.get(sessionID);
        return {
          content: await executeHashlineEdit(
            input,
            {
              sessionID,
              abort: context.signal,
            } as never,
            {
              editMode: resolveSessionMode(sessionID),
              providerID: model?.providerID,
              modelID: model?.modelID,
            },
          ),
        };
      }) as never,
    });
    editor.add({
      name: "str_replace_editor",
      description: strReplaceEditorContract.description,
      input: strReplaceEditorContract.inputJsonSchema as never,
      execute: (async (input: never, context: { sessionID?: string; signal?: AbortSignal }) => {
        const sessionID = String((context as { sessionID?: unknown }).sessionID ?? "");
        assertEditToolVisible("str_replace_editor", sessionID, resolveSessionMode);
        const model = modelCache.get(sessionID);
        return {
          content: await executeStrReplaceEditor(
            input,
            { sessionID, abort: context.signal } as never,
            sessionID,
            fileCache,
            {
              editMode: resolveSessionMode(sessionID),
              providerID: model?.providerID,
              modelID: model?.modelID,
            },
          ),
        };
      }) as never,
    });
  });

  return async () => {
    await contextHook.dispose();
    await beforeHook.dispose();
    await afterHook.dispose();
    await toolRegistration.dispose();
  };
}
// END_BLOCK_SETUP_HASHLINE_EDIT_V2
