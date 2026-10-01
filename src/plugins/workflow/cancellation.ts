// FILE: src/plugins/workflow/cancellation.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Decode native OpenCode 2.0.18 terminal tool/execution/synthetic events and decide, under a strict evidence rule, whether a workflow attempt was authoritatively cancelled.
//   SCOPE: Pure native event decoding and cancellation-evidence evaluation only. No session/client access, no state mutation, no persistence, no budgets. The approved evidence rule requires an authoritative parent subagent tool-call termination, the actual child's terminal abort, and child quiescence; every other shape refuses.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-DELEGATED, M-WORKFLOW-EXECUTION, V-M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeStructuredError - Native SessionError.Error shape ({type, message, status?}).
//   NativeToolTerminalEvent - Decoded session.tool.success/session.tool.failed terminal event.
//   NativeSyntheticEvent - Decoded session.synthetic event delivered to a parent session.
//   NativeExecutionTerminalEvent - Decoded session.execution.failed/interrupted terminal event.
//   SubagentToolFailureKind - Native mapping of a foreground subagent tool-call termination.
//   SubagentToolFailure - Parsed subagent tool-call termination with the child session it names.
//   parseSubagentToolFailure - Parse the exact pinned subagent failure/cancel/interrupt messages (both native interrupt shapes).
//   isAbortedStructuredError - True only for a terminal native `{type:"aborted"}` error.
//   decodeToolTerminalEvent - Decode a native session.tool.success/session.tool.failed envelope.
//   decodeSyntheticEvent - Decode a native session.synthetic envelope.
//   decodeExecutionTerminalEvent - Decode a native session.execution.failed/interrupted envelope.
//   CancellationEvidence - Strict evidence bundle for one candidate cancellation recovery.
//   CancellationEvidenceDecision - Approved or refused cancellation settlement outcome.
//   evaluateCancellationEvidence - Approve cancellation settlement only with complete, matching, quiescent evidence.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE wi-20 - parseSubagentToolFailure now recognizes BOTH pinned 2.0.18 interrupt shapes: the live in-process root-interrupt `Tool execution interrupted (sessionID: <id>)` (step.ts TOOLS_INTERRUPTED composed by publish-llm-event.ts failTool) in addition to the stale post-process-death `Tool execution interrupted: subagent (sessionID: <id>)` (llm.ts settleStaleToolCalls). A root interrupt now yields kind 'interrupted' with the child session id, so explicit recovery can settle the attempt; a bare interrupt without a child session id, a generic provider/transport error, or unrelated text still returns undefined. T-004 originally added the authoritative native cancellation mapping and strict recovery evidence rule, replacing the V1 Task cancelled / MessageAbortedError assumption with verified 2.0.18 shapes.]
// END_CHANGE_SUMMARY

/** Native `SessionError.Error` shape (packages/schema/src/session-error.ts). */
export interface NativeStructuredError {
  readonly type: string;
  readonly message: string;
  readonly status?: number;
}

