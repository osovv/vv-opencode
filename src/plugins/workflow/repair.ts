// FILE: src/plugins/workflow/repair.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Recognize resumable native subagent/task envelopes and perform one bounded same-child continuation for malformed tracked outputs using the native session prompt/wait/message surface.
//   SCOPE: Native `<subagent ...>` and legacy task envelope parsing, protocol-error-aware continuation prompt construction from the shared status/route contract that preserves work-item identity while reporting a truthful post-continuation status/route, explicit hard-stop status detection preserving the observed substantive stop for terminal settlement, continued-output extraction from native assistant messages, and one same-child continuation call. No child creation, no tool/agent override, no forged result status.
//   DEPENDS: [@opencode/client, src/plugins/workflow/protocol.ts, src/plugins/workflow/host.ts]
//   LINKS: [M-WORKFLOW-REPAIR, M-WORKFLOW-PROTOCOL, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ResumableTaskEnvelope - Recognized native resumable task wrapper metadata plus inner tracked result text.
//   unwrapResumableTaskResult - Extracts tracked result text from known native/legacy subagent envelopes.
//   buildTrackedResultRepairPrompt - Constructs the strict bounded-continuation prompt for the same child session with a truthful post-continuation status/route.
//   hasExplicitHardStopStatus - Detects explicit BLOCKED/NEEDS_CONTEXT protocol status lines before any continuation.
//   detectExplicitHardStopStatus - Returns the explicit BLOCKED/NEEDS_CONTEXT status line value, if any.
//   isTrackedResultRepairEligible - Restricts the one-shot continuation to safe protocol error classes.
//   NativeRepairClient - Narrow full-client surface (session prompt/wait + message list) used for the continuation.
//   attemptTrackedResultRepair - Continues the same child session once and returns a NEW terminal assistant created at/after the accepted prompt.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-004 attempt 4 - Continuation requires a NEW assistant id absent before the prompt with finite created+completed, created at/after the authoritative accepted timestamp, and no terminal error; invalid acceptance timestamps fail closed (no wall-clock substitution).]
// END_CHANGE_SUMMARY

import {
  describeStatusVocabulary,
  resultBlockRequiresRoute,
  type ProtocolErrorCode,
  type TrackedAgentName,
} from "./protocol.js";
import { parseSubagentCompletionElement } from "./host.js";

export type ResumableTaskEnvelope = {
  taskId: string;
  innerResult: string;
  format: "subagent_element" | "resumable_header" | "task_element";
};

const RESUMABLE_TASK_ID_RE =
  /^task_id:\s+(\S+)\s+\(for resuming to continue this task if needed\)$/;

const SAFE_TRACKED_RESULT_REPAIR_CODES: ReadonlySet<ProtocolErrorCode> = new Set([
  "MISSING_STATUS",
  "MISSING_ROUTE",
  "UNEXPECTED_TOP_BLOCK_LINE",
  "MISSING_BODY_SEPARATOR",
]);

const TASK_ELEMENT_OPEN_RE = /^<task\s+id="([^"]+)"\s+state="([^"]+)"\s*>$/;

/**
 * Conservative deterministic detector for explicit protocol hard-stop status
 * lines. It matches only a `VVOC_STATUS:` line whose value begins with BLOCKED
 * or NEEDS_CONTEXT, so natural-language text cannot suppress a continuation.
 */
const EXPLICIT_HARD_STOP_STATUS_RE = /^\s*VVOC_STATUS\s*:\s*(BLOCKED|NEEDS_CONTEXT)\b/;

function parseResumableTaskEnvelope(output: string): ResumableTaskEnvelope | undefined {
  const normalizedOutput = output.replace(/\r\n/g, "\n");
  const lines = normalizedOutput.split("\n");
  const firstMeaningfulIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningfulIndex < 0) {
    return undefined;
  }

  const firstMeaningfulLine = lines[firstMeaningfulIndex]?.trim() ?? "";
  const taskIdMatch = RESUMABLE_TASK_ID_RE.exec(firstMeaningfulLine);
  if (!taskIdMatch) {
    return undefined;
  }

  let startTagIndex = firstMeaningfulIndex + 1;
  while (startTagIndex < lines.length && (lines[startTagIndex] ?? "").trim().length === 0) {
    startTagIndex += 1;
  }

  if ((lines[startTagIndex] ?? "").trim() !== "<task_result>") {
    return undefined;
  }

  const endTagIndex = lines.findIndex(
    (line, index) => index > startTagIndex && line.trim() === "</task_result>",
  );
  if (endTagIndex < 0) {
    return undefined;
  }

  const suffixLines = lines.slice(endTagIndex + 1);
  if (suffixLines.some((line) => line.trim().length > 0)) {
    return undefined;
  }

  return {
    taskId: taskIdMatch[1],
    innerResult: lines
      .slice(startTagIndex + 1, endTagIndex)
      .join("\n")
      .trim(),
    format: "resumable_header",
  };
}

/**
 * Parse the legacy OpenCode `<task id="ses_..." state="completed">...</task>` envelope format.
 * Also strips any nested `<task_result>`/`</task_result>` wrapper inside the element body.
 */
function parseTaskElementEnvelope(output: string): ResumableTaskEnvelope | undefined {
  const normalizedOutput = output.replace(/\r\n/g, "\n");
  const lines = normalizedOutput.split("\n");
  const firstMeaningfulIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningfulIndex < 0) {
    return undefined;
  }

  const firstMeaningfulLine = lines[firstMeaningfulIndex]?.trim() ?? "";
  const openTagMatch = TASK_ELEMENT_OPEN_RE.exec(firstMeaningfulLine);
  if (!openTagMatch) {
    return undefined;
  }

  const taskId = openTagMatch[1];

  const closeTagIndex = lines.findIndex(
    (line, index) => index > firstMeaningfulIndex && line.trim() === "</task>",
  );
  if (closeTagIndex < 0) {
    return undefined;
  }

  let innerLines = lines.slice(firstMeaningfulIndex + 1, closeTagIndex);

  const innerFirstIdx = innerLines.findIndex((line) => line.trim().length > 0);
  if (innerFirstIdx >= 0) {
    const innerFirstTrimmed = innerLines[innerFirstIdx]?.trim() ?? "";
    if (innerFirstTrimmed === "<task_result>") {
      const innerCloseIdx = innerLines.findIndex(
        (line, index) => index > innerFirstIdx && line.trim() === "</task_result>",
      );
      if (innerCloseIdx >= 0) {
        innerLines = innerLines.slice(innerFirstIdx + 1, innerCloseIdx);
      }
    }
  }

  return {
    taskId,
    innerResult: innerLines.join("\n").trim(),
    format: "task_element",
  };
}

