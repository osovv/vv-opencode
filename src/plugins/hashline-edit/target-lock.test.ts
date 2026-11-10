// FILE: src/plugins/hashline-edit/target-lock.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify deterministic per-target FIFO coordination, cancellation while waiting, effect-error release, and independent keys for the str_replace_editor target lock.
//   SCOPE: Unit coverage of target-lock.ts with deferred barriers only; no timing or stress assertions.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/target-lock.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Deferred - Promise and resolver used as a deterministic barrier.
//   deferred - Promise plus resolvers used as deterministic test barriers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [Direct fix - Added deterministic coverage for process-global canonical-target coordination.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { withTargetLock } from "./target-lock.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("withTargetLock", () => {
  test("runs same-key effects in FIFO order and never overlaps them", async () => {
    const started = deferred();
    const release = deferred();
    const order: string[] = [];

    const first = withTargetLock("target", async () => {
      order.push("first:start");
      started.resolve();
      await release.promise;
      order.push("first:end");
    });
    await started.promise;

    const second = withTargetLock("target", () => {
      order.push("second");
    });
    const third = withTargetLock("target", () => {
      order.push("third");
    });

    // Let both waiters reach their queue positions without letting them run.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    release.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  test("cancels a waiter without running it or blocking the next caller", async () => {
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();

    const holder = withTargetLock("target", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const cancelled = withTargetLock(
      "target",
      () => {
        throw new Error("cancelled effect must not run");
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    release.resolve();
    await holder;
    const next = await withTargetLock("target", () => "next");
    expect(next).toBe("next");
  });

  test("releases the lock when an effect throws", async () => {
    await expect(
      withTargetLock("target", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const recovered = await withTargetLock("target", () => "recovered");
    expect(recovered).toBe("recovered");
  });

  test("different keys progress independently", async () => {
    const started = deferred();
    const release = deferred();
    const held = withTargetLock("a", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const independent = await withTargetLock("b", () => "b-done");
    expect(independent).toBe("b-done");

    release.resolve();
    await held;
  });
});
