// FILE: src/runtime/permissions.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify that resource permissions wait for a genuine transport handshake and are awaited before side effects, and that denied, rejected, disconnected, or cancelled permissions never run the guarded effect.
//   SCOPE: Deterministic native permission create/get/reply and asynchronous server.connected/reply event modeling for permissions.ts; no real host, network, or V1 client.
//   DEPENDS: [bun:test, src/runtime/permissions.js, src/runtime/types.js]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION_ID - Stable session id fixture.
//   SECRET - Permission secret sentinel value.
//   Subscriber - Event subscriber callback fixture shape.
//   FakeNativeEventStream - Asynchronous SSE-like event double with delayed handshake, emit, and disconnect.
//   FakePermissionHost - Native session permission lifecycle double used by the permission assertions.
//   requestInput - Builds a native permission create input.
//   waitForPending - Waits until the host records a pending request.
//   flushMacrotasks - Flushes pending macrotasks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-001 - Modeled asynchronous handshake, instant reply, disconnect, bounded readiness, and late cancellation.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { PermissionEffect, PermissionGetOutput, PermissionReplyInput } from "@opencode/client";
import { Session } from "@opencode/schema/session";
import {
  PermissionAbortedError,
  PermissionDeniedError,
  createPermissionService,
} from "./permissions.js";
import type { PermissionCreateInput, RuntimeClient, RuntimeEvent } from "./types.js";

const SESSION_ID = Session.ID.make("ses_test0000000000000000000000");
const SECRET = "permission-secret-value";

type Subscriber = {
  push(event: RuntimeEvent): void;
  finish(): void;
};

// START_BLOCK_FAKE_EVENT_STREAM
class FakeNativeEventStream {
  private readonly subscribers = new Set<Subscriber>();
  private connecting = false;
  private isConnected = false;
  private isBroken = false;
  /** Macrotask ticks required before the server.connected handshake is broadcast. */
  connectDelayTicks = 1;

  connected(): boolean {
    return this.isConnected;
  }

  emit(event: RuntimeEvent): void {
    if (this.isBroken) return;
    for (const subscriber of this.subscribers) subscriber.push(event);
  }

  /** Model a transport drop: current subscriptions end without a terminal reply. */
  disconnect(): void {
    this.isBroken = true;
    for (const subscriber of this.subscribers) subscriber.finish();
    this.subscribers.clear();
  }

  private ensureConnecting(): void {
    if (this.isConnected || this.connecting || this.isBroken) return;
    this.connecting = true;
    let ticks = this.connectDelayTicks;
    const step = () => {
      if (this.isBroken) {
        this.connecting = false;
        return;
      }
      if (ticks > 0) {
        ticks -= 1;
        setTimeout(step, 0);
        return;
      }
      this.connecting = false;
      this.isConnected = true;
      this.emit({ type: "server.connected" });
    };
    setTimeout(step, 0);
  }

  api(): RuntimeClient["event"] {
    return {
      subscribe: (options) => ({
        [Symbol.asyncIterator]: (): AsyncIterator<RuntimeEvent> => {
          const queue: RuntimeEvent[] = [];
          let settle: ((result: IteratorResult<RuntimeEvent>) => void) | undefined;
          let finished = false;
          let started = false;
          const subscriber: Subscriber = {
            push(event) {
              if (finished) return;
              if (settle === undefined) queue.push(event);
              else {
                const resume = settle;
                settle = undefined;
                resume({ done: false, value: event });
              }
            },
            finish() {
              if (finished) return;
              finished = true;
              const resume = settle;
              settle = undefined;
              resume?.({ done: true, value: undefined });
            },
          };
          const onAbort = () => {
            this.subscribers.delete(subscriber);
            subscriber.finish();
          };
          const start = () => {
            if (started) return;
            started = true;
            this.subscribers.add(subscriber);
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            if (this.isConnected) queue.push({ type: "server.connected" });
            else this.ensureConnecting();
          };
          return {
            next: () => {
              const queued = queue.shift();
              if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
              if (finished || options?.signal?.aborted) {
                onAbort();
                return Promise.resolve({ done: true, value: undefined });
              }
              start();
              const immediate = queue.shift();
              if (immediate !== undefined) {
                return Promise.resolve({ done: false, value: immediate });
              }
              if (finished) return Promise.resolve({ done: true, value: undefined });
              return new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
                settle = resolve;
              });
            },
            return: () => {
              this.subscribers.delete(subscriber);
              options?.signal?.removeEventListener("abort", onAbort);
              subscriber.finish();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      }),
    };
  }
}
// END_BLOCK_FAKE_EVENT_STREAM

// START_BLOCK_FIXTURE_HOST
class FakePermissionHost {
  effectFor: (input: PermissionCreateInput) => PermissionEffect = () => "ask";
  /** When set, the host replies immediately after creating an ask request. */
  autoReply: "once" | "always" | "reject" | undefined;
  /** Runs synchronously after an auto reply, used to model late cancellation. */
  afterAutoReply: (() => void) | undefined;
  readonly pending = new Map<string, PermissionGetOutput>();
  readonly stream = new FakeNativeEventStream();
  readonly client: RuntimeClient;
  createCalls = 0;
  createdBeforeConnected = false;
  private counter = 0;