/**
 * Extract tracked result text from a known native subagent delivery envelope
 * (`<subagent sessionID="..." state="...">...</subagent>`). Other states still
 * unwrap so a terminal cancellation/failure body is never mistaken for a result.
 */
function parseSubagentElementEnvelope(output: string): ResumableTaskEnvelope | undefined {
  const parsed = parseSubagentCompletionElement(output);
  if (!parsed) return undefined;
  return { taskId: parsed.sessionID, innerResult: parsed.output, format: "subagent_element" };
}

export function unwrapResumableTaskResult(output: string): {
  normalizedOutput: string;
  envelope?: ResumableTaskEnvelope;
} {
  const subagentEnvelope = parseSubagentElementEnvelope(output);
  if (subagentEnvelope) {
    return { normalizedOutput: subagentEnvelope.innerResult, envelope: subagentEnvelope };
  }

  const taskElementEnvelope = parseTaskElementEnvelope(output);
  if (taskElementEnvelope) {
    return { normalizedOutput: taskElementEnvelope.innerResult, envelope: taskElementEnvelope };
  }

  const envelope = parseResumableTaskEnvelope(output);
  return {
    normalizedOutput: envelope?.innerResult ?? output,
    ...(envelope ? { envelope } : {}),
  };
}

export function buildTrackedResultRepairPrompt(options: {
  agent: TrackedAgentName;
  workItemId: string;
  malformedOutput: string;
  parseErrorCode?: ProtocolErrorCode;
  parseErrorMessage: string;
}): string {
  const statusGuidance = `Allowed VVOC_STATUS values: ${describeStatusVocabulary(options.agent)}.`;
  const requiresRoute = resultBlockRequiresRoute(options.agent);
  const routeGuidance = requiresRoute
    ? "Include `VVOC_ROUTE` in the strict top block, consistent with the original assignment; do not invent a route that conflicts with it."
    : "Do not include `VVOC_ROUTE`.";

  const exactFormat = [
    `VVOC_WORK_ITEM_ID: ${options.workItemId}`,
    "VVOC_STATUS: <truthful status>",
    ...(requiresRoute ? ["VVOC_ROUTE: <route consistent with the original assignment>"] : []),
    "",
    "<brief result handoff>",
  ].join("\n");
  const missingBodySeparatorGuidance =
    options.parseErrorCode === "MISSING_BODY_SEPARATOR" ||
    options.parseErrorMessage.includes("MISSING_BODY_SEPARATOR")
      ? "The body text was placed inside the strict protocol top block. Move all findings, questions, or result body text below a blank line after the protocol header."
      : undefined;

  return [
    `Your previous final response for ${options.workItemId} was malformed for the workflow result protocol.`,
    `Protocol error: ${options.parseErrorMessage}`,
    "This is a bounded continuation in the same session. Preserve the same work item identity and the original assignment, role, and write scope, and use your existing history and currently permitted tools.",
    "Finish any unfinished implementation or review work from that original assignment; if it was already complete, correct only the final report without repeating completed work, inventing evidence, or misrepresenting the established outcome.",
    "Report the VVOC_STATUS that truthfully reflects the result after this continuation; do not freeze a missing or outdated status from before it.",
    "If the honest outcome is BLOCKED or NEEDS_CONTEXT, report that status explicitly in the corrected response instead of continuing.",
    statusGuidance,
    routeGuidance,
    ...(missingBodySeparatorGuidance ? [missingBodySeparatorGuidance] : []),
    "Begin the corrected response with the protocol block on the first line: no preface, prose, or code fences before it.",
    "Return only the corrected final response in this exact shape:",
    exactFormat,
    "Previous malformed response:",
    "<<<MALFORMED_RESULT",
    options.malformedOutput.trim() || "<empty>",
    ">>>",
  ].join("\n");
}

