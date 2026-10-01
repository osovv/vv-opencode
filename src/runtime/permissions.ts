// FILE: src/runtime/permissions.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Gate resource-specific side effects on the native session permission create/get/reply lifecycle, awaiting a real transport handshake and a terminal allow before the caller's effect runs.
//   SCOPE: Native permission request construction after the live event transport reports server.connected, same-session pending reconciliation, live terminal-reply decoding with bounded readiness, rejection/abort/disconnect semantics, late cancellation before the guarded effect, and best-effort pending-request cleanup. Never implements a no-op ask or unconditional allow, never reads credentials, and never starts or stops the host.
//   DEPENDS: [src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_PERMISSION_READINESS_TIMEOUT_MS - Default bound for waiting on the native event transport handshake.
//   PermissionDeniedError - Terminal rejection or identity mismatch stopped the effect.
//   PermissionAbortedError - The permission request ended without a terminal reply or was cancelled, so the effect did not run.
//   createPermissionService - Build the awaited resource permission service for an authenticated runtime client.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-001 - Wait for genuine server.connected before creating the request and recheck cancellation immediately before the guarded effect.]
// END_CHANGE_SUMMARY

import {
  PERMISSION_REPLIED_EVENT,
  SERVER_CONNECTED_EVENT,
  type PermissionCreateInput,
  type PermissionDecision,
  type PermissionRequestOptions,
  type PermissionService,
  type ResourcePermissionRequest,
  type RuntimeClient,
  type RuntimeEvent,
} from "./types.js";

/** Default bound for waiting on the native event transport handshake. */
export const DEFAULT_PERMISSION_READINESS_TIMEOUT_MS = 15_000;

/** Terminal rejection or identity mismatch stopped the effect. */
export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED";

  constructor(action: string, reason = "denied") {
    super(`Permission ${reason} for action ${action}.`);
    this.name = "PermissionDeniedError";
  }
}

/** The permission request ended without a terminal reply or was cancelled, so the effect did not run. */
export class PermissionAbortedError extends Error {
  readonly code = "PERMISSION_ABORTED";

  constructor(reason: string) {
    super(`Permission request did not resolve: ${reason}.`);
    this.name = "PermissionAbortedError";
  }
}

// START_BLOCK_SIGNAL_LINKING
/** Link cancellation sources to one per-request controller and return a listener cleanup. */
function linkAbort(
  sources: ReadonlyArray<AbortSignal | undefined>,
  controller: AbortController,
): () => void {
  const onAbort = () => controller.abort();
  const attached: Array<AbortSignal> = [];
  for (const source of sources) {
    if (source === undefined) continue;
    if (source.aborted) {
      controller.abort();
      break;
    }
    source.addEventListener("abort", onAbort, { once: true });
    attached.push(source);
  }
  return () => {
    for (const source of attached) source.removeEventListener("abort", onAbort);
  };
}

/** True when any cancellation source already fired. */
function isAborted(sources: ReadonlyArray<AbortSignal | undefined>): boolean {
  return sources.some((source) => source?.aborted === true);
}
// END_BLOCK_SIGNAL_LINKING

// START_BLOCK_EVENT_READING
type EventReadOutcome =
  | { readonly kind: "value"; readonly value: IteratorResult<RuntimeEvent> }
  | { readonly kind: "error"; readonly error: unknown };

function readEvent(iterator: AsyncIterator<RuntimeEvent>): Promise<EventReadOutcome> {
  return iterator.next().then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
}

type AsyncEventIterator = AsyncIterator<RuntimeEvent>;

