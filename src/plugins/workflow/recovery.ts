// FILE: src/plugins/workflow/recovery.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Durable committed-recovery and staged-transaction machinery over the per-session persistence seam.
//   SCOPE: Serialized generic tool transactions (staged persist before publish with per-session queueing), durably committed recovery mutations with synchronous persist and rollback so launch permissions appear only after a durable write, and record/checkpoint capture-restore helpers for rollback. No tool definitions, authorization checks, or domain reducers here.
//   DEPENDS: [@opencode-ai/plugin (Plugin type), src/plugins/workflow/state.ts, src/plugins/workflow/persistence.ts, src/plugins/workflow/transactions.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-PERSISTENCE, M-WORKFLOW-STATE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   RecoverySupportContext - Explicit seam (client, per-session stores, invalid-hydration sessions) consumed by the factory.
//   RecoverySupport - Committed-transaction helpers bound to one plugin instance.
//   createRecoverySupport - Binds the generic staged-transaction committer, the durably committed recovery executor, and the capture-restore helpers to an explicit seam with its own per-plugin serialization queue.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-003 - commitGenericToolResult takes the trusted expected tool identity and validates every owned staged success against it (missing/wrong tag, malformed nested result, and a thrown validator are fail-closed); a thrown validator is summarized safely by name without echoing its message; invalid hydration is a persistence failure and post-apply rollback throws carry persistence category plus an explicit rolled_back outcome.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode-ai/plugin";
import { createRecordLookupKey, createWorkItemStoreView, type WorkItemStore } from "./state.js";
import { snapshotWorkflowStateChecked } from "./persistence.js";
import { runWorkflowTransaction, WorkflowTransactionQueue } from "./transactions.js";
import { formatContractIssues } from "../../lib/agent-tool-contract.js";
import {
  normalizeWorkflowFailure,
  validateWorkflowToolResult,
  workflowInternalResultFailure,
  WorkflowDiagnosticError,
  type WorkflowToolResultToolId,
} from "./results.js";

/** Plugin client shape used for failure logging. */
type PluginClient = Parameters<Plugin>[0]["client"];

export type RecoverySupportContext = {
  client: PluginClient;
  stores: Map<string, WorkItemStore>;
  invalidHydrationSessions: Set<string>;
};

