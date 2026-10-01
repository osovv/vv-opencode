// FILE: src/plugins/workflow/authorization.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Workflow tool access guards and native-session-backed read-only authorization message lookups over an explicit plugin context.
//   SCOPE: Agent gating for workflow tools, primary root-controller mutation authorization (agent, trusted workspace, invalid-hydration, and root/fork identity through the native session.get), and the recovery and advance-authority message lookups through the native session.context retaining only identity, timing, and eligibility metadata. No tool definitions, stores, or persistence here.
//   DEPENDS: [src/plugins/workflow/delegated.ts (LookupRecoveryUserMessage type), src/plugins/workflow/authority.ts (AuthorityMessageSnapshot type)]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-DELEGATED, M-WORKFLOW-AUTHORITY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WORKFLOW_CONTROLLER_AGENT - Canonical agent name allowed to use workflow tools and control mutations.
//   NativeWorkflowSessionInfo - Structural native session info used for root/fork/workspace identity.
//   NativeWorkflowSession - Narrow native session surface (get + context) used for identity.
//   NativeAuthorizationClient - Narrow full-client surface (session.get + exact session.message.get) used for identity and message lookups.
//   WorkflowAuthorizationContext - Explicit plugin context (native client, trusted directory/root, invalid-hydration sessions) consumed by the factory.
//   WorkflowAuthorization - Authorization guards and lookups bound to one plugin instance.
//   canUseWorkflowTools - True when the calling agent is the workflow controller.
//   assertWorkflowToolAccess - Throws WORKFLOW_TOOL_DENIED for non-controller agents.
//   shouldInjectForAgent - True when workflow guidance should be injected for the agent.
//   createWorkflowAuthorization - Binds the primary-controller mutation guard and the native message lookups to an explicit context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-004 attempt 3 - Authorization message lookups now use the authenticated full client's exact session.message.get by id (surviving context compaction) instead of the projected session.context list; root identity still rejects child and fork sessions and verifies host location.]
// END_CHANGE_SUMMARY

import type { LookupRecoveryUserMessage } from "./delegated.js";
import type { AuthorityMessageSnapshot } from "./authority.js";
import { WorkflowDiagnosticError } from "./results.js";

export const WORKFLOW_CONTROLLER_AGENT = "vv-controller";

function controlDenied(message: string): WorkflowDiagnosticError {
  return new WorkflowDiagnosticError("CONTROL_DENIED", "authorization", message);
}

/** Structural native session info used for root/fork/workspace identity. */
export interface NativeWorkflowSessionInfo {
  readonly id?: unknown;
  readonly parentID?: unknown;
  readonly fork?: { readonly sessionID?: unknown } | undefined;
  readonly location?: { readonly directory?: unknown } | undefined;
  readonly time?: { readonly idle?: unknown } | undefined;
  readonly outcome?: unknown;
}

/**
 * Narrow native session surface the workflow boundary needs. The real
 * `Plugin.Context["session"]` satisfies it structurally.
 */
export interface NativeWorkflowSession {
  get(input: { readonly sessionID: string }): Promise<NativeWorkflowSessionInfo>;
  context(input: { readonly sessionID: string }): Promise<ReadonlyArray<unknown>>;
}

/** Narrow full-client surface used for identity and exact message lookups. */
export interface NativeAuthorizationClient {
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<NativeWorkflowSessionInfo>;
    message: {
      get(input: { readonly sessionID: string; readonly messageID: string }): Promise<unknown>;
    };
  };
}

export type WorkflowAuthorizationContext = {
  /** Lazily authenticates the full client only when a lookup actually runs. */
  getClient: () => Promise<NativeAuthorizationClient>;
  directory: string;
  trustedWorkspaceRoot: string;
  invalidHydrationSessions: Set<string>;
};

export type WorkflowAuthorization = {
  assertPrimaryControllerMutation: (
    agent: string | undefined,
    sessionId: string,
    toolName: string,
  ) => Promise<void>;
  lookupRecoveryUserMessage: LookupRecoveryUserMessage;
  lookupAuthorityMessage: (input: {
    sessionId: string;
    runId: string;
    messageId: string;
  }) => Promise<AuthorityMessageSnapshot | undefined>;
};

export function canUseWorkflowTools(agentName: string | undefined): boolean {
  return agentName === WORKFLOW_CONTROLLER_AGENT;
}

export function assertWorkflowToolAccess(agentName: string | undefined, toolName: string): void {
  if (canUseWorkflowTools(agentName)) {
    return;
  }

  const resolvedAgent = agentName?.trim() || "unknown-agent";
  throw new WorkflowDiagnosticError(
    "WORKFLOW_TOOL_DENIED",
    "authorization",
    `WORKFLOW_TOOL_DENIED: ${toolName} is only available to ${WORKFLOW_CONTROLLER_AGENT} sessions. Current agent: ${resolvedAgent}.`,
  );
}

export function shouldInjectForAgent(agentName: string | undefined): boolean {
  return canUseWorkflowTools(agentName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessageId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.id === "string" ? message.id : undefined;
}

function readMessageType(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.type === "string" ? message.type : undefined;
}

function readMessageCreated(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.time)) return undefined;
  const created = message.time.created;
  return typeof created === "number" && Number.isFinite(created) ? created : undefined;
}

function readTextParts(message: unknown): string[] {
  if (!isRecord(message)) return [];
  const type = message.type;
  if (type === "user" || type === "synthetic" || type === "system") {
    return typeof message.text === "string" ? [message.text] : [];
  }
  if (type === "assistant") {
    const content = message.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((part): part is { type: "text"; text: string } => {
        return isRecord(part) && part.type === "text" && typeof part.text === "string";
      })
      .map((part) => part.text);
  }
  return [];
}

