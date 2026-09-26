// FILE: src/plugins/workflow/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Run the complete workflow enforcement surface on the OpenCode v2 runtime by bridging the v1 plugin factory's hooks and tools onto v2 domains.
//   SCOPE: v2 setup only: instantiate the v1 factory once with a shimmed client, register its five tools with their strict JSON Schema inputs through the tool transform, route execute.before and execute.after through v2 tool hooks with subagent-launch argument adaptation (v2 names the launcher subagent with agent and sessionID fields), append the profile guidance through the session context hook, and keep every fail-closed guarantee of the shared protocol unchanged.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/plugins/workflow/index.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, V-M-PLUGIN-WORKFLOW, M-WORKFLOW-PROTOCOL, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupWorkflowV2 - Bridge the full workflow surface onto one OpenCode v2 plugin context.
//   createWorkflowClientShim - v1-shaped client over v2 domains for the workflow authorization and repair surfaces.
//   adaptSubagentLaunchArgs - Map v2 subagent tool arguments onto the v1 task launch shape.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-005 - Bridged the workflow enforcement surface onto v2 tool, session, and event domains.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { WorkflowPlugin } from "./index.js";

// START_BLOCK_CREATE_WORKFLOW_CLIENT_SHIM
/**
 * A v1-shaped client built on v2 domains. Session lookups map onto
 * ctx.session, logging degrades to console, and the repair continuation
 * prompt is unsupported under the v2 prompt shape and throws so the
 * bounded continuation path fails closed exactly like a failed continuation.
 */
export function createWorkflowClientShim(adapter: V2AdapterContext) {
  return {
    app: {
      log: async () => {},
    },
    session: {
      get: async (input: { path: { id: string } }) => {
        const data = await adapter.ctx.session.get({ sessionID: input.path.id });
        return { data };
      },
      message: async (input: { path: { id: string; messageID: string } }) => {
        try {
          const messages = await adapter.ctx.session.context({ sessionID: input.path.id });
          const hit = (messages as Array<{ id?: string }>).find(
            (message) => message.id === input.path.messageID,
          );
          return hit ? { data: hit } : { data: undefined, error: { name: "NotFound" } };
        } catch {
          return { data: undefined, error: { name: "NotFound" } };
        }
      },
      prompt: async (_input: unknown) => {
        throw new Error("workflow continuation prompt is not available on the v2 runtime");
      },
    },
  };
}
// END_BLOCK_CREATE_WORKFLOW_CLIENT_SHIM

// START_BLOCK_ADAPT_SUBAGENT_LAUNCH_ARGS
/**
 * Map v2 subagent launch arguments onto the v1 task shape the launch
 * validation consumes: agent becomes subagent_type, the v2 resume sessionID
 * becomes task_id, and background passes through. The v1 reader fields stay
 * authoritative so every eligibility rule applies unchanged.
 */
export function adaptSubagentLaunchArgs(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  return {
    ...record,
    ...(typeof record.agent === "string" ? { subagent_type: record.agent } : {}),
    ...(typeof record.sessionID === "string" ? { task_id: record.sessionID } : {}),
  };
}
// END_BLOCK_ADAPT_SUBAGENT_LAUNCH_ARGS

// START_BLOCK_SETUP_WORKFLOW_V2
/**
 * Bridge the workflow surface onto the v2 runtime.
 *
 * The v1 factory runs once with the shimmed client; its returned hook object
 * is routed onto v2 domains: tools publish with their strict JSON Schema
 * inputs, before and after guards run as v2 tool hooks with the launcher
 * renamed from task to subagent, and the profile guidance appends through
 * the session context hook. Protocol parsing stays fail-closed: envelope
 * shapes the shared parser does not recognize reject the attempt, never
 * accept it.
 */
