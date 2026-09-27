// FILE: src/runtime/client.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native same-instance full-client authentication: exact-version discovery, native registration headers, random RPC challenge, fail-closed mismatch handling, and credential-safe diagnostics.
//   SCOPE: Deterministic fixture-host assertions for client.ts; no real host, network, or V1 client.
//   DEPENDS: [bun:test, src/runtime/client.js, src/runtime/types.js]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeNativeClientHost - Configurable discovery/registration/client double used by the authentication assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-001 - Covered per-instance challenge channels, mismatch fail-closed behavior, and credential-safe diagnostics.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { acquireNativeClient, nativeRuntimeChallengeID } from "./client.js";
import {
  RuntimeChallengeError,
  RuntimeUnavailableError,
  SUPPORTED_SERVICE_VERSION,
  type RuntimeClient,
  type RuntimeContext,
  type RuntimeDeps,
  type RuntimeEndpoint,
  type RuntimeLocation,
  type RuntimeRpcCallOptions,
  type RuntimeRpcMethods,
} from "./types.js";

const AUTH_PASSWORD = "runtime-secret";
const AUTH_HEADER = "Basic b3BlbmNvZGU6cnVudGltZS1zZWNyZXQ=";

function makeLocation(directory: string): RuntimeLocation {
  return { directory, project: { id: "project-1", directory, canonical: directory } };
}

type NativeHandler = (input: unknown, context: unknown) => Promise<unknown>;

// START_BLOCK_FIXTURE_HOST
class FakeNativeClientHost {
  readonly handlers = new Map<string, Record<string, NativeHandler>>();
  registerCalls = 0;
  disposeCalls = 0;
  discoverCalls = 0;
  makeClientCalls = 0;
  discoveredVersion: string | undefined;
  lastHeaders: Record<string, string> | undefined;
  discovery: RuntimeEndpoint | undefined = {
    url: "http://127.0.0.1:41234",
    auth: { type: "basic", username: "opencode", password: AUTH_PASSWORD },
  };
  /** When set, the challenge response bypasses the registered handler. */
  responder: ((nonce: string) => unknown) | undefined;

  createContext(location: RuntimeLocation): RuntimeContext {
    return {
      location,
      rpc: {
        register: async (definition, handlers) => {
          this.registerCalls += 1;
          this.handlers.set(definition.id, handlers as unknown as Record<string, NativeHandler>);
          return {
            dispose: async () => {
              this.disposeCalls += 1;
              this.handlers.delete(definition.id);
            },
          };
        },
      },
    };
  }

  probeHandler(definitionID: string): NativeHandler | undefined {
    return this.handlers.get(definitionID)?.instance;
  }

  createDeps(): RuntimeDeps<RuntimeClient> {
    return {
      serviceVersion: SUPPORTED_SERVICE_VERSION,
      discoverService: async (options) => {
        this.discoverCalls += 1;
        this.discoveredVersion = options.version;
        return this.discovery;
      },
      serviceHeaders: () => {
        return { authorization: AUTH_HEADER };
      },
      makeClient: () => {
        this.makeClientCalls += 1;
        return createFakeClient(this);
      },
    };
  }
}

function createFakeClient(host: FakeNativeClientHost): RuntimeClient {
  const rpc = ((definition) => {
    const methods: Record<
      string,
      (input: unknown, options?: RuntimeRpcCallOptions) => Promise<unknown>
    > = {};
    for (const name of Object.keys(definition.methods)) {
      methods[name] = async (input) => {
        const nonce = (input as { nonce: string }).nonce;
        if (host.responder !== undefined) return host.responder(nonce);
        const handler = host.handlers.get(definition.id)?.[name];
        if (handler === undefined) throw new Error(`Unknown RPC handler: ${definition.id}.${name}`);
        return handler(input, {});
      };
    }
    return methods as unknown as RuntimeRpcMethods<typeof definition>;
  }) as RuntimeClient["rpc"];

  return {
    rpc,
    permission: {
      async create() {
        return { id: "per_unused", effect: "deny" as const };
      },
      async get() {
        throw new Error("unused");
      },
      async reply() {},
    },
    event: {
      subscribe() {
        return {
          async *[Symbol.asyncIterator]() {},
        };
      },
    },
  };
}
// END_BLOCK_FIXTURE_HOST