/**
 * Read one exact native message by id through the authenticated full client.
 * Returns undefined only when the message genuinely does not exist; a transport
 * or authentication failure propagates so the domain reports a lookup failure
 * instead of conflating it with a missing message.
 */
async function readNativeMessageById(
  client: NativeAuthorizationClient,
  sessionId: string,
  messageId: string,
): Promise<unknown | undefined> {
  const message = await client.session.message.get({ sessionID: sessionId, messageID: messageId });
  return message ?? undefined;
}

export function createWorkflowAuthorization(
  context: WorkflowAuthorizationContext,
): WorkflowAuthorization {
  const { getClient, directory, trustedWorkspaceRoot, invalidHydrationSessions } = context;

  /** Normalized trusted workspace comparison (native reports absolute paths). */
  function isTrustedWorkspacePath(candidate: unknown): boolean {
    if (typeof candidate !== "string" || candidate === "") return false;
    return candidate === directory || candidate === trustedWorkspaceRoot;
  }

  // New control mutations require the primary vv-controller session: the calling
  // agent must be vv-controller, the host session must be a root session with no
  // parent and no fork lineage, and the host-reported location must match the
  // plugin's trusted workspace. None of this identity comes from tool arguments.
  async function assertPrimaryControllerMutation(
    agent: string | undefined,
    sessionId: string,
    toolName: string,
  ): Promise<void> {
    if (!canUseWorkflowTools(agent)) {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} is only available to ${WORKFLOW_CONTROLLER_AGENT} sessions. Current agent: ${agent?.trim() || "unknown-agent"}.`,
      );
    }
    if (invalidHydrationSessions.has(sessionId)) {
      // Invalid persisted state is a persistence/host condition, not a caller
      // authorization failure; keep the failure closed and the text explicit.
      throw new WorkflowDiagnosticError(
        "PERSISTENCE_FAILED",
        "persistence",
        `PERSISTENCE_FAILED: persisted workflow state for session ${sessionId} is invalid; resolve or remove it before new control mutations.`,
      );
    }

    let info: NativeWorkflowSessionInfo;
    try {
      const client = await getClient();
      info = await client.session.get({ sessionID: sessionId });
    } catch (error) {
      // A missing or failing native session lookup is unavailable trusted host
      // context, not a denial of authorization.
      throw new WorkflowDiagnosticError(
        "HOST_CONTEXT_UNAVAILABLE",
        "host_context",
        `HOST_CONTEXT_UNAVAILABLE: ${toolName} requires root-session identity for ${sessionId}, which could not be verified: ${(error as Error).message}`,
      );
    }

    const parentID = info.parentID;
    if (parentID !== undefined && parentID !== null && parentID !== "") {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} may only run in the root session; session ${sessionId} is a child of ${String(parentID)}.`,
      );
    }
    const forkedFrom = info.fork?.sessionID;
    if (forkedFrom !== undefined && forkedFrom !== null && forkedFrom !== "") {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} may only run in the root session; session ${sessionId} is a fork of ${String(forkedFrom)}.`,
      );
    }
    const hostDirectory = info.location?.directory;
    if (hostDirectory !== undefined && !isTrustedWorkspacePath(hostDirectory)) {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} workspace ${String(hostDirectory)} does not match the trusted plugin workspace.`,
      );
    }
  }

  // Read-only native message lookup for user-authorized recovery. Only identity
  // and timing metadata (role, sessionID, id, time.created) are retained;
  // message bodies never enter validation, persistence, or logs. Transport
  // failures throw so the domain reports AUTHORIZATION_LOOKUP_FAILED instead
  // of conflating an unreachable lookup with a nonexistent message.
  const lookupRecoveryUserMessage: LookupRecoveryUserMessage = async (sessionId, messageId) => {
    const message = await readNativeMessageById(await getClient(), sessionId, messageId);
    if (message === undefined) {
      return undefined;
    }
    const type = readMessageType(message);
    const id = readMessageId(message);
    // Only the exact requested id participates; a mismatched payload id is a
    // lookup defect, never silently accepted as the requested message.
    if (type !== "user" || (id !== undefined && id !== messageId)) {
      return undefined;
    }
    return {
      role: "user",
      sessionID: sessionId,
      id: messageId,
      timeCreatedMs: readMessageCreated(message),
    };
  };

  // Advance-authority provenance uses the same exact native message lookup. Only
  // verified identity/timing/eligibility metadata leaves this lookup; raw user
  // text is never persisted or logged.
  const lookupAuthorityMessage = async (input: {
    sessionId: string;
    runId: string;
    messageId: string;
  }): Promise<AuthorityMessageSnapshot | undefined> => {
    const message = await readNativeMessageById(
      await getClient(),
      input.sessionId,
      input.messageId,
    );
    if (message === undefined) {
      return undefined;
    }
    const type = readMessageType(message);
    const id = readMessageId(message);
    if (id !== undefined && id !== input.messageId) {
      return undefined;
    }
    return {
      messageId: input.messageId,
      sessionId: input.sessionId,
      role: type === "user" ? "user" : "assistant",
      createdMs: readMessageCreated(message) ?? 0,
      ignored: isRecord(message) && message.ignored === true,
      syntheticOnly: false,
      textParts: readTextParts(message),
    };
  };

  return { assertPrimaryControllerMutation, lookupRecoveryUserMessage, lookupAuthorityMessage };
}