  constructor(defaultEffect: PermissionEffect = "ask") {
    this.effectFor = () => defaultEffect;
    this.client = {
      rpc: (() => {
        throw new Error("RPC is not used by the permission service");
      }) as RuntimeClient["rpc"],
      permission: {
        create: async (input) => {
          this.createCalls += 1;
          if (!this.stream.connected()) this.createdBeforeConnected = true;
          this.counter += 1;
          const id = `per_${String(this.counter).padStart(4, "0")}`;
          const effect = this.effectFor(input);
          if (effect === "ask") {
            this.pending.set(id, {
              id,
              sessionID: input.sessionID,
              action: input.action,
              resources: [...input.resources],
              ...(input.save === undefined ? {} : { save: [...input.save] }),
              ...(input.metadata === undefined
                ? {}
                : { metadata: input.metadata as PermissionGetOutput["metadata"] }),
              ...(input.source === undefined ? {} : { source: input.source }),
            });
            if (this.autoReply !== undefined) {
              this.pending.delete(id);
              this.stream.emit({
                type: "permission.replied",
                data: { sessionID: input.sessionID, requestID: id, reply: this.autoReply },
              });
              this.afterAutoReply?.();
            }
          }
          return { id, effect };
        },
        get: async (input) => {
          const request = this.pending.get(input.requestID);
          if (request === undefined) throw new Error("not found");
          return request;
        },
        reply: async (input: PermissionReplyInput) => {
          const request = this.pending.get(input.requestID);
          if (request === undefined) throw new Error("not found");
          this.pending.delete(input.requestID);
          this.stream.emit({
            type: "permission.replied",
            data: { sessionID: request.sessionID, requestID: request.id, reply: input.decision },
          });
        },
      },
      event: this.stream.api(),
    };
  }

