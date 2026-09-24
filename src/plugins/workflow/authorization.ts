// FILE: src/plugins/workflow/authorization.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Workflow tool access guards and SDK-backed read-only authorization message lookups over an explicit plugin context.
//   SCOPE: Agent gating for workflow tools, primary root-controller mutation authorization (agent, trusted workspace, invalid-hydration, and root-session identity through the pinned SDK session.get), and the recovery and advance-authority message lookups through the pinned SDK session.message retaining only identity, timing, and eligibility metadata. No tool definitions, stores, or persistence here.
//   DEPENDS: [@opencode-ai/plugin (Plugin type), src/plugins/workflow/delegated.ts (LookupRecoveryUserMessage type), src/plugins/workflow/authority.ts (AuthorityMessageSnapshot type)]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-DELEGATED, M-WORKFLOW-AUTHORITY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WORKFLOW_CONTROLLER_AGENT - Canonical agent name allowed to use workflow tools and control mutations.
//   WorkflowAuthorizationContext - Explicit plugin context (client, directory, worktree, trusted root, invalid-hydration sessions) consumed by the factory.
//   WorkflowAuthorization - Authorization guards and lookups bound to one plugin instance.
//   canUseWorkflowTools - True when the calling agent is the workflow controller.
//   assertWorkflowToolAccess - Throws WORKFLOW_TOOL_DENIED for non-controller agents.
//   shouldInjectForAgent - True when workflow guidance should be injected for the agent.
//   createWorkflowAuthorization - Binds the primary-controller mutation guard and the SDK-backed message lookups to an explicit context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-003 - Diagnostics carry a stable category: non-controller agent, child session, and workspace mismatch remain CONTROL_DENIED/authorization, a failing SDK root/session lookup is HOST_CONTEXT_UNAVAILABLE/host_context, and invalid persisted state is PERSISTENCE_FAILED/persistence. Message text is unchanged where meaningful. SDK-backed message lookups are unchanged.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode-ai/plugin";
import type { LookupRecoveryUserMessage } from "./delegated.js";
import type { AuthorityMessageSnapshot } from "./authority.js";
import { WorkflowDiagnosticError } from "./results.js";

export const WORKFLOW_CONTROLLER_AGENT = "vv-controller";

function controlDenied(message: string): WorkflowDiagnosticError {
  return new WorkflowDiagnosticError("CONTROL_DENIED", "authorization", message);
}

/** Plugin client shape used for the pinned session lookups below. */
type PluginClient = Parameters<Plugin>[0]["client"];

export type WorkflowAuthorizationContext = {
  client: PluginClient;
  directory: string;
  worktree: string | undefined;
  trustedWorkspaceRoot: string;
  invalidHydrationSessions: Set<string>;
};

