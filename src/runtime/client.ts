// FILE: src/runtime/client.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Authenticate the full native client for a plugin instance using only native discovery, native registration headers, and a random same-instance RPC challenge.
//   SCOPE: The challenge RPC definition and its response decoders, credential-safe discovery/authentication, one-shot plugin-instance proof against the plugin's exact location, the default native dependencies, and release of the RPC registration on failure or teardown. Never calls ensure/stop and never parses credentials from logs.
//   DEPENDS: [@opencode/client, @opencode/client/service, @opencode/plugin, node:crypto, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NATIVE_RUNTIME_CHALLENGE_METHOD - Method name of the instance challenge.
//   NATIVE_RUNTIME_CHALLENGE_PREFIX - Stable prefix for the per-runtime challenge RPC id.
//   nativeRuntimeChallengeID - Build the unique challenge RPC id for one runtime instance.
//   createNativeRuntimeChallenge - Build the per-runtime challenge RPC definition so distinct contexts do not collide.
//   ChallengeRequest - Decoded challenge input carrying the random nonce.
//   ChallengeResponse - Decoded challenge output carrying the instance identity and location.
//   decodeChallengeRequest - Decode untrusted challenge input without casting.
//   decodeChallengeResponse - Decode untrusted challenge output without casting.
//   disposeQuietly - Release a registration while swallowing teardown errors.
//   nativeRuntimeDeps - Default native discovery/header/client implementation.
//   NativeClientAcquisition - Authenticated client plus a dispose handle for its RPC registration.
//   NativeClientAcquisitionOptions - Inputs required to discover, authenticate, and challenge a client.
//   acquireNativeClient - Discover, authenticate, challenge, and return the full native client.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-001 - Made the challenge RPC id per-runtime so distinct plugin contexts register without collision.]
// END_CHANGE_SUMMARY

import { randomBytes } from "node:crypto";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import { Rpc } from "@opencode/plugin";
import {
  RuntimeChallengeError,
  RuntimeUnavailableError,
  SUPPORTED_SERVICE_VERSION,
  type RuntimeClient,
  type RuntimeContext,
  type RuntimeDeps,
  type RuntimeRpcRegistration,
} from "./types.js";

/** Method name of the instance challenge. */
export const NATIVE_RUNTIME_CHALLENGE_METHOD = "instance";

/** Stable prefix for the per-runtime challenge RPC id. */
export const NATIVE_RUNTIME_CHALLENGE_PREFIX = "vvoc.native-runtime";

/** Unique challenge RPC id for one runtime instance; distinct contexts never collide. */
export function nativeRuntimeChallengeID(instanceId: string): string {
  return `${NATIVE_RUNTIME_CHALLENGE_PREFIX}.${instanceId}`;
}

/**
 * Portable RPC definition used to prove the discovered service is the loading
 * plugin instance. The id is derived from the per-runtime instance identity so
 * two live runtimes in one host register distinct RPC channels. JSON Schema
 * keeps the foundation dependency-free; fields are decoded at the checked
 * boundary instead of being cast.
 */
export function createNativeRuntimeChallenge(instanceId: string) {
  return Rpc.define({
    id: nativeRuntimeChallengeID(instanceId),
    methods: {
      instance: {
        input: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            nonce: { type: "string" },
            instance: { type: "string" },
            location: { type: "string" },
          },
          required: ["nonce", "instance", "location"],
          additionalProperties: false,
        },
      },
    },
    events: {},
  });
}

// START_BLOCK_CHALLENGE_DECODING
export interface ChallengeRequest {
  readonly nonce: string;
}

export interface ChallengeResponse {
  readonly nonce: string;
  readonly instance: string;
  readonly location: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Decode untrusted challenge input without casting. */
export function decodeChallengeRequest(value: unknown): ChallengeRequest | undefined {
  if (!isRecord(value) || typeof value.nonce !== "string") return undefined;
  return { nonce: value.nonce };
}

/** Decode untrusted challenge output without casting. */
export function decodeChallengeResponse(value: unknown): ChallengeResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.nonce !== "string" ||
    typeof value.instance !== "string" ||
    typeof value.location !== "string"
  ) {
    return undefined;
  }
  return { nonce: value.nonce, instance: value.instance, location: value.location };
}
// END_BLOCK_CHALLENGE_DECODING

