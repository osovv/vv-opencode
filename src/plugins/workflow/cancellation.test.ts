// FILE: src/plugins/workflow/cancellation.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native terminal/cancellation decoding and the strict cancellation-recovery evidence rule against pinned OpenCode 2.0.18 envelope shapes.
//   SCOPE: Native-shaped fixtures for session.tool.success/failed, session.synthetic, session.execution.failed/interrupted; exact subagent termination message parsing; positive and negative evidence decisions.
//   DEPENDS: [bun:test, src/plugins/workflow/cancellation.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-DELEGATED, V-M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   abortedError - Build a structured aborted/interrupted error fixture.
//   toolFailedEvent - Build a native session.tool.failed event fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE wi-20 - Pinned BOTH native 2.0.18 interrupt shapes (live root interrupt + stale post-death settle) to kind 'interrupted' with the child session id, plus negative cases for a bare interrupt, generic provider errors, and unrelated text.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  decodeExecutionTerminalEvent,
  decodeSyntheticEvent,
  decodeToolTerminalEvent,
  evaluateCancellationEvidence,
  isAbortedStructuredError,
  parseSubagentToolFailure,
  type CancellationEvidence,
} from "./cancellation.js";

function abortedError(): { type: string; message: string } {
  return { type: "aborted", message: "Interrupted by user" };
}

function toolFailedEvent(options: {
  sessionID: string;
  callID: string;
  message: string;
  errorType?: string;
  metadata?: Record<string, unknown>;
}): unknown {
  return {
    id: "evt_1",
    created: 100,
    type: "session.tool.failed",
    durable: { aggregateID: options.sessionID, seq: 1, version: 2 },
    data: {
      sessionID: options.sessionID,
      assistantMessageID: "msg_1",
      id: options.callID,
      error: { type: options.errorType ?? "tool.execution", message: options.message },
      executed: true,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    },
  };
}

describe("parseSubagentToolFailure", () => {
  test("parses the exact pinned cancellation and failure messages", () => {
    expect(parseSubagentToolFailure("Subagent cancelled (sessionID: ses_child)")).toEqual({
      kind: "cancelled",
      childSessionId: "ses_child",
    });
    expect(parseSubagentToolFailure("Subagent failed (sessionID: ses_child): boom")).toEqual({
      kind: "failed",
      childSessionId: "ses_child",
      detail: "boom",
    });
  });

  test("parses both pinned native interrupt shapes as interrupted", () => {
    // Live in-process root interrupt (step.ts TOOLS_INTERRUPTED composed by
    // publish-llm-event.ts failTool subagent special case).
    expect(parseSubagentToolFailure("Tool execution interrupted (sessionID: ses_child)")).toEqual({
      kind: "interrupted",
      childSessionId: "ses_child",
    });
    // Stale post-process-death settle (llm.ts settleStaleToolCalls).
    expect(
      parseSubagentToolFailure("Tool execution interrupted: subagent (sessionID: ses_child)"),
    ).toEqual({ kind: "interrupted", childSessionId: "ses_child" });
  });

  test("rejects unrelated provider and transport errors", () => {
    expect(parseSubagentToolFailure("provider error")).toBeUndefined();
    expect(parseSubagentToolFailure("Subagent failed: no session")).toBeUndefined();
    expect(parseSubagentToolFailure("Subagent cancelled (task_id: ses_x)")).toBeUndefined();
    expect(
      parseSubagentToolFailure("Subagent cancelled (sessionID: ses_child) trailing"),
    ).toBeUndefined();
  });

  test("rejects interrupts that do not name a subagent child session", () => {
    // Bare live interrupt (non-subagent tool, or a subagent without progress
    // metadata) never carries a child session id and is never evidence.
    expect(parseSubagentToolFailure("Tool execution interrupted")).toBeUndefined();
    expect(parseSubagentToolFailure("Tool execution interrupted (sessionID: )")).toBeUndefined();
    expect(
      parseSubagentToolFailure(
        "Tool execution interrupted: subagent (sessionID: ses_child) trailing",
      ),
    ).toBeUndefined();
    expect(
      parseSubagentToolFailure("Tool execution interrupted (sessionID: ses_child) trailing"),
    ).toBeUndefined();
    expect(parseSubagentToolFailure("Tool execution interrupted: echo")).toBeUndefined();
  });
});