/** Decoded native `session.tool.success` / `session.tool.failed` terminal event. */
export interface NativeToolTerminalEvent {
  readonly sessionID: string;
  readonly callID: string;
  readonly status: "success" | "failed";
  /** Present only on failed. */
  readonly error?: NativeStructuredError;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Decoded native `session.synthetic` event. */
export interface NativeSyntheticEvent {
  readonly sessionID: string;
  readonly text: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Decoded native `session.execution.failed` / `session.execution.interrupted` event. */
export interface NativeExecutionTerminalEvent {
  readonly sessionID: string;
  readonly status: "failed" | "interrupted";
  readonly error?: NativeStructuredError;
  readonly reason?: "user" | "shutdown" | "superseded" | "inactivity";
}

/** Native mapping of a foreground subagent tool-call termination. */
export type SubagentToolFailureKind = "cancelled" | "failed" | "interrupted";

/** Parsed subagent tool-call termination naming the child session it belongs to. */
export interface SubagentToolFailure {
  readonly kind: SubagentToolFailureKind;
  readonly childSessionId: string;
  readonly detail?: string;
}

// Exact pinned messages from the 2.0.18 source:
// - packages/core/src/tool/plugin/subagent.ts: `Subagent cancelled (sessionID: <id>)`
//   and `Subagent failed (sessionID: <id>): <detail>`.
// - LIVE in-process root interrupt (parent session interrupted while the subagent
//   tool part is unsettled — the common TUI Esc / API interrupt case):
//   packages/core/src/session/runner/step.ts:61 `TOOLS_INTERRUPTED`
//   (`{ type: "aborted", message: "Tool execution interrupted" }`) composed by
//   packages/core/src/session/runner/publish-llm-event.ts:342-358 (`failTool`
//   subagent special case) into `Tool execution interrupted (sessionID: <id>)`.
// - STALE post-process-death settle: packages/core/src/session/runner/llm.ts:348
//   (`settleStaleToolCalls`) `Tool execution interrupted: subagent (sessionID: <id>)`.
// Both interrupt shapes carry a subagent child session id; a bare
// `Tool execution interrupted` (no child session id) is not evidence here.
const SUBAGENT_CANCELLED_RE = /^Subagent cancelled \(sessionID: ([^)\s]+)\)$/;
const SUBAGENT_FAILED_RE = /^Subagent failed \(sessionID: ([^)\s]+)\)(?:: ([\s\S]*))?$/;
const SUBAGENT_INTERRUPTED_LIVE_RE = /^Tool execution interrupted \(sessionID: ([^)\s]+)\)$/;
const SUBAGENT_INTERRUPTED_STALE_RE =
  /^Tool execution interrupted: subagent \(sessionID: ([^)\s]+)\)$/;

/**
 * Parse only the exact pinned subagent termination messages, covering both
 * native interrupt shapes (live root interrupt and stale post-death settle). A
 * generic provider or transport error, an unrelated tool interrupt, or an
 * interrupt without a subagent child session id is not a cancellation and
 * returns undefined.
 */
export function parseSubagentToolFailure(message: string): SubagentToolFailure | undefined {
  const cancelled = SUBAGENT_CANCELLED_RE.exec(message);
  if (cancelled) {
    return { kind: "cancelled", childSessionId: cancelled[1] as string };
  }
  const failed = SUBAGENT_FAILED_RE.exec(message);
  if (failed) {
    const detail = failed[2];
    return {
      kind: "failed",
      childSessionId: failed[1] as string,
      ...(detail === undefined || detail === "" ? {} : { detail }),
    };
  }
  const liveInterrupted = SUBAGENT_INTERRUPTED_LIVE_RE.exec(message);
  if (liveInterrupted) {
    return { kind: "interrupted", childSessionId: liveInterrupted[1] as string };
  }
  const staleInterrupted = SUBAGENT_INTERRUPTED_STALE_RE.exec(message);
  if (staleInterrupted) {
    return { kind: "interrupted", childSessionId: staleInterrupted[1] as string };
  }
  return undefined;
}

/** True only for a terminal native `{type:"aborted"}` structured error. */
export function isAbortedStructuredError(
  error: NativeStructuredError | undefined,
): error is NativeStructuredError {
  return error !== undefined && error.type === "aborted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeStructuredError(value: unknown): NativeStructuredError | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type;
  const message = value.message;
  if (typeof type !== "string" || typeof message !== "string") return undefined;
  const status = value.status;
  return {
    type,
    message,
    ...(typeof status === "number" && Number.isFinite(status) ? { status } : {}),
  };
}

function readEnvelope(event: unknown): { type: string; data: Record<string, unknown> } | undefined {
  if (!isRecord(event)) return undefined;
  const type = event.type;
  const data = event.data;
  if (typeof type !== "string" || !isRecord(data)) return undefined;
  return { type, data };
}