/** Release a registration while swallowing teardown errors. */
export async function disposeQuietly(
  registration: RuntimeRpcRegistration | undefined,
): Promise<void> {
  if (registration === undefined) return;
  try {
    await registration.dispose();
  } catch {
    // Teardown must never mask the acquisition outcome or stop the host.
  }
}

// START_BLOCK_NATIVE_DEPS
/** Default native discovery/header/client implementation. */
export const nativeRuntimeDeps: RuntimeDeps<OpenCodeClient> = {
  serviceVersion: SUPPORTED_SERVICE_VERSION,
  discoverService: (options) => Service.discover({ version: options.version }),
  serviceHeaders: (endpoint: Endpoint) => Service.headers(endpoint),
  makeClient: ({ baseUrl, headers }) => OpenCode.make({ baseUrl, headers }),
};
// END_BLOCK_NATIVE_DEPS

// START_BLOCK_CLIENT_ACQUISITION
/** Authenticated client plus a dispose handle for its RPC registration. */
export interface NativeClientAcquisition<Client extends RuntimeClient> {
  readonly client: Client;
  readonly dispose: () => Promise<void>;
}

/** Inputs required to discover, authenticate, and challenge a client. */
export interface NativeClientAcquisitionOptions<Client extends RuntimeClient> {
  readonly context: RuntimeContext;
  readonly deps: RuntimeDeps<Client>;
  /** Random per-runtime instance identity returned by the challenge handler. */
  readonly instanceId: string;
  /** Runtime lifetime cancellation; aborts an in-flight challenge. */
  readonly lifetimeSignal?: AbortSignal | undefined;
  /** Random per-call nonce source; deterministic in tests. */
  readonly nextNonce?: (() => string) | undefined;
}

function defaultNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Discover the already-running service, authenticate with native registration
 * headers, and prove the endpoint is this loading plugin instance through a
 * random RPC challenge. Fails closed on missing/wrong registration, version, or
 * instance/location mismatch, and releases the RPC registration on any failure.
 */
export async function acquireNativeClient<Client extends RuntimeClient>(
  options: NativeClientAcquisitionOptions<Client>,
): Promise<NativeClientAcquisition<Client>> {
  const { context, deps, instanceId } = options;
  const nextNonce = options.nextNonce ?? defaultNonce;
  const challenge = createNativeRuntimeChallenge(instanceId);
  const registration = await context.rpc.register(challenge, {
    [NATIVE_RUNTIME_CHALLENGE_METHOD]: async (input: unknown) => {
      const request = decodeChallengeRequest(input);
      return {
        nonce: request?.nonce ?? "",
        instance: instanceId,
        location: context.location.directory,
      };
    },
  });

  try {
    const endpoint = await deps.discoverService({ version: deps.serviceVersion });
    if (endpoint === undefined) throw new RuntimeUnavailableError();

    const headers = deps.serviceHeaders(endpoint);
    const client = deps.makeClient({ baseUrl: endpoint.url, headers });
    const nonce = nextNonce();
    let response: unknown;
    try {
      response = await client.rpc(challenge)[NATIVE_RUNTIME_CHALLENGE_METHOD](
        { nonce },
        {
          location: { directory: context.location.directory },
          ...(options.lifetimeSignal === undefined ? {} : { signal: options.lifetimeSignal }),
        },
      );
    } catch (cause) {
      throw new RuntimeChallengeError("the challenge call failed", { cause });
    }
    const decoded = decodeChallengeResponse(response);
    if (decoded === undefined)
      throw new RuntimeChallengeError("the response was not a valid challenge payload");
    if (decoded.nonce !== nonce) throw new RuntimeChallengeError("the nonce was not echoed");
    if (decoded.instance !== instanceId)
      throw new RuntimeChallengeError("the plugin instance did not match");
    if (decoded.location !== context.location.directory)
      throw new RuntimeChallengeError("the location did not match");

    return { client, dispose: () => disposeQuietly(registration) };
  } catch (error) {
    await disposeQuietly(registration);
    throw error;
  }
}
// END_BLOCK_CLIENT_ACQUISITION
