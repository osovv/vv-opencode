// FILE: src/plugins/hashline-edit/target-lock.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Serialize complete str_replace_editor command cycles per canonical target across independent editor and handler instances in one process.
//   SCOPE: Process-global FIFO keyed asynchronous locks with cancellation-aware waiting, explicit abort rechecks, and release on success, error, or cancellation; no cross-process guarantee.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   abortError - Build the cancellation error used by queue waits and editor rechecks.
//   throwIfAborted - Throw the signal reason or an AbortError when the signal is already cancelled.
//   withTargetLock - Run one effect under the process-global FIFO lock for a canonical target key.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [Direct fix - Added process-global canonical-target coordination for the dsh str_replace_editor read-modify-write cycle.]
// END_CHANGE_SUMMARY

// START_BLOCK_ABORT
/** Build a cancellation error that preserves an explicit abort reason. */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Throw when the caller signal is already cancelled; used after queue waits and before mutation. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}
// END_BLOCK_ABORT

// START_BLOCK_LOCK
interface LockEntry {
  /** Tail of the FIFO chain; resolves when the last queued holder releases. */
  tail: Promise<void>;
  /** Number of callers that entered this entry and have not finished yet. */
  waiters: number;
}

/**
 * Process-global lock registry. Keyed by canonical target, so independent
 * editor instances, handler instances, and sessions in this process share the
 * same coordination. There is deliberately no cross-process exclusion.
 */
const LOCKS = new Map<string, LockEntry>();

function waitForTail(tail: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return tail;
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    tail.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

/**
 * Run `effect` under the process-global FIFO lock for `key`. A waiting caller
 * that is cancelled rejects without running its effect and releases its place
 * in the chain, so later callers are not blocked by the cancelled waiter.
 */
export async function withTargetLock<T>(
  key: string,
  effect: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  let entry = LOCKS.get(key);
  if (entry === undefined) {
    entry = { tail: Promise.resolve(), waiters: 0 };
    LOCKS.set(key, entry);
  }
  const activeEntry = entry;
  activeEntry.waiters += 1;

  const prior = activeEntry.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  activeEntry.tail = prior.then(() => gate);

  try {
    await waitForTail(prior, signal);
    throwIfAborted(signal);
    return await effect();
  } finally {
    release();
    activeEntry.waiters -= 1;
    if (activeEntry.waiters === 0 && LOCKS.get(key) === activeEntry) {
      LOCKS.delete(key);
    }
  }
}
// END_BLOCK_LOCK
