// FILE: src/plugins/workflow/host.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Map native OpenCode 2.0.18 subagent tool input/results and the background completion envelope onto the host-neutral workflow launch/result vocabulary.
//   SCOPE: Pure native-shape decoding only. No session/client access, no state mutation, no persistence, no budgets, no policy. Reads the pinned subagent input fields (agent/description/prompt/model?/sessionID?/background?) and the native structured result {sessionID,status,output} plus the `<subagent ...>` delivery element.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-DELEGATED, M-WORKFLOW-EXECUTION, V-M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeSubagentInput - Normalized pinned subagent input fields.
//   readNativeSubagentInput - Decode a native subagent tool input, or undefined when untrackable.
//   readSubagentAgent - Read the native subagent agent id field.
//   readSubagentPrompt - Read the native subagent prompt text.
//   FreshExclusiveLaunchEligibility - Whether a launch can be a fresh-exclusive tracked attempt.
//   evaluateFreshExclusiveLaunch - Exclude background/resume launches from fresh-exclusive eligibility.
//   NativeSubagentResult - Decoded native structured subagent result.
//   decodeNativeSubagentResult - Decode the native {sessionID,status,output} result object.
//   SubagentCompletionState - Native delivery states for a subagent completion element.
//   SubagentCompletionElement - Parsed `<subagent ...>` background/terminal delivery element.
//   parseSubagentCompletionElement - Parse the exact native completion element text.
//   WorkflowDiagnosticEvent - Bounded workflow diagnostic event.
//   WorkflowDiagnosticSink - Host-neutral workflow diagnostic sink contract.
//   createConsoleDiagnosticSink - Credential-safe console sink used because the native App is metadata-only (no host logger).
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-004 - Added the native subagent input/result/envelope mapping plus the credential-safe diagnostic sink that replaces the nonexistent V1 client.app.log.]
// END_CHANGE_SUMMARY

/** Normalized pinned native subagent input fields (`Input` in core/src/tool/plugin/subagent.ts). */
export interface NativeSubagentInput {
  readonly agent: string;
  readonly description: string;
  readonly prompt: string;
  readonly model?: string;
  readonly sessionID?: string;
  readonly background: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Read the native subagent agent id field (`agent`). */
export function readSubagentAgent(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  return readNonEmptyString(args.agent);
}

/** Read the native subagent prompt text (`prompt`). */
export function readSubagentPrompt(args: unknown): string {
  if (!isRecord(args)) return "";
  return typeof args.prompt === "string" ? args.prompt : "";
}

/**
 * Decode a native subagent tool input. Returns undefined when the agent id or
 * prompt is absent or non-string, so a host-shape mistake is never treated as a
 * tracked launch of some other agent.
 */
export function readNativeSubagentInput(args: unknown): NativeSubagentInput | undefined {
  if (!isRecord(args)) return undefined;
  const agent = readSubagentAgent(args);
  const prompt = readSubagentPrompt(args);
  if (agent === undefined || prompt === "") return undefined;
  const description = typeof args.description === "string" ? args.description : "";
  const model = readNonEmptyString(args.model);
  const sessionID = readNonEmptyString(args.sessionID);
  return {
    agent,
    description,
    prompt,
    ...(model === undefined ? {} : { model }),
    ...(sessionID === undefined ? {} : { sessionID }),
    background: args.background === true,
  };
}

/** Whether a launch can be a fresh-exclusive tracked attempt. */
export type FreshExclusiveLaunchEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: "requested_background" | "resume_session";
      readonly resumedChildSessionId?: string;
    };

/**
 * A fresh-exclusive tracked attempt is a foreground launch of a brand-new child.
 * Background launches and launches continuing an existing `sessionID` are
 * excluded, because the child already has history and can never be bound to one
 * terminal host call.
 */
export function evaluateFreshExclusiveLaunch(
  input: NativeSubagentInput,
): FreshExclusiveLaunchEligibility {
  if (input.background) {
    return { eligible: false, reason: "requested_background" };
  }
  if (input.sessionID !== undefined) {
    return { eligible: false, reason: "resume_session", resumedChildSessionId: input.sessionID };
  }
  return { eligible: true };
}

/** Decoded native structured subagent result (`Output` in core subagent.ts). */
export interface NativeSubagentResult {
  readonly sessionID: string;
  readonly status: "completed" | "running";
  readonly output: string;
}

/**
 * Decode the native structured subagent result object. A missing/invalid
 * sessionID or an unknown status refuses rather than being coerced.
 */