  service(lifetimeSignal: AbortSignal = new AbortController().signal) {
    return createPermissionService(() => Promise.resolve(this.client), lifetimeSignal);
  }
}
// END_BLOCK_FIXTURE_HOST

function requestInput(metadata?: Record<string, unknown>) {
  return {
    sessionID: SESSION_ID,
    action: "web_fetch",
    resources: ["http://127.0.0.1:9/probe"],
    ...(metadata === undefined ? {} : { metadata }),
  };
}

async function waitForPending(host: FakePermissionHost): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (host.pending.size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("permission request was not created");
}

async function flushMacrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("createPermissionService", () => {
  test("waits for the transport handshake before creating a native request", async () => {
    const host = new FakePermissionHost("ask");
    host.stream.connectDelayTicks = 3;
    const guarded = host.service().guard(requestInput(), () => "ran");

    await flushMacrotasks(1);
    expect(host.createCalls).toBe(0);
    expect(host.stream.connected()).toBe(false);

    await waitForPending(host);
    expect(host.stream.connected()).toBe(true);
    expect(host.createdBeforeConnected).toBe(false);

    const [requestID, pending] = [...host.pending.entries()][0]!;
    await host.client.permission.reply({
      sessionID: pending.sessionID,
      requestID,
      decision: "once",
    });
    expect(await guarded).toBe("ran");
  });

  test("runs the effect immediately on a native allow decision", async () => {
    const host = new FakePermissionHost("allow");
    let ran = false;
    const result = await host.service().guard(requestInput(), async () => {
      ran = true;
      return "done";
    });

    expect(result).toBe("done");
    expect(ran).toBe(true);
    expect(host.pending.size).toBe(0);
  });

  test("blocks the effect on a native deny decision", async () => {
    const host = new FakePermissionHost("deny");
    let ran = false;
    await expect(
      host.service().guard(requestInput(), () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(ran).toBe(false);
    expect(host.pending.size).toBe(0);
  });

  test("runs an asked effect only after a terminal reply and a ready transport", async () => {
    const host = new FakePermissionHost("ask");
    let ran = false;
    const guarded = host.service().guard(requestInput(), () => {
      ran = true;
      return "ran";
    });

    await waitForPending(host);
    expect(ran).toBe(false);
    expect(host.createdBeforeConnected).toBe(false);
    const [requestID, pending] = [...host.pending.entries()][0]!;
    await host.client.permission.reply({
      sessionID: pending.sessionID,
      requestID,
      decision: "once",
    });

    expect(await guarded).toBe("ran");
    expect(ran).toBe(true);
    expect(host.pending.size).toBe(0);
  });

  test("an instant auto-review reply is received after the handshake and allows the effect", async () => {
    const host = new FakePermissionHost("ask");
    host.autoReply = "once";
    let ran = false;
    const result = await host.service().guard(requestInput(), () => {
      ran = true;
      return "auto";
    });

    expect(result).toBe("auto");
    expect(ran).toBe(true);
    expect(host.createdBeforeConnected).toBe(false);
  });

  test("a rejected reply denies the effect with zero side effects", async () => {
    const host = new FakePermissionHost("ask");
    let ran = false;
    const guarded = host.service().guard(requestInput(), () => {
      ran = true;
    });

    await waitForPending(host);
    const [requestID, pending] = [...host.pending.entries()][0]!;
    await host.client.permission.reply({
      sessionID: pending.sessionID,
      requestID,
      decision: "reject",
    });

    await expect(guarded).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ran).toBe(false);
    expect(host.pending.size).toBe(0);
  });

  test("skips unrelated events while awaiting the matching terminal reply", async () => {
    const host = new FakePermissionHost("ask");
    let ran = false;
    const guarded = host.service().guard(requestInput(), () => {
      ran = true;
      return "ok";
    });

    await waitForPending(host);
    const [requestID, pending] = [...host.pending.entries()][0]!;
    host.stream.emit({ type: "session.created", data: { id: "ses_other" } });
    host.stream.emit({
      type: "permission.replied",
      data: { sessionID: "ses_other", requestID: "per_other", reply: "once" },
    });
    host.stream.emit({
      type: "permission.replied",
      data: { sessionID: pending.sessionID, requestID, reply: "once" },
    });

    expect(await guarded).toBe("ok");
    expect(ran).toBe(true);
  });

  test("a transport disconnect before a reply fails closed", async () => {
    const host = new FakePermissionHost("ask");
    let ran = false;
    const guarded = host.service().guard(requestInput(), () => {
      ran = true;
    });

    await waitForPending(host);
    host.stream.disconnect();

    await expect(guarded).rejects.toBeInstanceOf(PermissionAbortedError);
    expect(ran).toBe(false);
    expect(host.pending.size).toBe(1);
  });

  test("bounded readiness times out when the handshake never completes", async () => {
    const host = new FakePermissionHost("ask");
    host.stream.connectDelayTicks = 50;
    let ran = false;

    await expect(
      host.service().guard(
        requestInput(),
        () => {
          ran = true;
        },
        { readinessTimeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(PermissionAbortedError);

    expect(ran).toBe(false);
    expect(host.createCalls).toBe(0);
  });

  test("cancellation immediately after the allow reply prevents the effect", async () => {
    const host = new FakePermissionHost("ask");
    const controller = new AbortController();
    host.autoReply = "once";
    host.afterAutoReply = () => controller.abort();
    let ran = false;

    await expect(
      host.service().guard(
        requestInput(),
        () => {
          ran = true;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(PermissionAbortedError);

    expect(ran).toBe(false);
  });

  test("cancellation before creation aborts and creates nothing", async () => {
    const host = new FakePermissionHost("ask");
    const controller = new AbortController();
    controller.abort();
    let ran = false;

    await expect(
      host.service().guard(
        requestInput(),
        () => {
          ran = true;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(PermissionAbortedError);

    expect(ran).toBe(false);
    expect(host.createCalls).toBe(0);
    expect(host.pending.size).toBe(0);
  });

  test("permission diagnostics never echo request metadata secrets", async () => {
    const host = new FakePermissionHost("deny");
    const error = await host
      .service()
      .guard(requestInput({ token: SECRET }), () => undefined)
      .then(
        () => undefined,
        (cause: unknown) => cause as Error,
      );

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error?.message).not.toContain(SECRET);
  });
});