export type WorkflowAuthorization = {
  assertPrimaryControllerMutation: (
    agent: string | undefined,
    sessionId: string,
    contextWorkspace: { directory?: string; worktree?: string },
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

export function createWorkflowAuthorization(
  context: WorkflowAuthorizationContext,
): WorkflowAuthorization {
  const { client, directory, worktree, trustedWorkspaceRoot, invalidHydrationSessions } = context;

  // New control mutations require the primary vv-controller session: the calling
  // agent must be vv-controller, the session must be a root session (no
  // parentID), and the ToolContext workspace must match the plugin's trusted
  // directory/worktree. None of this identity comes from tool arguments.
  async function assertPrimaryControllerMutation(
    agent: string | undefined,
    sessionId: string,
    contextWorkspace: { directory?: string; worktree?: string },
    toolName: string,
  ): Promise<void> {
    if (!canUseWorkflowTools(agent)) {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} is only available to ${WORKFLOW_CONTROLLER_AGENT} sessions. Current agent: ${agent?.trim() || "unknown-agent"}.`,
      );
    }
    if (
      contextWorkspace.worktree !== undefined &&
      contextWorkspace.worktree !== worktree &&
      contextWorkspace.worktree !== trustedWorkspaceRoot
    ) {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} workspace ${contextWorkspace.worktree} does not match the trusted plugin workspace.`,
      );
    }
    if (
      contextWorkspace.worktree === undefined &&
      contextWorkspace.directory !== undefined &&
      contextWorkspace.directory !== directory
    ) {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} directory ${contextWorkspace.directory} does not match the trusted plugin directory.`,
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

    let parentID: string | undefined;
    try {
      const response = await client.session.get({ path: { id: sessionId } });
      if (!response.data) {
        throw new Error("missing session payload");
      }
      parentID = response.data.parentID;
    } catch (error) {
      // A missing or failing SDK root/session lookup is unavailable trusted host
      // context, not a denial of authorization.
      throw new WorkflowDiagnosticError(
        "HOST_CONTEXT_UNAVAILABLE",
        "host_context",
        `HOST_CONTEXT_UNAVAILABLE: ${toolName} requires root-session identity for ${sessionId}, which could not be verified: ${(error as Error).message}`,
      );
    }
    if (parentID !== undefined && parentID !== null && parentID !== "") {
      throw controlDenied(
        `CONTROL_DENIED: ${toolName} may only run in the root session; session ${sessionId} is a child of ${parentID}.`,
      );
    }
  }

  // Read-only SDK message lookup for user-authorized recovery. Only identity
  // and timing metadata (role, sessionID, id, time.created) are retained;
  // message bodies never enter validation, persistence, or logs. Transport
  // failures throw so the domain reports AUTHORIZATION_LOOKUP_FAILED instead
  // of conflating an unreachable lookup with a nonexistent message.
  const lookupRecoveryUserMessage: LookupRecoveryUserMessage = async (sessionId, messageId) => {
    const response = await client.session.message({
      path: { id: sessionId, messageID: messageId },
      query: { directory },
    });
    if (response.error || !response.data) {
      const errorName = (response.error as { name?: string } | undefined)?.name;
      if (errorName && errorName !== "NotFound") {
        throw new Error(`session message lookup failed: ${errorName}`);
      }
      return undefined;
    }
    const info = response.data.info as {
      role?: string;
      sessionID?: string;
      id?: string;
      time?: { created?: number };
    };
    return {
      role: info.role,
      sessionID: info.sessionID,
      id: info.id,
      timeCreatedMs:
        typeof info.time?.created === "number" && Number.isFinite(info.time.created)
          ? info.time.created
          : undefined,
    };
  };

  // Advance-authority provenance uses the same pinned SDK message response.
  // Only verified identity/timing/eligibility metadata leaves this lookup; raw
  // user text is never persisted or logged.
  const lookupAuthorityMessage = async (input: {
    sessionId: string;
    runId: string;
    messageId: string;
  }): Promise<AuthorityMessageSnapshot | undefined> => {
    const response = await client.session.message({
      path: { id: input.sessionId, messageID: input.messageId },
      query: { directory },
    });
    if (response.error || !response.data) {
      const errorName = (response.error as { name?: string } | undefined)?.name;
      if (errorName && errorName !== "NotFound") {
        throw new Error(`authority message lookup failed: ${errorName}`);
      }
      return undefined;
    }
    const info = response.data.info as {
      role?: string;
      sessionID?: string;
      id?: string;
      ignored?: boolean;
      time?: { created?: number };
    };
    const parts = Array.isArray(response.data.parts) ? response.data.parts : [];
    const textParts = parts
      .map((part) => part as { type?: unknown; text?: unknown })
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    return {
      messageId: info.id ?? input.messageId,
      sessionId: info.sessionID ?? input.sessionId,
      role: info.role === "user" ? "user" : "assistant",
      createdMs:
        typeof info.time?.created === "number" && Number.isFinite(info.time.created)
          ? info.time.created
          : 0,
      ignored: info.ignored === true,
      syntheticOnly: false,
      textParts,
    };
  };

  return { assertPrimaryControllerMutation, lookupRecoveryUserMessage, lookupAuthorityMessage };
}