describe("acquireNativeClient", () => {
  test("authenticates the same instance and location through the registered challenge", async () => {
    const host = new FakeNativeClientHost();
    const location = makeLocation("/workspace/auth");
    const acquisition = await acquireNativeClient({
      context: host.createContext(location),
      deps: host.createDeps(),
      instanceId: "instance-a",
      nextNonce: () => "nonce-a",
    });

    expect(acquisition.client).toBeDefined();
    expect(host.registerCalls).toBe(1);
    expect(host.discoverCalls).toBe(1);
    expect(host.discoveredVersion).toBe(SUPPORTED_SERVICE_VERSION);
    expect(host.makeClientCalls).toBe(1);

    const handler = host.probeHandler(nativeRuntimeChallengeID("instance-a"));
    expect(handler).toBeDefined();
    const response = (await handler?.({ nonce: "probe" }, {})) as {
      nonce: string;
      instance: string;
      location: string;
    };
    expect(response).toEqual({
      nonce: "probe",
      instance: "instance-a",
      location: "/workspace/auth",
    });

    await acquisition.dispose();
    expect(host.disposeCalls).toBe(1);
  });

  test("registers a distinct challenge channel per runtime instance so contexts do not collide", async () => {
    const host = new FakeNativeClientHost();
    const context = host.createContext(makeLocation("/workspace/auth"));
    const deps = host.createDeps();

    const first = await acquireNativeClient({
      context,
      deps,
      instanceId: "instance-a",
      nextNonce: () => "nonce-a",
    });
    const second = await acquireNativeClient({
      context,
      deps,
      instanceId: "instance-b",
      nextNonce: () => "nonce-b",
    });

    expect(host.registerCalls).toBe(2);
    expect(host.handlers.size).toBe(2);
    expect(host.probeHandler(nativeRuntimeChallengeID("instance-a"))).toBeDefined();
    expect(host.probeHandler(nativeRuntimeChallengeID("instance-b"))).toBeDefined();
    expect(first.client).toBeDefined();
    expect(second.client).toBeDefined();

    await first.dispose();
    await second.dispose();
    expect(host.disposeCalls).toBe(2);
  });

  test("fails closed when the challenge instance differs and releases the registration", async () => {
    const host = new FakeNativeClientHost();
    host.responder = (nonce) => ({
      nonce,
      instance: "foreign-instance",
      location: "/workspace/auth",
    });

    await expect(
      acquireNativeClient({
        context: host.createContext(makeLocation("/workspace/auth")),
        deps: host.createDeps(),
        instanceId: "instance-a",
        nextNonce: () => "nonce-a",
      }),
    ).rejects.toBeInstanceOf(RuntimeChallengeError);
    expect(host.disposeCalls).toBe(1);
  });

  test("fails closed when the challenge location differs", async () => {
    const host = new FakeNativeClientHost();
    host.responder = (nonce) => ({ nonce, instance: "instance-a", location: "/workspace/other" });

    await expect(
      acquireNativeClient({
        context: host.createContext(makeLocation("/workspace/auth")),
        deps: host.createDeps(),
        instanceId: "instance-a",
        nextNonce: () => "nonce-a",
      }),
    ).rejects.toBeInstanceOf(RuntimeChallengeError);
    expect(host.disposeCalls).toBe(1);
  });

  test("fails closed when the nonce is not echoed", async () => {
    const host = new FakeNativeClientHost();
    host.responder = () => ({
      nonce: "replayed",
      instance: "instance-a",
      location: "/workspace/auth",
    });

    await expect(
      acquireNativeClient({
        context: host.createContext(makeLocation("/workspace/auth")),
        deps: host.createDeps(),
        instanceId: "instance-a",
        nextNonce: () => "nonce-a",
      }),
    ).rejects.toBeInstanceOf(RuntimeChallengeError);
  });

  test("fails closed on a malformed challenge payload", async () => {
    const host = new FakeNativeClientHost();
    host.responder = () => "not-an-object";

    await expect(
      acquireNativeClient({
        context: host.createContext(makeLocation("/workspace/auth")),
        deps: host.createDeps(),
        instanceId: "instance-a",
        nextNonce: () => "nonce-a",
      }),
    ).rejects.toBeInstanceOf(RuntimeChallengeError);
  });

  test("fails closed without a compatible service and never builds a client", async () => {
    const host = new FakeNativeClientHost();
    host.discovery = undefined;

    await expect(
      acquireNativeClient({
        context: host.createContext(makeLocation("/workspace/auth")),
        deps: host.createDeps(),
        instanceId: "instance-a",
      }),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
    expect(host.makeClientCalls).toBe(0);
    expect(host.disposeCalls).toBe(1);
  });

  test("fails closed when the discovered service does not expose the challenge", async () => {
    const host = new FakeNativeClientHost();
    host.responder = () => {
      throw new Error("RPC is unavailable: vvoc.native-runtime");
    };

    await expect(
      acquireNativeClient({
        context: host.createContext(makeLocation("/workspace/auth")),
        deps: host.createDeps(),
        instanceId: "instance-a",
        nextNonce: () => "nonce-a",
      }),
    ).rejects.toBeInstanceOf(RuntimeChallengeError);
    expect(host.disposeCalls).toBe(1);
  });

  test("keeps diagnostics credential-safe", async () => {
    const host = new FakeNativeClientHost();
    host.responder = () => "not-an-object";

    const error = await acquireNativeClient({
      context: host.createContext(makeLocation("/workspace/auth")),
      deps: host.createDeps(),
      instanceId: "instance-a",
      nextNonce: () => "nonce-a",
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );

    expect(error).toBeInstanceOf(RuntimeChallengeError);
    expect(error?.message).not.toContain(AUTH_PASSWORD);
    expect(error?.message).not.toContain(AUTH_HEADER);
  });
});
