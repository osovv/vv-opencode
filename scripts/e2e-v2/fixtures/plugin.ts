#!/usr/bin/env bun
// FILE: scripts/e2e-v2/fixtures/plugin.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Wrap the actual packed ModelRolesPlugin.setup in a harness-owned plugin that shares its real context, enforces a mandatory loopback network guard, and exposes a bounded inspection/admission/permission control plane for the driver.
//   SCOPE: Call the real plugin setup, acquire the same shared native snapshot runtime, register mandatory http/model/ws destination guards whose registration failure aborts setup, serve a nonce-protected 127.0.0.1 control plane that only forwards to real runtime methods, dispose every registration and runtime lease on both normal and failed setup, and bound the in-memory event queue. It never reproduces selection, policy, admission, or permission behavior; it only calls the packaged implementation. The module has no import-time side effects.
//   DEPENDS: [node:crypto, node:fs, node:http, scripts/e2e-v2/host.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS, M-PLUGIN-MODEL-ROLES]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HARNESS_PLUGIN_ID - Stable id of the harness fixture plugin.
//   Registration - Native hook registration shape with an awaitable dispose.
//   HarnessRuntime - Narrow structural view of the real shared runtime the control plane forwards to.
//   HarnessPluginDeps - Packaged plugin, runtime acquisition, guard origins, and control-plane configuration.
//   HarnessControlInfo - Nonce-protected discovery record written for the driver.
//   createHarnessPlugin - Build the plugin object after the owner calls setup.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-003 correction - Made the loopback destination guard mandatory, used native Registration.dispose, released the runtime lease, and ran cleanup on failed setup.]
// END_CHANGE_SUMMARY

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Stable id of the harness fixture plugin. */
export const HARNESS_PLUGIN_ID = "vvoc.e2e.fixture";

/** Native hook registration shape with an awaitable dispose. */
export interface Registration {
  dispose(): Promise<void> | void;
}

/** Narrow structural view of the real shared runtime the control plane forwards to. */
export interface HarnessRuntime {
  readonly runtime: {
    readonly instanceId: string;
    readonly location: { readonly directory: string };
    readonly identity: unknown;
  };
  readonly snapshots: {
    captures(): Promise<unknown>;
    variants(familyId?: string): Promise<unknown>;
    familyOf(sessionID: string): Promise<string>;
    policy(sessionID: string): Promise<unknown>;
    configFor(sessionID: string): Promise<unknown>;
    hasStaged(familyId: string): Promise<boolean>;
  };
  admitWorkload(request: Record<string, unknown>): Promise<unknown>;
  client(): Promise<unknown>;
  readonly permissions: {
    request(input: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;
    guard<T>(
      input: Record<string, unknown>,
      effect: () => Promise<T> | T,
      options?: Record<string, unknown>,
    ): Promise<T>;
  };
  release(): Promise<void> | void;
  lastConfigError?(): string | undefined;
}

/** Packaged plugin, runtime acquisition, guard origins, and control-plane configuration. */
export interface HarnessPluginDeps {
  readonly modelRolesPlugin: {
    setup(
      context: unknown,
    ): Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
  };
  readonly acquireRuntime: (context: unknown) => Promise<HarnessRuntime>;
  readonly controlFilePath: string;
  readonly providerOrigin: string;
  readonly allowedProviders: readonly string[];
  readonly tracePath?: string;
  /** When set, delays native preparation after the real prompt hook for prompts carrying this marker. */
  readonly delayMarker?: string;
  readonly delayMs?: number;
}

/** Nonce-protected discovery record written for the driver. */
export interface HarnessControlInfo {
  readonly port: number;
  readonly nonce: string;
  readonly pid: number;
  readonly pluginID: string;
}

const MAX_EVENT_QUEUE = 500;

// START_BLOCK_GUARDS
/** Assert an outgoing request URL stays on the owned loopback fixture origin. */
function assertOwnedOrigin(rawUrl: string, providerOrigin: string, label: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`e2e network guard: ${label} is not an absolute URL: ${rawUrl}`);
  }
  if (url.origin !== providerOrigin) {
    throw new Error(
      `e2e network guard: refusing ${label} to non-fixture origin ${url.origin} (owned ${providerOrigin})`,
    );
  }
}
// END_BLOCK_GUARDS