/** Read one event, bounded by an absolute deadline; never leaves an unhandled rejection behind. */
async function readWithDeadline(
  iterator: AsyncEventIterator,
  expiresAt: number,
): Promise<EventReadOutcome | "timeout"> {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "timeout";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remaining);
  });
  try {
    return await Promise.race([readEvent(iterator), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wait until the native event transport reports server.connected. The shared
 * SSE client connects lazily, so a terminal reply published before the
 * handshake completes would be lost forever. Unrelated pre-handshake events are
 * skipped; cancellation, disconnect, and a bounded deadline all fail closed.
 */
async function waitForTransportReady(
  iterator: AsyncEventIterator,
  signal: AbortSignal,
  readinessTimeoutMs: number,
): Promise<void> {
  const expiresAt = Date.now() + readinessTimeoutMs;
  for (;;) {
    const outcome = await readWithDeadline(iterator, expiresAt);
    if (outcome === "timeout") {
      if (signal.aborted) throw new PermissionAbortedError("aborted");
      throw new PermissionAbortedError("the native event transport was not ready in time");
    }
    if (outcome.kind === "error") {
      if (signal.aborted) throw new PermissionAbortedError("aborted");
      throw new PermissionAbortedError("the native event stream failed before it was ready");
    }
    if (outcome.value.done) {
      if (signal.aborted) throw new PermissionAbortedError("aborted");
      throw new PermissionAbortedError("the native event stream closed before it was ready");
    }
    if (outcome.value.value.type === SERVER_CONNECTED_EVENT) return;
  }
}
// END_BLOCK_EVENT_READING

// START_BLOCK_REQUEST_INPUT
function toCreateInput(input: ResourcePermissionRequest): PermissionCreateInput {
  return {
    sessionID: input.sessionID,
    action: input.action,
    resources: input.resources,
    ...(input.save === undefined ? {} : { save: input.save }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  };
}

function decodeReply(
  event: RuntimeEvent,
  sessionID: string,
  requestID: string,
): PermissionDecision | undefined {
  if (event.type !== PERMISSION_REPLIED_EVENT) return undefined;
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (record.sessionID !== sessionID || record.requestID !== requestID) return undefined;
  const reply = record.reply;
  if (reply === "once" || reply === "always") return "allow";
  if (reply === "reject") return "deny";
  return undefined;
}

async function reconcilePending(
  client: RuntimeClient,
  request: ResourcePermissionRequest,
  requestID: string,
  signal: AbortSignal,
): Promise<void> {
  let pending;
  try {
    pending = await client.permission.get({ sessionID: request.sessionID, requestID }, { signal });
  } catch {
    // The request may already be resolved or refused; the live reply stream stays authoritative.
    return;
  }
  if (pending.id !== requestID || pending.sessionID !== request.sessionID) {
    throw new PermissionDeniedError(request.action, "identity mismatch");
  }
}

async function rejectPending(
  client: RuntimeClient,
  sessionID: string,
  requestID: string,
): Promise<void> {
  try {
    await client.permission.reply({ sessionID, requestID, decision: "reject" });
  } catch {
    // The request may already be resolved; abort semantics still hold.
  }
}

async function requestDecision(
  client: RuntimeClient,
  request: ResourcePermissionRequest,
  signal: AbortSignal,
  readinessTimeoutMs: number,
): Promise<PermissionDecision> {
  if (signal.aborted) throw new PermissionAbortedError("aborted before the request was created");

  const iterator: AsyncEventIterator = client.event.subscribe({ signal })[Symbol.asyncIterator]();
  try {
    // Establish the live transport before creating the request, or an instant auto-review reply is lost.
    await waitForTransportReady(iterator, signal, readinessTimeoutMs);
    if (signal.aborted) throw new PermissionAbortedError("aborted before the request was created");

    let created;
    try {
      created = await client.permission.create(toCreateInput(request), { signal });
    } catch (cause) {
      if (signal.aborted) throw new PermissionAbortedError("aborted while creating the request");
      throw cause;
    }
    if (created.effect === "allow") {
      if (signal.aborted)
        throw new PermissionAbortedError("aborted after the permission was granted");
      return "allow";
    }
    if (created.effect === "deny") return "deny";

    await reconcilePending(client, request, created.id, signal);
    for (;;) {
      const outcome = await readEvent(iterator);
      if (outcome.kind === "error") {
        if (signal.aborted) {
          await rejectPending(client, request.sessionID, created.id);
          throw new PermissionAbortedError("aborted");
        }
        throw new PermissionAbortedError("the permission event stream failed");
      }
      if (outcome.value.done) {
        if (signal.aborted) {
          await rejectPending(client, request.sessionID, created.id);
          throw new PermissionAbortedError("aborted");
        }
        throw new PermissionAbortedError("the permission event stream ended before a reply");
      }
      const decision = decodeReply(outcome.value.value, request.sessionID, created.id);
      if (decision !== undefined) {
        if (decision === "allow" && signal.aborted) {
          throw new PermissionAbortedError("aborted after the permission was granted");
        }
        return decision;
      }
    }
  } finally {
    await iterator.return?.();
  }
}
// END_BLOCK_REQUEST_INPUT

/**
 * Build the awaited resource permission service for an authenticated runtime
 * client. `request` returns the terminal decision; `guard` throws without
 * running the effect unless the decision is a terminal allow, and rechecks
 * cancellation immediately before invoking the effect.
 */
export function createPermissionService(
  getClient: () => Promise<RuntimeClient>,
  lifetimeSignal: AbortSignal,
): PermissionService {
  const request = async (
    input: ResourcePermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionDecision> => {
    const client = await getClient();
    const controller = new AbortController();
    const unlink = linkAbort([options?.signal, lifetimeSignal], controller);
    try {
      return await requestDecision(
        client,
        input,
        controller.signal,
        options?.readinessTimeoutMs ?? DEFAULT_PERMISSION_READINESS_TIMEOUT_MS,
      );
    } finally {
      unlink();
    }
  };

  const guard = async <T>(
    input: ResourcePermissionRequest,
    effect: () => Promise<T> | T,
    options?: PermissionRequestOptions,
  ): Promise<T> => {
    const decision = await request(input, options);
    if (decision === "deny") throw new PermissionDeniedError(input.action);
    // Cancellation may have landed between the terminal allow and the effect.
    if (isAborted([options?.signal, lifetimeSignal])) {
      throw new PermissionAbortedError("aborted after the permission was granted");
    }
    return await effect();
  };

  return { request, guard };
}
