// FILE: src/plugins/workflow/protocol.ts
// VERSION: 0.1.2
// START_MODULE_CONTRACT
//   PURPOSE: Define the tracked subagent result protocol, strict top-block parsing rules, and work-item header extraction.
//   SCOPE: Tracked agent/status constants, status validation per agent, strict result-block parsing, protocol error reporting, and VVOC_WORK_ITEM_ID header parsing.
//   DEPENDS: [none]
//   LINKS: [M-WORKFLOW-PROTOCOL]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TrackedAgentName - Tracked subagent names used by workflow enforcement.
//   VVocStatus - Union of all supported protocol statuses.
//   ParsedResultBlock - Parsed strict top-block fields from tracked subagent output.
//   ProtocolErrorCode - Stable machine-readable protocol error codes.
//   ProtocolError - Structured protocol error payload.
//   ProtocolResult - Deterministic success/failure wrapper for parsing and validation operations.
//   TRACKED_SUBAGENT_NAMES - Ordered tracked subagent names.
//   ALLOWED_STATUSES - Allowed VVOC_STATUS values per tracked subagent.
//   parseResultBlock - Parses strict top-block protocol fields from tracked subagent output.
//   validateStatusForAgent - Validates VVOC_STATUS against tracked agent allowances.
//   parseWorkItemHeader - Extracts and validates the top-line VVOC_WORK_ITEM_ID prompt header.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.2 - Rejected duplicate strict top-block protocol fields to keep parse outcomes deterministic.]
//   LAST_CHANGE: [v0.1.1 - Enforced case-sensitive status validation and strict top-block line validation for protocol-only fields.]
//   LAST_CHANGE: [v0.1.0 - Added workflow protocol grammar, strict top-block parser, per-agent status validation, and prompt-header extraction.]
// END_CHANGE_SUMMARY

export const TRACKED_SUBAGENT_NAMES = [
  "vv-implementer",
  "vv-spec-reviewer",
  "vv-code-reviewer",
] as const;

export type TrackedAgentName = (typeof TRACKED_SUBAGENT_NAMES)[number];

export const ALLOWED_STATUSES = {
  "vv-implementer": ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
  "vv-spec-reviewer": ["PASS", "FAIL", "NEEDS_CONTEXT"],
  "vv-code-reviewer": ["PASS", "FAIL", "NEEDS_CONTEXT"],
} as const;

export type VVocStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "NEEDS_CONTEXT"
  | "BLOCKED"
  | "PASS"
  | "FAIL";

export type ParsedResultBlock = {
  agent: TrackedAgentName;
  workItemId: string;
  status: VVocStatus;
  route?: string;
};

export type ProtocolErrorCode =
  | "MISSING_WORK_ITEM_ID"
  | "MISSING_STATUS"
  | "MISSING_ROUTE"
  | "UNKNOWN_STATUS"
  | "STATUS_NOT_ALLOWED"
  | "UNEXPECTED_TOP_BLOCK_LINE"
  | "DUPLICATE_TOP_BLOCK_FIELD"
  | "WORK_ITEM_MISMATCH"
  | "MALFORMED_WORK_ITEM_HEADER"
  | "MISSING_WORK_ITEM_HEADER";

export type ProtocolError = {
  code: ProtocolErrorCode;
  message: string;
};

export type ProtocolResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: ProtocolError;
    };

const WORK_ITEM_HEADER_RE = /^VVOC_WORK_ITEM_ID:\s*(wi-\d+)\s*$/;

function createProtocolError(code: ProtocolErrorCode, message: string): ProtocolResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function splitTopBlock(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstMeaningfulIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningfulIndex < 0) return [];

  const block: string[] = [];
  for (let index = firstMeaningfulIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      break;
    }
    block.push(line.trim());
  }

  return block;
}

function readTopBlockField(topBlockLines: string[], field: string): string | undefined {
  const fieldPattern = new RegExp(`^${field}\\s*:\\s*(.+)$`);
  for (const line of topBlockLines) {
    const match = fieldPattern.exec(line);
    if (!match) {
      continue;
    }

    const value = match[1]?.trim() ?? "";
    return value || undefined;
  }
  return undefined;
}

function validateTopBlockLines(topBlockLines: string[]): ProtocolResult<true> {
  const allowedFields = new Set(["VVOC_WORK_ITEM_ID", "VVOC_STATUS", "VVOC_ROUTE"]);
  const seenFields = new Set<string>();

  for (const line of topBlockLines) {
    const match = /^([A-Z_]+)\s*:\s*(.+)$/.exec(line);
    if (!match) {
      return createProtocolError(
        "UNEXPECTED_TOP_BLOCK_LINE",
        `UNEXPECTED_TOP_BLOCK_LINE: strict top block contains a non-protocol line \`${line}\``,
      );
    }

    const field = match[1] ?? "";
    if (!allowedFields.has(field)) {
      return createProtocolError(
        "UNEXPECTED_TOP_BLOCK_LINE",
        `UNEXPECTED_TOP_BLOCK_LINE: strict top block field \`${field}\` is not recognized`,
      );
    }

    if (seenFields.has(field)) {
      return createProtocolError(
        "DUPLICATE_TOP_BLOCK_FIELD",
        `DUPLICATE_TOP_BLOCK_FIELD: strict top block repeats field \`${field}\``,
      );
    }
    seenFields.add(field);
  }

  return { ok: true, value: true };
}