// START_BLOCK_CONTROL_PLANE
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        request.destroy();
        resolvePromise({});
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolvePromise(text.length > 0 ? JSON.parse(text) : {});
      } catch {
        resolvePromise({});
      }
    });
    request.on("error", () => resolvePromise({}));
  });
}

/** Build the request handler that only forwards to real runtime methods. */
function createControlHandler(input: {
  readonly runtime: HarnessRuntime;
  readonly nonce: string;
  readonly allowedProviders: ReadonlySet<string>;
  readonly events: unknown[];
  readonly eventCounts: Record<string, number>;
  readonly hookProbe: () => Promise<Record<string, boolean>>;
  readonly guardState: Record<string, boolean>;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const { runtime, nonce, allowedProviders, events, eventCounts, hookProbe, guardState } = input;
  return (request, response) => {
    void (async () => {
      if (request.headers["x-e2e-nonce"] !== nonce) {
        sendJson(response, 403, { error: "bad nonce" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const sessionID = url.searchParams.get("sessionID") ?? undefined;
      try {
        if (request.method === "GET" && url.pathname === "/status") {
          sendJson(response, 200, {
            ok: true,
            pluginID: HARNESS_PLUGIN_ID,
            setupComplete: true,
            instanceId: runtime.runtime.instanceId,
            controlPID: process.pid,
            lastConfigError: runtime.lastConfigError?.() ?? null,
            allowedProviders: [...allowedProviders],
            eventCounts,
            guardState,
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/captures") {
          sendJson(response, 200, { data: await runtime.snapshots.captures() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/variants") {
          sendJson(response, 200, {
            data: await runtime.snapshots.variants(
              sessionID === undefined ? undefined : await runtime.snapshots.familyOf(sessionID),
            ),
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/family") {
          if (sessionID === undefined) throw new Error("missing sessionID");
          sendJson(response, 200, { familyId: await runtime.snapshots.familyOf(sessionID) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/policy") {
          if (sessionID === undefined) throw new Error("missing sessionID");
          const familyId = await runtime.snapshots.familyOf(sessionID);
          sendJson(response, 200, {
            familyId,
            staged: await runtime.snapshots.hasStaged(familyId),
            capture: (await runtime.snapshots.policy(sessionID)) ?? null,
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/config") {
          if (sessionID === undefined) throw new Error("missing sessionID");
          sendJson(response, 200, {
            capture: (await runtime.snapshots.configFor(sessionID)) ?? null,
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/events") {
          sendJson(response, 200, { data: events });
          return;
        }
        if (request.method === "GET" && url.pathname === "/hook-probe") {
          sendJson(response, 200, { hooks: await hookProbe() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/client") {
          await runtime.client();
          sendJson(response, 200, { ok: true, instanceId: runtime.runtime.instanceId });
          return;
        }
        if (request.method === "POST" && url.pathname === "/admit") {
          const body = (await readBody(request)) as Record<string, unknown>;
          const outcome = await runtime.admitWorkload({
            sessionID: body.sessionID,
            directory: runtime.runtime.location.directory,
            location: runtime.runtime.identity,
            ...(body.explicit === undefined ? {} : { explicit: body.explicit }),
            ...(body.selectionOverride === undefined
              ? {}
              : { selectionOverride: body.selectionOverride }),
            ...(body.workload === undefined ? {} : { workload: body.workload }),
            ...(body.force === undefined ? {} : { force: body.force }),
          });
          sendJson(response, 200, { outcome });
          return;
        }
        if (request.method === "POST" && url.pathname === "/permission") {
          const body = (await readBody(request)) as {
            sessionID?: string;
            action?: string;
            resources?: string[];
          };
          if (body.sessionID === undefined || body.action === undefined) {
            throw new Error("missing sessionID/action");
          }
          const decision = await runtime.permissions.request({
            sessionID: body.sessionID,
            action: body.action,
            resources: body.resources ?? ["e2e://resource"],
          });
          sendJson(response, 200, { decision });
          return;
        }
        if (request.method === "POST" && url.pathname === "/permission-guard") {
          const body = (await readBody(request)) as {
            sessionID?: string;
            action?: string;
            resources?: string[];
          };
          if (body.sessionID === undefined || body.action === undefined) {
            throw new Error("missing sessionID/action");
          }
          let effects = 0;
          try {
            await runtime.permissions.guard(
              {
                sessionID: body.sessionID,
                action: body.action,
                resources: body.resources ?? ["e2e://resource"],
              },
              () => {
                effects += 1;
              },
            );
            sendJson(response, 200, { allowed: true, effects });
          } catch (error) {
            sendJson(response, 200, {
              allowed: false,
              effects,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        sendJson(response, 404, { error: `unknown route ${request.method} ${url.pathname}` });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
// END_BLOCK_CONTROL_PLANE

// START_BLOCK_PLUGIN
/**
 * Build the plugin object. The module stays inert until the owner's setup is
 * called; no server, file, or timer is created at import time.
 */
export function createHarnessPlugin(deps: HarnessPluginDeps): {
  readonly id: string;
  readonly setup: (context: unknown) => Promise<() => Promise<void>>;
} {
  const allowedProviders = new Set(deps.allowedProviders);
  return {
    id: HARNESS_PLUGIN_ID,
    async setup(context: unknown) {
      const mark = (payload: unknown): void => {
        try {
          writeFileSync(deps.controlFilePath, JSON.stringify(payload), "utf8");
        } catch {
          // Diagnostics only.
        }
      };
      mark({ stage: "setup-started", pluginID: HARNESS_PLUGIN_ID, at: Date.now() });
      const ctx = context as {
        location: { directory: string };
        session: {
          hook(
            name: string,
            handler: (event: unknown) => Promise<void> | void,
          ): Promise<Registration>;
        };
        event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<unknown> };
      };
      const registrations: Registration[] = [];
      const cleanups: Array<() => Promise<void> | void> = [];
      const events: unknown[] = [];
      const eventCounts: Record<string, number> = {};
      const guardState: Record<string, boolean> = {
        "http.request": false,
        "model.request": false,
        "experimental.ws.handshake": false,
      };
      const eventAbort = new AbortController();
      let server: Server | undefined;

      const disposeAll = async (): Promise<void> => {
        try {
          eventAbort.abort();
        } catch {
          // already aborted
        }
        if (server !== undefined) {
          await closeServer(server).catch(() => undefined);
        }
        for (const registration of registrations.reverse()) {
          try {
            await registration.dispose();
          } catch {
            // best-effort disposal during teardown
          }
        }
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch {
            // best-effort disposal during teardown
          }
        }
      };

      try {
        const modelCleanup = await deps.modelRolesPlugin.setup(context);
        if (typeof modelCleanup === "function") cleanups.push(modelCleanup);
        const runtime = await deps.acquireRuntime(context);
        cleanups.push(() => runtime.release());

        // Mandatory network guard: every outgoing session HTTP request must stay
        // on the owned loopback fixture origin. Registration failure aborts
        // setup, so an unprotected host never serves workload.
        registrations.push(
          await ctx.session.hook("http.request", (event) => {
            const request = (event as { request?: { url?: unknown } } | undefined)?.request;
            const rawUrl = typeof request?.url === "string" ? request.url : undefined;
            if (rawUrl === undefined) {
              throw new Error("e2e network guard: outgoing request has no URL");
            }
            assertOwnedOrigin(rawUrl, deps.providerOrigin, "http.request");
          }),
        );
        guardState["http.request"] = true;

        registrations.push(
          await ctx.session.hook("model.request", (event) => {
            const typed = event as {
              model?: { providerID?: unknown };
              baseURL?: unknown;
              kind?: unknown;
            };
            const providerID = typed.model?.providerID;
            if (typeof providerID === "string" && !allowedProviders.has(providerID)) {
              throw new Error(`e2e network guard: provider ${providerID} is not an owned loopback fixture`);
            }
            const baseURL = typed.baseURL;
            if (typeof baseURL === "string") {
              assertOwnedOrigin(baseURL, deps.providerOrigin, "model.request baseURL");
            }
            if (events.length >= MAX_EVENT_QUEUE) events.shift();
            events.push({
              type: "model.request",
              kind: typed.kind,
              providerID,
              baseURL,
              at: Date.now(),
            });
          }),
        );
        guardState["model.request"] = true;

        // Optional bounded preparation delay registered AFTER the real prompt hook.
        // It only sleeps; it never stages, admits, or publishes anything itself.
        if (
          typeof deps.delayMarker === "string" &&
          deps.delayMarker.length > 0 &&
          typeof deps.delayMs === "number" &&
          deps.delayMs > 0
        ) {
          registrations.push(
            await ctx.session.hook("prompt", async (event) => {
              const prompt = JSON.stringify((event as { prompt?: unknown } | undefined)?.prompt ?? "");
              if (prompt.includes(deps.delayMarker as string)) {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, deps.delayMs));
              }
            }),
          );
        }

        // WebSocket destination guard is enforced when the pinned host exposes
        // the experimental handshake hook; absence is recorded, never fatal.
        try {
          registrations.push(
            await ctx.session.hook("experimental.ws.handshake", (event) => {
              const url = (event as { url?: unknown } | undefined)?.url;
              if (typeof url === "string") {
                assertOwnedOrigin(url, deps.providerOrigin, "experimental.ws.handshake");
              }
            }),
          );
          guardState["experimental.ws.handshake"] = true;
        } catch {
          guardState["experimental.ws.handshake"] = false;
        }

        void (async () => {
          try {
            for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
              const type = (event as { type?: unknown } | undefined)?.type;
              if (typeof type === "string") {
                eventCounts[type] = (eventCounts[type] ?? 0) + 1;
                if (events.length >= MAX_EVENT_QUEUE) events.shift();
                events.push({ type: `event:${type}`, at: Date.now() });
              }
            }
          } catch {
            // Stream closed or aborted during teardown.
          }
        })();

        const hookProbe = async (): Promise<Record<string, boolean>> => {
          const names = [
            "model.request",
            "context",
            "generate",
            "compaction",
            "title",
            "http.request",
            "http.response",
          ];
          const result: Record<string, boolean> = {};
          for (const name of names) {
            try {
              const probe = await ctx.session.hook(name, () => undefined);
              result[name] = true;
              await probe.dispose();
            } catch {
              result[name] = false;
            }
          }
          return result;
        };
        const nonce = randomBytes(12).toString("hex");
        server = createServer(
          createControlHandler({ runtime, nonce, allowedProviders, events, eventCounts, hookProbe, guardState }),
        );
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server?.once("error", rejectPromise);
          server?.listen(0, "127.0.0.1", () => resolvePromise());
        });
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        try {
          writeFileSync(
            deps.controlFilePath,
            JSON.stringify({
              port,
              nonce,
              pid: process.pid,
              pluginID: HARNESS_PLUGIN_ID,
            } satisfies HarnessControlInfo),
            "utf8",
          );
        } catch {
          // The driver reports a missing control file as a harness failure.
        }
        return disposeAll;
      } catch (error) {
        await disposeAll();
        mark({
          stage: "setup-error",
          pluginID: HARNESS_PLUGIN_ID,
          error: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        });
        throw error;
      }
    },
  };
}
// END_BLOCK_PLUGIN
