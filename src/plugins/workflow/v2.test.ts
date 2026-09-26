// FILE: src/plugins/workflow/v2.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2-to-v1 event shape translation driving the workflow event bridge.
//   SCOPE: Unit tests for mapV2EventToV1Shape and adaptSubagentLaunchArgs only, without plugin instantiation or live events.
//   DEPENDS: [src/plugins/workflow/v2.ts]
//   LINKS: [V-M-PLUGIN-WORKFLOW, M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   map - Direct binding of the mapper under test.
//   adapt - Direct binding of the launch argument adapter under test.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [hotfix 2.0.1 - Added coverage for the workflow event bridge translations.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { adaptSubagentLaunchArgs, mapV2EventToV1Shape } from "./v2.js";

const map = mapV2EventToV1Shape;
const adapt = adaptSubagentLaunchArgs;

describe("mapV2EventToV1Shape", () => {
  test("user inbox admissions become user message.updated events", () => {
    const shaped = map({
      type: "session.inbox.enqueued",
      data: { item: { type: "user", id: "msg_1", sessionID: "ses_child" } },
    });
    expect(shaped).toEqual({
      type: "message.updated",
      properties: { info: { role: "user", sessionID: "ses_child", id: "msg_1" } },
    });
  });

  test("non-user inbox admissions are ignored", () => {
    expect(
      map({
        type: "session.inbox.enqueued",
        data: { item: { type: "synthetic", id: "x", sessionID: "s" } },
      }),
    ).toBeUndefined();
  });

  test("tool failures become error task-part states with the error message", () => {
    const shaped = map({
      type: "session.tool.failed",
      data: {
        sessionID: "ses_parent",
        id: "call_7",
        error: { message: "Subagent failed (task_id: ses_child): boom" },
        metadata: { parentSessionId: "ses_parent", sessionId: "ses_child" },
      },
    });
    expect(shaped?.type).toBe("message.part.updated");
    const part = (shaped?.properties.part ?? {}) as Record<string, unknown>;
    expect(part.tool).toBe("task");
    expect(part.sessionID).toBe("ses_parent");
    expect(part.callID).toBe("call_7");
    const state = part.state as Record<string, unknown>;
    expect(state.status).toBe("error");
    expect(state.error).toContain("Subagent failed (task_id: ses_child)");
    expect(state.metadata).toEqual({ parentSessionId: "ses_parent", sessionId: "ses_child" });
  });

  test("tool progress becomes running part states with metadata", () => {
    const shaped = map({
      type: "session.tool.progress",
      data: {
        sessionID: "ses_p",
        id: "call_9",
        metadata: { parentSessionId: "ses_p", sessionId: "ses_c" },
      },
    });
    const state = ((shaped?.properties.part ?? {}) as { state?: Record<string, unknown> }).state;
    expect(state?.status).toBe("running");
    expect(state?.metadata).toEqual({ parentSessionId: "ses_p", sessionId: "ses_c" });
  });

  test("tool events without identity are ignored", () => {
    expect(map({ type: "session.tool.failed", data: { sessionID: "s" } })).toBeUndefined();
    expect(map({ type: "session.tool.failed", data: { id: "c" } })).toBeUndefined();
  });

  test("session deletions map directly", () => {
    expect(map({ type: "session.deleted", data: { sessionID: "ses_x" } })).toEqual({
      type: "session.deleted",
      properties: { sessionID: "ses_x" },
    });
  });

  test("unrelated events are ignored", () => {
    expect(map({ type: "session.step.started", data: {} })).toBeUndefined();
  });
});

describe("adaptSubagentLaunchArgs", () => {
  test("maps agent and sessionID onto the v1 task fields", () => {
    expect(
      adapt({
        agent: "vv-implementer",
        prompt: "do it",
        sessionID: "ses_child",
        background: false,
      }),
    ).toMatchObject({
      subagent_type: "vv-implementer",
      prompt: "do it",
      task_id: "ses_child",
      background: false,
    });
  });

  test("leaves non-object and agentless input unchanged in shape", () => {
    expect(adapt("raw")).toBe("raw");
    expect(adapt({ prompt: "x" })).not.toHaveProperty("subagent_type");
  });
});