// START_CONTRACT: validateStatusForAgent
//   PURPOSE: Validate that the provided VVOC_STATUS value is allowed for a tracked subagent.
//   INPUTS: { agent: TrackedAgentName - tracked subagent name, status: string - candidate status value }
//   OUTPUTS: { ProtocolResult<VVocStatus> - normalized status success or protocol validation error }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-PROTOCOL]
// END_CONTRACT: validateStatusForAgent
export function validateStatusForAgent(
  agent: TrackedAgentName,
  status: string,
): ProtocolResult<VVocStatus> {
  const normalized = status.trim();
  const allowed = ALLOWED_STATUSES[agent] as readonly string[];
  const allKnownStatuses: Set<string> = new Set(
    Object.values(ALLOWED_STATUSES).flatMap((entries) => [...entries]),
  );

  if (!allKnownStatuses.has(normalized)) {
    return createProtocolError(
      "UNKNOWN_STATUS",
      `UNKNOWN_STATUS: ${normalized || "<empty>"} is not a recognized VVOC_STATUS`,
    );
  }

  if (!allowed.some((entry) => entry === normalized)) {
    return createProtocolError(
      "STATUS_NOT_ALLOWED",
      `STATUS_NOT_ALLOWED: ${normalized} is not allowed for ${agent}`,
    );
  }

  return {
    ok: true,
    value: normalized as VVocStatus,
  };
}

// START_CONTRACT: parseResultBlock
//   PURPOSE: Parse strict top-block workflow protocol fields from tracked subagent output.
//   INPUTS: { agent: TrackedAgentName - tracked subagent source, output: string - subagent textual output, expectedWorkItemId?: string - optional ID to match against parsed output }
//   OUTPUTS: { ProtocolResult<ParsedResultBlock> - parsed protocol fields or protocol error }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-PROTOCOL]
// END_CONTRACT: parseResultBlock
// START_BLOCK_PARSE_RESULT
export function parseResultBlock(options: {
  agent: TrackedAgentName;
  output: string;
  expectedWorkItemId?: string;
}): ProtocolResult<ParsedResultBlock> {
  const topBlockLines = splitTopBlock(options.output);
  const topBlockValidation = validateTopBlockLines(topBlockLines);
  if (!topBlockValidation.ok) {
    return topBlockValidation;
  }

  const workItemId = readTopBlockField(topBlockLines, "VVOC_WORK_ITEM_ID");
  if (!workItemId) {
    return createProtocolError(
      "MISSING_WORK_ITEM_ID",
      "MISSING_WORK_ITEM_ID: strict top block must include VVOC_WORK_ITEM_ID",
    );
  }

  if (!/^wi-\d+$/.test(workItemId)) {
    return createProtocolError(
      "MISSING_WORK_ITEM_ID",
      `MISSING_WORK_ITEM_ID: invalid work item id format ${workItemId}`,
    );
  }

  if (options.expectedWorkItemId && options.expectedWorkItemId !== workItemId) {
    return createProtocolError(
      "WORK_ITEM_MISMATCH",
      `WORK_ITEM_MISMATCH: expected ${options.expectedWorkItemId} but parsed ${workItemId}`,
    );
  }

  const rawStatus = readTopBlockField(topBlockLines, "VVOC_STATUS");
  if (!rawStatus) {
    return createProtocolError(
      "MISSING_STATUS",
      "MISSING_STATUS: strict top block must include VVOC_STATUS",
    );
  }

  const statusValidation = validateStatusForAgent(options.agent, rawStatus);
  if (!statusValidation.ok) {
    return statusValidation;
  }

  const route = readTopBlockField(topBlockLines, "VVOC_ROUTE");
  if (options.agent === "vv-implementer" && !route) {
    return createProtocolError(
      "MISSING_ROUTE",
      "MISSING_ROUTE: vv-implementer output must include VVOC_ROUTE",
    );
  }

  return {
    ok: true,
    value: {
      agent: options.agent,
      workItemId,
      status: statusValidation.value,
      ...(route ? { route } : {}),
    },
  };
}
// END_BLOCK_PARSE_RESULT

// START_CONTRACT: parseWorkItemHeader
//   PURPOSE: Extract VVOC_WORK_ITEM_ID from the first meaningful line of a tracked subagent prompt header.
//   INPUTS: { promptText: string - full prompt text }
//   OUTPUTS: { ProtocolResult<string> - parsed work item ID or protocol error }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-PROTOCOL]
// END_CONTRACT: parseWorkItemHeader
export function parseWorkItemHeader(promptText: string): ProtocolResult<string> {
  const lines = promptText.replace(/\r\n/g, "\n").split("\n");
  const firstMeaningfulLine = lines.find((line) => line.trim().length > 0)?.trim();

  if (!firstMeaningfulLine) {
    return createProtocolError(
      "MISSING_WORK_ITEM_HEADER",
      "MISSING_WORK_ITEM_HEADER: prompt must begin with VVOC_WORK_ITEM_ID header",
    );
  }

  const match = WORK_ITEM_HEADER_RE.exec(firstMeaningfulLine);
  if (!match) {
    return createProtocolError(
      "MALFORMED_WORK_ITEM_HEADER",
      `MALFORMED_WORK_ITEM_HEADER: first meaningful line must match \`VVOC_WORK_ITEM_ID: wi-<n>\` but received \`${firstMeaningfulLine}\``,
    );
  }

  return {
    ok: true,
    value: match[1],
  };
}