export function decodeNativeSubagentResult(value: unknown): NativeSubagentResult | undefined {
  if (!isRecord(value)) return undefined;
  const sessionID = readNonEmptyString(value.sessionID);
  if (sessionID === undefined) return undefined;
  const status = value.status;
  if (status !== "completed" && status !== "running") return undefined;
  const output = typeof value.output === "string" ? value.output : "";
  return { sessionID, status, output };
}

/** Native delivery states for a subagent completion element. */
export type SubagentCompletionState = "completed" | "error" | "cancelled";

/** Parsed native `<subagent ...>` delivery element. */
export interface SubagentCompletionElement {
  readonly sessionID: string;
  readonly state: SubagentCompletionState;
  readonly description?: string;
  readonly output: string;
}

// Exact native delivery frame from SubagentCompletion.deliver:
// `<subagent sessionID="ses_..." state="completed" description="...">\n<text>\n</subagent>`
const SUBAGENT_ELEMENT_OPEN_RE =
  /^<subagent\s+sessionID="([^"]+)"\s+state="(completed|error|cancelled)"(?:\s+description="([^"]*)")?\s*>$/;

/**
 * Parse the exact native subagent completion element. The element's first
 * meaningful line must be the open tag and the final `</subagent>` must close on
 * its own line; anything else is not a native completion and returns undefined.
 */
export function parseSubagentCompletionElement(
  text: string,
): SubagentCompletionElement | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const openIndex = lines.findIndex((line) => line.trim().length > 0);
  if (openIndex < 0) return undefined;
  const match = SUBAGENT_ELEMENT_OPEN_RE.exec((lines[openIndex] ?? "").trim());
  if (!match) return undefined;

  let closeIndex = -1;
  for (let index = lines.length - 1; index > openIndex; index -= 1) {
    if ((lines[index] ?? "").trim() === "</subagent>") {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex < 0) return undefined;
  if (lines.slice(closeIndex + 1).some((line) => line.trim().length > 0)) return undefined;

  const description = match[3];
  return {
    sessionID: match[1] as string,
    state: match[2] as SubagentCompletionState,
    ...(description === undefined || description === "" ? {} : { description }),
    output: lines
      .slice(openIndex + 1, closeIndex)
      .join("\n")
      .trim(),
  };
}

// START_BLOCK_DIAGNOSTICS
/** Bounded workflow diagnostic event. */
export interface WorkflowDiagnosticEvent {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Host-neutral workflow diagnostic sink contract (native App exposes metadata only). */
export interface WorkflowDiagnosticSink {
  log(event: WorkflowDiagnosticEvent): void;
}

const SENSITIVE_EXTRA_KEY_RE =
  /token|secret|password|passwd|bearer|authorization|credential|api[-_]?key/i;
const MAX_DIAGNOSTIC_VALUE_CHARS = 300;
const MAX_DIAGNOSTIC_LINE_CHARS = 1200;

function safeDiagnosticExtra(extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (SENSITIVE_EXTRA_KEY_RE.test(key)) {
      safe[key] = "<redacted>";
      continue;
    }
    if (typeof value === "string") {
      safe[key] =
        value.length > MAX_DIAGNOSTIC_VALUE_CHARS
          ? `${value.slice(0, MAX_DIAGNOSTIC_VALUE_CHARS)}…`
          : value;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * Build a credential-safe diagnostic sink. The pinned native plugin App is
 * only `{name, version, channel}` and the client exposes no `app.log`, so the
 * workflow writes bounded structured lines through an injectable sink instead
 * of a fabricated host API. Sensitive-looking extra keys are redacted and
 * every rendered line is length-bounded.
 */
export function createConsoleDiagnosticSink(options?: {
  readonly namespace?: string;
  readonly write?: (line: string) => void;
}): WorkflowDiagnosticSink {
  const namespace = options?.namespace ?? "workflow";
  const write = options?.write ?? ((line: string) => console.error(line));
  return {
    log(event) {
      const extra = event.extra === undefined ? undefined : safeDiagnosticExtra(event.extra);
      const line = `[${namespace}][${event.level}] ${event.message}${
        extra === undefined || Object.keys(extra).length === 0 ? "" : ` ${JSON.stringify(extra)}`
      }`;
      write(
        line.length > MAX_DIAGNOSTIC_LINE_CHARS
          ? `${line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)}…`
          : line,
      );
    },
  };
}
// END_BLOCK_DIAGNOSTICS