export type RecoverySupport = {
  commitGenericToolResult: (
    sessionId: string,
    toolId: WorkflowToolResultToolId,
    run: (view: WorkItemStore) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  executeCommittedRecovery: <T>(
    sessionId: string,
    runRecovery: (liveStore: WorkItemStore) => Promise<T>,
    captureRestore: () => () => void,
    wasApplied: (result: T) => boolean,
  ) => Promise<T>;
  captureRecordRestore: (sessionId: string, workItemId: string) => () => void;
  captureCheckpointRestore: (sessionId: string, runId: string, checkpointId: string) => () => void;
};

export function createRecoverySupport(context: RecoverySupportContext): RecoverySupport {
  const { client, stores, invalidHydrationSessions } = context;

  // Per-session serialization for generic mutating tool calls. The staged
  // snapshot persists before the committed state is published, so a failed
  // write never exposes new obligations, authority, or launch permissions.
  const workflowTransactions = new WorkflowTransactionQueue();

  /**
   * Producer contract check on a staged success before it is persisted and
   * published. The expected tool identity comes from the trusted wrapper, not
   * from the result itself, so a malformed success that omits or forges `tool`
   * is rejected. A thrown validator is also fail-closed. The operation ran on
   * the staged clone, so a rejection leaves the live store and every committed
   * ledger entry unchanged.
   */
  function guardStagedWorkflowResult(
    toolId: WorkflowToolResultToolId,
    result: Record<string, unknown>,
  ): { ok: true } | { ok: false; error: string } {
    try {
      if (result.tool !== toolId) {
        return {
          ok: false,
          error: `owned staged result is not tagged for expected tool ${toolId}`,
        };
      }
      const validation = validateWorkflowToolResult(toolId, result);
      if (validation.ok) {
        return { ok: true };
      }
      return { ok: false, error: formatContractIssues(validation.issues) };
    } catch (error) {
      // Never echo an arbitrary exception message: it can carry caller values
      // or secrets. Report only a safe internal summary.
      const name = error instanceof Error && error.name ? error.name : "Error";
      return {
        ok: false,
        error: `owned staged result guard failed closed (${name})`,
      };
    }
  }

  async function commitGenericToolResult(
    sessionId: string,
    toolId: WorkflowToolResultToolId,
    run: (view: WorkItemStore) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const liveStore = stores.get(sessionId);
    if (!liveStore) {
      return normalizeWorkflowFailure({
        tool: toolId,
        sessionId,
        ok: false,
        errorCode: "SESSION_MISMATCH",
        message: `no live workflow store for session ${sessionId}`,
      });
    }
    if (invalidHydrationSessions.has(sessionId)) {
      return normalizeWorkflowFailure({
        tool: toolId,
        sessionId,
        ok: false,
        errorCode: "PERSISTENCE_FAILED",
        category: "persistence",
        message: `persisted workflow state for session ${sessionId} is invalid; refusing new mutations`,
      });
    }
    const outcome = await runWorkflowTransaction<Record<string, unknown>>({
      queue: workflowTransactions,
      sessionId,
      getData: () => liveStore.getStoreData(),
      operation: async (staged) => {
        const result = await run(createWorkItemStoreView(staged));
        if (result.ok !== true) {
          // Validation failed: persist nothing and publish nothing.
          return { result, skipPersist: true };
        }
        return { result };
      },
      guardStagedResult: (result) => guardStagedWorkflowResult(toolId, result),
    });
    if (!outcome.ok) {
      if (outcome.invalidResult === true) {
        void client.app
          .log({
            body: {
              service: "workflow",
              level: "error",
              message:
                "[workflow][generic][BLOCK_RESULT_CONTRACT] staged result failed its contract",
              extra: { sessionID: sessionId, error: outcome.error.slice(0, 300) },
            },
          })
          .catch(() => undefined);
        // Nothing was persisted or published, so the observed outcome is
        // not_applied; report a bounded internal contract failure rather than
        // an INVALID_INPUT request or an unqualified retry.
        return workflowInternalResultFailure({
          tool: toolId,
          sessionId,
          message: `staged workflow result failed its public contract: ${outcome.error}`,
          outcome: "not_applied",
        });
      }
      void client.app
        .log({
          body: {
            service: "workflow",
            level: "error",
            message: "[workflow][generic][BLOCK_GENERIC_COMMIT] persistence failed",
            extra: { sessionID: sessionId, error: outcome.error.slice(0, 300) },
          },
        })
        .catch(() => undefined);
      return normalizeWorkflowFailure({
        tool: toolId,
        sessionId,
        ok: false,
        errorCode: "PERSISTENCE_FAILED",
        category: "persistence",
        message: `generic workflow mutation could not be persisted: ${outcome.error}`,
        outcome: "not_applied",
      });
    }
    return outcome.result;
  }

  /**
   * Execute one recovery mutation durably on the live store: the domain
   * reducer applies to the live entry (re-prechecking after any authorization
   * await), and the whole live store is then persisted synchronously. If the
   * write fails, the captured prior entry is restored so no unpersisted launch
   * permission is ever exposed — there is no await between mutation, persist,
   * and rollback, so no concurrent actor can observe the intermediate state,
   * and no stale whole-store snapshot can regress concurrent transitions.
   */
  async function executeCommittedRecovery<T>(
    sessionId: string,
    runRecovery: (liveStore: WorkItemStore) => Promise<T>,
    captureRestore: () => () => void,
    wasApplied: (result: T) => boolean,
  ): Promise<T> {
    const liveStore = stores.get(sessionId);
    if (!liveStore || invalidHydrationSessions.has(sessionId)) {
      throw new WorkflowDiagnosticError(
        "PERSISTENCE_FAILED",
        "persistence",
        `PERSISTENCE_FAILED: persisted workflow state for session ${sessionId} is invalid; resolve or remove it before new control mutations.`,
        "not_applied",
      );
    }
    const restore = captureRestore();
    const result = await runRecovery(liveStore);
    if (!wasApplied(result)) {
      return result;
    }
    const persisted = snapshotWorkflowStateChecked(sessionId, liveStore.getStoreData());
    if (!persisted.ok) {
      restore();
      void client.app
        .log({
          body: {
            service: "workflow",
            level: "error",
            message: "[workflow][recovery][BLOCK_RECOVERY_COMMIT] recovery persistence failed",
            extra: { sessionID: sessionId, error: persisted.error.slice(0, 300) },
          },
        })
        .catch(() => undefined);
      // The mutation was applied in memory and then rolled back; report the
      // observed outcome truthfully without promising a safe replay.
      throw new WorkflowDiagnosticError(
        "PERSISTENCE_FAILED",
        "persistence",
        `PERSISTENCE_FAILED: recovery applied in memory but could not be persisted and was rolled back: ${persisted.error}`,
        "rolled_back",
      );
    }
    return result;
  }

  /** Capture and restore one work-item record entry for recovery rollback. */
  function captureRecordRestore(sessionId: string, workItemId: string): () => void {
    const liveStore = stores.get(sessionId);
    if (!liveStore) return () => undefined;
    const liveData = liveStore.getStoreData();
    const lookupKey = createRecordLookupKey(sessionId, workItemId);
    const prior = liveData.records.get(lookupKey);
    return () => {
      if (prior) {
        liveData.records.set(lookupKey, prior);
      }
    };
  }

  /** Capture and restore one checkpoint entry for recovery rollback. */
  function captureCheckpointRestore(
    sessionId: string,
    runId: string,
    checkpointId: string,
  ): () => void {
    const liveStore = stores.get(sessionId);
    if (!liveStore) return () => undefined;
    const run = liveStore.getStoreData().planRuns.get(runId);
    if (!run) return () => undefined;
    const priorCheckpoint = run.checkpoints.get(checkpointId);
    return () => {
      if (priorCheckpoint) {
        run.checkpoints.set(checkpointId, priorCheckpoint);
      }
    };
  }

  return {
    commitGenericToolResult,
    executeCommittedRecovery,
    captureRecordRestore,
    captureCheckpointRestore,
  };
}