export async function setupWorkflowV2(adapter: V2AdapterContext): Promise<V2Plugin.Cleanup | void> {
  const directory = adapter.ctx.location.directory;
  const hooks = (await WorkflowPlugin({
    client: createWorkflowClientShim(adapter) as never,
    project: { id: directory, directory } as never,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {} as never,
  } as never)) as Record<string, unknown> | undefined;
  if (!hooks) return undefined;

  const cleanups: Array<() => Promise<void>> = [];

  // Tools: publish each v1 tool entry with its contract JSON Schema input.
  const toolEntries = (hooks.tool ?? {}) as Record<
    string,
    {
      description: string;
      execute: (args: unknown, context: unknown) => Promise<unknown> | unknown;
    }
  >;
  const { workflowToolContracts } = await import("./input-validation.js");
  const toolRegistration = await adapter.ctx.tool.transform((editor) => {
    for (const [name, entry] of Object.entries(toolEntries)) {
      const contract = workflowToolContracts.find((item) => item.toolId === name);
      editor.add({
        name,
        description: entry.description,
        input: (contract?.inputJsonSchema ?? { type: "object" }) as never,
        execute: (async (
          input: unknown,
          context: { sessionID?: string; agent?: string; signal?: AbortSignal },
        ) => {
          const result = await entry.execute(input, {
            sessionID: context.sessionID,
            agent: context.agent,
            abort: context.signal,
          });
          return { content: typeof result === "string" ? result : JSON.stringify(result) };
        }) as never,
      });
    }
  });
  cleanups.push(() => toolRegistration.dispose());

  // Owned validation plus task-launch tracking on execute.before.
  const beforeHook = await adapter.ctx.tool.hook("execute.before", (event) => {
    const tool = String(event.tool) === "subagent" ? "task" : String(event.tool);
    const args =
      String(event.tool) === "subagent" ? adaptSubagentLaunchArgs(event.input) : event.input;
    const before = hooks["tool.execute.before"] as
      | ((input: unknown, output: unknown) => Promise<void>)
      | undefined;
    if (!before) return;
    return before(
      { tool, sessionID: event.sessionID, callID: event.id, agent: event.agent },
      { args },
    );
  });
  cleanups.push(() => beforeHook.dispose());

  // Delegated result tracking on execute.after.
  const afterHook = await adapter.ctx.tool.hook("execute.after", (event) => {
    if (event.status !== "completed") return;
    const tool = String(event.tool) === "subagent" ? "task" : String(event.tool);
    const args =
      String(event.tool) === "subagent" ? adaptSubagentLaunchArgs(event.input) : event.input;
    const result = event.result as { content?: string | Array<{ type: string; text?: string }> };
    const output =
      typeof result.content === "string"
        ? result.content
        : Array.isArray(result.content)
          ? result.content.map((part) => part.text ?? "").join("\n")
          : "";
    const after = hooks["tool.execute.after"] as
      | ((input: unknown, output: unknown) => Promise<void>)
      | undefined;
    if (!after) return;
    return after(
      { tool, sessionID: event.sessionID, callID: event.id, agent: event.agent, args },
      { output, metadata: {} },
    );
  });
  cleanups.push(() => afterHook.dispose());

  // Profile guidance through the session context hook.
  const chatMessage = hooks["chat.message"] as
    | ((input: unknown, output: unknown) => Promise<void>)
    | undefined;
  if (chatMessage) {
    const contextHook = await adapter.ctx.session.hook("context", (event) => {
      const message = {
        agent: event.agent,
        system: event.system
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n\n"),
      };
      const before = message.system;
      const result = chatMessage({}, { message });
      if (result instanceof Promise) {
        return result.then(() => {
          if (typeof message.system === "string" && message.system !== before) {
            event.system.length = 0;
            event.system.push({ type: "text", text: message.system });
          }
        });
      }
      return undefined;
    });
    cleanups.push(() => contextHook.dispose());
  }

  return async () => {
    for (const dispose of cleanups.reverse()) await dispose();
  };
}
// END_BLOCK_SETUP_WORKFLOW_V2
