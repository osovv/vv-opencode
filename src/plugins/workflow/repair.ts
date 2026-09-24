// FILE: src/plugins/workflow/repair.ts
// VERSION: 0.2.1
// START_MODULE_CONTRACT
//   PURPOSE: Recognize resumable OpenCode task envelopes and perform one bounded same-session continuation for malformed tracked outputs, letting the original subagent finish unfinished work or truthfully correct its final report.
//   SCOPE: OpenCode task envelope parsing, protocol-error-aware continuation prompt construction from the shared status/route contract that preserves work-item identity while reporting a truthful post-continuation status/route, explicit hard-stop status detection preserving the observed substantive stop for terminal settlement, continued-output extraction, and same-session continuation calls for tracked workflow results.
//   DEPENDS: [@opencode-ai/plugin, @opencode-ai/sdk, src/plugins/workflow/protocol.ts]
//   LINKS: [M-WORKFLOW-REPAIR, M-WORKFLOW-PROTOCOL, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ResumableTaskEnvelope - Recognized OpenCode resumable task wrapper metadata plus inner tracked result text.
//   unwrapResumableTaskResult - Extracts tracked result text only from known resumable OpenCode task envelopes.
//   buildTrackedResultRepairPrompt - Constructs the strict bounded-continuation prompt for the same child session with a truthful post-continuation status/route.
//   hasExplicitHardStopStatus - Detects explicit BLOCKED/NEEDS_CONTEXT protocol status lines before any continuation.
//   detectExplicitHardStopStatus - Returns the explicit BLOCKED/NEEDS_CONTEXT status line value, if any.
//   isTrackedResultRepairEligible - Restricts the one-shot continuation to safe protocol error classes.
//   attemptTrackedResultRepair - Continues the same child session once and returns corrected tracked result text when possible.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-007 - Generated the continuation status vocabulary and route requirement from the shared protocol contract and stated the first-line/no-fence rule; repair eligibility is unchanged. Prior: detectExplicitHardStopStatus preserves the exact observed substantive stop.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import {
  describeStatusVocabulary,
  resultBlockRequiresRoute,
  type ProtocolErrorCode,
  type TrackedAgentName,
} from "./protocol.js";

export type ResumableTaskEnvelope = {
  taskId: string;
  innerResult: string;
  format: "resumable_header" | "task_element";
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

const TRACKED_RESULT_CONTINUATION_SYSTEM_PROMPT =
  "Bounded same-session workflow continuation. Preserve the original work item, assignment, role, and write scope. Finish any unfinished implementation or review work using your existing history and currently permitted tools, or, if it was already complete, correct only the final report. Report the VVOC_STATUS and VVOC_ROUTE that truthfully reflect the result after this continuation.";

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
 * Parse the new OpenCode `<task id="ses_..." state="completed">...</task>` envelope format.
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

  // Find closing </task> tag
  const closeTagIndex = lines.findIndex(
    (line, index) => index > firstMeaningfulIndex && line.trim() === "</task>",
  );
  if (closeTagIndex < 0) {
    return undefined;
  }

  // Extract inner content (between open and close tags)
  let innerLines = lines.slice(firstMeaningfulIndex + 1, closeTagIndex);

  // Strip outer <task_result>/</task_result> wrapper if present
  const innerFirstIdx = innerLines.findIndex((line) => line.trim().length > 0);
  if (innerFirstIdx >= 0) {
    const innerFirstTrimmed = innerLines[innerFirstIdx]?.trim() ?? "";
    if (innerFirstTrimmed === "<task_result>") {
      // Find the closing </task_result>
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

export function unwrapResumableTaskResult(output: string): {
  normalizedOutput: string;
  envelope?: ResumableTaskEnvelope;
} {
  // Try the new <task> element format first
  const taskElementEnvelope = parseTaskElementEnvelope(output);
  if (taskElementEnvelope) {
    return {
      normalizedOutput: taskElementEnvelope.innerResult,
      ...(taskElementEnvelope ? { envelope: taskElementEnvelope } : {}),
    };
  }

  // Fall back to the old resumable task header format
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

function extractTextParts(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export async function attemptTrackedResultRepair(options: {
  client: Parameters<Plugin>[0]["client"];
  directory: string;
  taskId: string;
  agent: TrackedAgentName;
  workItemId: string;
  malformedOutput: string;
  parseErrorCode?: ProtocolErrorCode;
  parseErrorMessage: string;
}): Promise<string | undefined> {
  try {
    const response = await options.client.session.prompt({
      path: {
        id: options.taskId,
      },
      query: {
        directory: options.directory,
      },
      body: {
        agent: options.agent,
        system: TRACKED_RESULT_CONTINUATION_SYSTEM_PROMPT,
        parts: [
          {
            type: "text",
            text: buildTrackedResultRepairPrompt({
              agent: options.agent,
              workItemId: options.workItemId,
              malformedOutput: options.malformedOutput,
              parseErrorCode: options.parseErrorCode,
              parseErrorMessage: options.parseErrorMessage,
            }),
          },
        ],
      },
    });

    if (response.error || !response.data) {
      return undefined;
    }

    const repairedOutput = extractTextParts(response.data.parts ?? []);
    return repairedOutput || undefined;
  } catch {
    return undefined;
  }
}