describe("decodeToolTerminalEvent", () => {
  test("decodes failed cancellation events and ignores other events", () => {
    const decoded = decodeToolTerminalEvent(
      toolFailedEvent({
        sessionID: "ses_parent",
        callID: "call_1",
        message: "Subagent cancelled (sessionID: ses_child)",
      }),
    );
    expect(decoded).toEqual({
      sessionID: "ses_parent",
      callID: "call_1",
      status: "failed",
      error: { type: "tool.execution", message: "Subagent cancelled (sessionID: ses_child)" },
    });
    expect(decodeToolTerminalEvent({ type: "session.tool.called", data: {} })).toBeUndefined();
    expect(
      decodeToolTerminalEvent({
        type: "session.tool.failed",
        data: { sessionID: "ses_parent", id: "call_1" },
      }),
    ).toBeUndefined();
  });

  test("decodes success without an error", () => {
    const decoded = decodeToolTerminalEvent({
      type: "session.tool.success",
      data: {
        sessionID: "ses_parent",
        id: "call_1",
        content: [{ type: "text", text: "ok" }],
        metadata: { sessionID: "ses_child", status: "running" },
        executed: true,
      },
    });
    expect(decoded).toEqual({
      sessionID: "ses_parent",
      callID: "call_1",
      status: "success",
      metadata: { sessionID: "ses_child", status: "running" },
    });
  });
});

describe("decodeSyntheticEvent", () => {
  test("decodes a background subagent completion synthetic envelope", () => {
    const decoded = decodeSyntheticEvent({
      type: "session.synthetic",
      data: {
        sessionID: "ses_parent",
        text: '<subagent sessionID="ses_child" state="completed">done</subagent>',
        description: "task",
        metadata: { source: "subagent", childID: "ses_child", state: "completed" },
      },
    });
    expect(decoded).toEqual({
      sessionID: "ses_parent",
      text: '<subagent sessionID="ses_child" state="completed">done</subagent>',
      description: "task",
      metadata: { source: "subagent", childID: "ses_child", state: "completed" },
    });
    expect(decodeSyntheticEvent({ type: "session.inbox.enqueued", data: {} })).toBeUndefined();
  });
});

describe("decodeExecutionTerminalEvent", () => {
  test("decodes failed and interrupted execution events", () => {
    expect(
      decodeExecutionTerminalEvent({
        type: "session.execution.failed",
        data: { sessionID: "ses_child", error: abortedError() },
      }),
    ).toEqual({
      sessionID: "ses_child",
      status: "failed",
      error: { type: "aborted", message: "Interrupted by user" },
    });
    expect(
      decodeExecutionTerminalEvent({
        type: "session.execution.interrupted",
        data: { sessionID: "ses_child", reason: "user" },
      }),
    ).toEqual({ sessionID: "ses_child", status: "interrupted", reason: "user" });
    expect(
      decodeExecutionTerminalEvent({
        type: "session.execution.interrupted",
        data: { sessionID: "ses_child", reason: "bogus" },
      }),
    ).toBeUndefined();
  });
});

describe("isAbortedStructuredError", () => {
  test("accepts only the native aborted type", () => {
    expect(isAbortedStructuredError({ type: "aborted", message: "x" })).toBe(true);
    expect(isAbortedStructuredError({ type: "provider.transport", message: "x" })).toBe(false);
    expect(isAbortedStructuredError(undefined)).toBe(false);
  });
});

describe("evaluateCancellationEvidence", () => {
  function evidence(overrides: Partial<CancellationEvidence> = {}): CancellationEvidence {
    return {
      parentSessionId: "ses_parent",
      callID: "call_1",
      childSessionId: "ses_child",
      parentToolFailure: { kind: "cancelled", childSessionId: "ses_child" },
      childTerminalError: abortedError(),
      childActive: false,
      ...overrides,
    };
  }

  test("approves a matching cancelled/interrupted pair with a quiescent child", () => {
    expect(evaluateCancellationEvidence(evidence())).toEqual({ ok: true });
    expect(
      evaluateCancellationEvidence(
        evidence({
          parentToolFailure: { kind: "interrupted", childSessionId: "ses_child" },
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refuses a plain failure, mismatched child, non-abort child error, or active child", () => {
    expect(
      evaluateCancellationEvidence(
        evidence({ parentToolFailure: { kind: "failed", childSessionId: "ses_child" } }),
      ),
    ).toEqual({ ok: false, reason: "PARENT_TOOL_FAILURE_NOT_CANCELLATION" });
    expect(
      evaluateCancellationEvidence(
        evidence({ parentToolFailure: { kind: "cancelled", childSessionId: "ses_other" } }),
      ),
    ).toEqual({ ok: false, reason: "PARENT_CHILD_SESSION_MISMATCH" });
    expect(
      evaluateCancellationEvidence(
        evidence({ childTerminalError: { type: "provider.transport", message: "x" } }),
      ),
    ).toEqual({ ok: false, reason: "CHILD_TERMINAL_NOT_ABORTED" });
    expect(evaluateCancellationEvidence(evidence({ childActive: true }))).toEqual({
      ok: false,
      reason: "CHILD_STILL_ACTIVE",
    });
  });
});
