// FILE: src/plugins/workflow/repair.ts
// VERSION: 0.1.2
// START_MODULE_CONTRACT
//   PURPOSE: Recognize resumable OpenCode task envelopes and perform one bounded tracked-result repair attempt in the same child session.
//   SCOPE: OpenCode task envelope parsing, repair prompt construction, repaired text extraction, and same-session repair calls for tracked workflow results.
//   DEPENDS: [@opencode-ai/plugin, @opencode-ai/sdk, src/plugins/workflow/protocol.ts]
//   LINKS: [M-WORKFLOW-REPAIR, M-WORKFLOW-PROTOCOL, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ResumableTaskEnvelope - Recognized OpenCode resumable task wrapper metadata plus inner tracked result text.
//   unwrapResumableTaskResult - Extracts tracked result text only from known resumable OpenCode task envelopes.
//   buildTrackedResultRepairPrompt - Constructs the strict one-shot repair prompt for the same child session.
//   isTrackedResultRepairEligible - Restricts one-shot repair to safe format-only protocol error classes.
//   attemptTrackedResultRepair - Resumes the same child session once and returns repaired tracked result text when possible.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.2 - Excluded duplicate strict top-block field errors from same-session repair so ambiguous tracked results fail closed.]
//   LAST_CHANGE: [v0.1.1 - Restricted repair to safe format-only protocol errors and sent format-only prompt requests with tools disabled where supported.]
//   LAST_CHANGE: [v0.1.0 - Added bounded same-session result repair helpers for malformed tracked workflow outputs in resumable OpenCode task envelopes.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { ProtocolErrorCode, TrackedAgentName } from "./protocol.js";

export type ResumableTaskEnvelope = {
  taskId: string;
  innerResult: string;
};

const RESUMABLE_TASK_ID_RE =
  /^task_id:\s+(\S+)\s+\(for resuming to continue this task if needed\)$/;

const SAFE_TRACKED_RESULT_REPAIR_CODES: ReadonlySet<ProtocolErrorCode> = new Set([
  "MISSING_STATUS",
  "MISSING_ROUTE",
  "UNEXPECTED_TOP_BLOCK_LINE",
]);

const FORMAT_ONLY_REPAIR_SYSTEM_PROMPT =
  "Format-only workflow repair. Do not call tools, do not perform implementation or review work, and do not cause side effects. Return only the corrected final response text.";

const FORMAT_ONLY_REPAIR_DISABLED_TOOLS: Readonly<Record<string, boolean>> = {
  apply_patch: false,
  bash: false,
  edit: false,
  glob: false,
  grep: false,
  multi_tool_use: false,
  read: false,
  task: false,
  work_item_close: false,
  work_item_list: false,
  work_item_open: false,
  write: false,
};

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
  };
}

export function unwrapResumableTaskResult(output: string): {
  normalizedOutput: string;
  envelope?: ResumableTaskEnvelope;
} {
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
  parseErrorMessage: string;
}): string {
  const statusGuidance =
    options.agent === "vv-implementer"
      ? "Allowed VVOC_STATUS values: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED."
      : "Allowed VVOC_STATUS values: PASS | FAIL | NEEDS_CONTEXT.";
  const routeGuidance =
    options.agent === "vv-implementer"
      ? "Include `VVOC_ROUTE` in the strict top block and preserve the route that matches your prior result."
      : "Do not include `VVOC_ROUTE`.";

  const exactFormat = [
    `VVOC_WORK_ITEM_ID: ${options.workItemId}`,
    "VVOC_STATUS: <allowed status>",
    ...(options.agent === "vv-implementer" ? ["VVOC_ROUTE: <existing route>"] : []),
    "",
    "<brief result handoff>",
  ].join("\n");

  return [
    `Your previous final response for ${options.workItemId} was malformed for the workflow result protocol.`,
    `Protocol error: ${options.parseErrorMessage}`,
    "Repair only the response format. Do not do additional implementation or review work.",
    "Keep the same underlying outcome and same work item.",
    statusGuidance,
    routeGuidance,
    "Return only the corrected final response in this exact shape:",
    exactFormat,
    "Previous malformed response:",
    "<<<MALFORMED_RESULT",
    options.malformedOutput.trim() || "<empty>",
    ">>>",
  ].join("\n");
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
        system: FORMAT_ONLY_REPAIR_SYSTEM_PROMPT,
        tools: FORMAT_ONLY_REPAIR_DISABLED_TOOLS,
        parts: [
          {
            type: "text",
            text: buildTrackedResultRepairPrompt({
              agent: options.agent,
              workItemId: options.workItemId,
              malformedOutput: options.malformedOutput,
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