/** Decode a native session.tool.success/session.tool.failed envelope, or undefined for any other event. */
export function decodeToolTerminalEvent(event: unknown): NativeToolTerminalEvent | undefined {
  const envelope = readEnvelope(event);
  if (!envelope) return undefined;
  const { type, data } = envelope;
  if (type !== "session.tool.success" && type !== "session.tool.failed") return undefined;
  const sessionID = data.sessionID;
  const callID = data.id;
  if (typeof sessionID !== "string" || typeof callID !== "string") return undefined;
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  if (type === "session.tool.success") {
    return { sessionID, callID, status: "success", ...(metadata ? { metadata } : {}) };
  }
  const error = decodeStructuredError(data.error);
  if (error === undefined) return undefined;
  return { sessionID, callID, status: "failed", error, ...(metadata ? { metadata } : {}) };
}

/** Decode a native session.synthetic envelope, or undefined for any other event. */
export function decodeSyntheticEvent(event: unknown): NativeSyntheticEvent | undefined {
  const envelope = readEnvelope(event);
  if (!envelope || envelope.type !== "session.synthetic") return undefined;
  const { data } = envelope;
  const sessionID = data.sessionID;
  const text = data.text;
  if (typeof sessionID !== "string" || typeof text !== "string") return undefined;
  const description = typeof data.description === "string" ? data.description : undefined;
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  return {
    sessionID,
    text,
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Decode a native session.execution.failed/session.execution.interrupted envelope. */
export function decodeExecutionTerminalEvent(
  event: unknown,
): NativeExecutionTerminalEvent | undefined {
  const envelope = readEnvelope(event);
  if (!envelope) return undefined;
  const { type, data } = envelope;
  if (type === "session.execution.failed") {
    const error = decodeStructuredError(data.error);
    if (error === undefined) return undefined;
    const sessionID = data.sessionID;
    if (typeof sessionID !== "string") return undefined;
    return { sessionID, status: "failed", error };
  }
  if (type === "session.execution.interrupted") {
    const sessionID = data.sessionID;
    const reason = data.reason;
    if (typeof sessionID !== "string") return undefined;
    if (
      reason !== "user" &&
      reason !== "shutdown" &&
      reason !== "superseded" &&
      reason !== "inactivity"
    ) {
      return undefined;
    }
    return { sessionID, status: "interrupted", reason };
  }
  return undefined;
}

/**
 * Strict evidence bundle for one candidate cancellation recovery. Every field is
 * required and independently verified; the caller must supply evidence observed
 * from authoritative native sources only.
 */
export interface CancellationEvidence {
  /** Session that owned the subagent tool call (the workflow/controller session). */
  readonly parentSessionId: string;
  /** Stable native tool call identity of the terminated subagent call. */
  readonly callID: string;
  /** Child session the termination names; must match every other child reference. */
  readonly childSessionId: string;
  /** Parent tool-call termination; only cancelled/interrupted qualify, never a generic failure. */
  readonly parentToolFailure: SubagentToolFailure;
  /** Child's structured terminal abort; only `{type:"aborted"}` qualifies. */
  readonly childTerminalError: NativeStructuredError;
  /** True when the child still has an active execution/inbox; quiescence requires false. */
  readonly childActive: boolean;
}

/** Cancellation evidence evaluation outcome. */
export type CancellationEvidenceDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Approve cancellation settlement only when the parent tool-call termination is an
 * authoritative cancellation/interruption naming the child, the child reports a
 * terminal structured abort, and the child is quiescent. A plain provider failure,
 * a different/wrong child, an unspecified call, or an active child all refuse.
 */
export function evaluateCancellationEvidence(
  evidence: CancellationEvidence,
): CancellationEvidenceDecision {
  const { parentToolFailure } = evidence;
  if (parentToolFailure.kind === "failed") {
    return { ok: false, reason: "PARENT_TOOL_FAILURE_NOT_CANCELLATION" };
  }
  if (parentToolFailure.childSessionId !== evidence.childSessionId) {
    return { ok: false, reason: "PARENT_CHILD_SESSION_MISMATCH" };
  }
  if (!isAbortedStructuredError(evidence.childTerminalError)) {
    return { ok: false, reason: "CHILD_TERMINAL_NOT_ABORTED" };
  }
  if (evidence.childActive) {
    return { ok: false, reason: "CHILD_STILL_ACTIVE" };
  }
  return { ok: true };
}