/** Returns the explicit hard-stop status value on a protocol status line, if any. */
export function detectExplicitHardStopStatus(
  output: string,
): "BLOCKED" | "NEEDS_CONTEXT" | undefined {
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const match = EXPLICIT_HARD_STOP_STATUS_RE.exec(line);
    if (match) {
      return match[1] as "BLOCKED" | "NEEDS_CONTEXT";
    }
  }
  return undefined;
}

export function hasExplicitHardStopStatus(output: string): boolean {
  return detectExplicitHardStopStatus(output) !== undefined;
}

export function isTrackedResultRepairEligible(code: ProtocolErrorCode): boolean {
  return SAFE_TRACKED_RESULT_REPAIR_CODES.has(code);
}

/** Narrow native client surface used for one same-child continuation. */
export interface NativeRepairClient {
  readonly session: {
    prompt(input: { readonly sessionID: string; readonly text: string }): Promise<unknown>;
    wait(input: { readonly sessionID: string }): Promise<void>;
  };
  readonly message: {
    list(input: {
      readonly sessionID: string;
      readonly order?: "asc" | "desc";
      readonly limit?: number;
      readonly type?: string;
    }): Promise<unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Extract the text of one native assistant message, or undefined when it has none. */
function assistantMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.type !== "assistant") return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => {
      return isRecord(part) && part.type === "text" && typeof part.text === "string";
    })
    .map((part) => part.text)
    .join("")
    .trim();
  return text === "" ? undefined : text;
}

/**
 * Continue the SAME child session exactly once after a malformed final report.
 * The native prompt preserves the child's agent, model, permissions and
 * history, and this retrieves only a NEW terminal assistant created at or after
 * the accepted prompt; an old assistant returned by a projected context view or
 * a continuation that produced no new output is never treated as a corrected
 * result. Any prompt or retrieval failure returns undefined.
 */
export async function attemptTrackedResultRepair(options: {
  client: NativeRepairClient;
  sessionId: string;
  agent: TrackedAgentName;
  workItemId: string;
  malformedOutput: string;
  parseErrorCode?: ProtocolErrorCode;
  parseErrorMessage: string;
}): Promise<string | undefined> {
  try {
    // Record existing message identities BEFORE the prompt so a stale
    // same-millisecond assistant can never be accepted as the continuation.
    const beforeIds = new Set<string>();
    const beforeList = await options.client.message.list({
      sessionID: options.sessionId,
      order: "desc",
      limit: 50,
    });
    const beforeData =
      isRecord(beforeList) && Array.isArray(beforeList.data)
        ? beforeList.data
        : Array.isArray(beforeList)
          ? beforeList
          : undefined;
    if (beforeData === undefined) return undefined;
    for (const message of beforeData) {
      if (isRecord(message) && typeof message.id === "string") beforeIds.add(message.id);
    }

    const accepted = await options.client.session.prompt({
      sessionID: options.sessionId,
      text: buildTrackedResultRepairPrompt({
        agent: options.agent,
        workItemId: options.workItemId,
        malformedOutput: options.malformedOutput,
        parseErrorCode: options.parseErrorCode,
        parseErrorMessage: options.parseErrorMessage,
      }),
    });
    // The native acceptance response is authoritative. An invalid/absent
    // created timestamp is NOT replaced by wall clock; the continuation fails.
    const acceptedRecord = isRecord(accepted) ? accepted : undefined;
    const acceptedTime =
      acceptedRecord && isRecord(acceptedRecord.time)
        ? readFiniteNumber(acceptedRecord.time.created)
        : undefined;
    if (acceptedTime === undefined || acceptedTime <= 0) return undefined;

    await options.client.session.wait({ sessionID: options.sessionId });
    const list = await options.client.message.list({
      sessionID: options.sessionId,
      order: "desc",
      limit: 50,
      type: "assistant",
    });
    const data =
      isRecord(list) && Array.isArray(list.data) ? list.data : Array.isArray(list) ? list : [];
    for (const message of data) {
      if (!isRecord(message) || message.type !== "assistant") continue;
      const id = message.id;
      // A NEW assistant: not present before the accepted continuation.
      if (typeof id !== "string" || beforeIds.has(id)) continue;
      const time = isRecord(message.time) ? message.time : undefined;
      const created = time ? readFiniteNumber(time.created) : undefined;
      const completed = time ? readFiniteNumber(time.completed) : undefined;
      if (created === undefined || completed === undefined) continue;
      if (created < acceptedTime) continue;
      // A terminal error is not a corrected report.
      if (message.error !== undefined) continue;
      const text = assistantMessageText(message);
      if (text !== undefined) return text;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
