// FILE: src/rpc.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the portable, versioned GUI RPC contract between the native server plugin and the `./gui-experimental` window part: bounded reads and conservative writes of the effective vvoc defaults plus explicit stub/unsupported session-settings verdicts, with Effect Schema codecs bridged to the portable Standard Schema RPC surface.
//   SCOPE: RPC identity/version, four method schemas (defaults.get, defaults.set, session.get, session.patch), bounded value-free DTOs (orchestration profile, config source, plugin toggles projection, stable error codes), and strict client-side reply decoders. It carries no server runtime, no CLI wiring, and no window code, so both the server plugin and the GUI bundle import it without node built-ins.
//   DEPENDS: [effect, @opencode/schema/rpc, src/lib/orchestration.ts]
//   LINKS: [M-GUI-SPIKE, M-PLUGIN-GUI-SETTINGS, DF-GUI-RPC, V-M-PLUGIN-GUI-SETTINGS]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_GUI_RPC_ID - Stable versioned GUI RPC id.
//   VVOC_GUI_RPC_VERSION - DTO schema version required in every reply.
//   VVOC_GUI_METHODS - Registered method names.
//   VvocGuiErrorCode - Stable value-free error codes surfaced through the GUI contract.
//   DefaultsGetInput - Input type of the defaults.get method.
//   DefaultsGetOutput - Output type of the defaults.get method.
//   DefaultsSetInput - Input type of the defaults.set method.
//   DefaultsSetOutput - Output type of the defaults.set method.
//   SessionGetInput - Input type of the session.get method.
//   SessionGetOutput - Output type of the session.get method.
//   SessionPatchInput - Input type of the session.patch method.
//   SessionPatchOutput - Output type of the session.patch method.
//   vvocGuiRpc - Portable RPC definition registered server-side and called from the GUI part.
//   decodeDefaultsGetOutput - Strict client-side decoder for the defaults.get reply.
//   decodeDefaultsSetOutput - Strict client-side decoder for the defaults.set reply.
//   decodeSessionGetOutput - Strict client-side decoder for the session.get reply.
//   decodeSessionPatchOutput - Strict client-side decoder for the session.patch reply.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added the versioned GUI RPC contract with Effect Schema codecs bridged to the portable RPC surface, bounded defaults/session DTOs, and strict reply decoders.]
// END_CHANGE_SUMMARY

import { Schema } from "effect";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Rpc } from "@opencode/schema/rpc";
import { ORCHESTRATION_PROFILE_NAMES } from "./lib/orchestration.js";

/** Stable versioned GUI RPC id. */
export const VVOC_GUI_RPC_ID = "vvoc.gui.v1" as const;
/** DTO schema version required in every reply. */
export const VVOC_GUI_RPC_VERSION = 1 as const;

/** Stable value-free error codes surfaced through the GUI contract. */
export type VvocGuiErrorCode =
  | "config_unavailable"
  | "config_invalid"
  | "session_lookup_failed"
  | "session_settings_unsupported";

/** Registered method names. */
export const VVOC_GUI_METHODS = {
  defaultsGet: "defaults.get",
  defaultsSet: "defaults.set",
  sessionGet: "session.get",
  sessionPatch: "session.patch",
} as const;

// START_BLOCK_CONTRACT_SCHEMAS
const CONFIG_ERROR_CODES = ["config_unavailable", "config_invalid"] as const;
const SESSION_ERROR_CODES = ["session_lookup_failed", "session_settings_unsupported"] as const;

/** Bounded config-source projection: where the effective vvoc defaults came from. */
const SourceSchema = Schema.Struct({
  kind: Schema.Literals(["env", "project", "global", "default", "missing"]),
  path: Schema.optional(Schema.String),
});

/** Input of `defaults.get`: no parameters. */
export type DefaultsGetInput = Schema.Struct.Type<{}>;
const DefaultsGetInputSchema = Schema.Struct({});

/** Output of `defaults.get`: the bounded effective-defaults projection, or a value-free unavailable verdict. */
const DefaultsGetOutputSchema = Schema.Struct({
  version: Schema.Literal(VVOC_GUI_RPC_VERSION),
  status: Schema.Literals(["available", "unavailable"]),
  profile: Schema.optional(Schema.Literals([...ORCHESTRATION_PROFILE_NAMES])),
  plugins: Schema.optional(
    Schema.Struct({
      guardian: Schema.Boolean,
      analytics: Schema.Boolean,
      peakHours: Schema.Boolean,
    }),
  ),
  source: Schema.optional(SourceSchema),
  error: Schema.optional(Schema.Literals([...CONFIG_ERROR_CODES])),
});
export type DefaultsGetOutput = (typeof DefaultsGetOutputSchema)["Type"];

/** Input of `defaults.set`: one bounded profile write with an explicit config scope. */
const DefaultsSetInputSchema = Schema.Struct({
  profile: Schema.Literals([...ORCHESTRATION_PROFILE_NAMES]),
  scope: Schema.Literals(["global", "project"]),
});
export type DefaultsSetInput = (typeof DefaultsSetInputSchema)["Type"];

/** Output of `defaults.set`: the conservative CLI write verdict for the requested profile. */
const DefaultsSetOutputSchema = Schema.Struct({
  version: Schema.Literal(VVOC_GUI_RPC_VERSION),
  action: Schema.Literals(["updated", "kept", "rejected", "unavailable"]),
  profile: Schema.Literals([...ORCHESTRATION_PROFILE_NAMES]),
  path: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Literals([...CONFIG_ERROR_CODES])),
});
export type DefaultsSetOutput = (typeof DefaultsSetOutputSchema)["Type"];

/** Input of `session.get`: one session id. */
const SessionGetInputSchema = Schema.Struct({
  sessionID: Schema.String,
});
export type SessionGetInput = (typeof SessionGetInputSchema)["Type"];

/** Output of `session.get`: the stub projection until session-owned settings merge. */
const SessionGetOutputSchema = Schema.Struct({
  version: Schema.Literal(VVOC_GUI_RPC_VERSION),
  status: Schema.Literals(["stub", "unavailable"]),
  profile: Schema.optional(Schema.Literals([...ORCHESTRATION_PROFILE_NAMES])),
  note: Schema.String,
  error: Schema.optional(Schema.Literals(["session_lookup_failed", ...CONFIG_ERROR_CODES])),
});
export type SessionGetOutput = (typeof SessionGetOutputSchema)["Type"];

/** Input of `session.patch`: one session id; the patchable shape arrives with session-owned settings. */
const SessionPatchInputSchema = Schema.Struct({
  sessionID: Schema.String,
});
export type SessionPatchInput = (typeof SessionPatchInputSchema)["Type"];

/** Output of `session.patch`: the explicit unsupported verdict, or a session lookup failure. */
const SessionPatchOutputSchema = Schema.Struct({
  version: Schema.Literal(VVOC_GUI_RPC_VERSION),
  status: Schema.Literals(["unsupported", "unavailable"]),
  error: Schema.Literals([...SESSION_ERROR_CODES, ...CONFIG_ERROR_CODES]),
});
export type SessionPatchOutput = (typeof SessionPatchOutputSchema)["Type"];

/**
 * Bridges one Effect Schema codec onto the portable Standard Schema surface the
 * host registrar and client require, keeping the Effect codecs as the single
 * source of truth for validation and types.
 */
function portable<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
): StandardSchemaV1<S["Encoded"], S["Type"]> {
  return Schema.toStandardSchemaV1(schema);
}
// END_BLOCK_CONTRACT_SCHEMAS

// START_BLOCK_RPC_DEFINITION
/**
 * Portable GUI RPC definition registered server-side by the native server plugin
 * and called from the `./gui-experimental` window part through `ctx.client.rpc`.
 */
export const vvocGuiRpc = {
  id: VVOC_GUI_RPC_ID,
  methods: {
    [VVOC_GUI_METHODS.defaultsGet]: {
      input: portable(DefaultsGetInputSchema),
      output: portable(DefaultsGetOutputSchema),
    },
    [VVOC_GUI_METHODS.defaultsSet]: {
      input: portable(DefaultsSetInputSchema),
      output: portable(DefaultsSetOutputSchema),
    },
    [VVOC_GUI_METHODS.sessionGet]: {
      input: portable(SessionGetInputSchema),
      output: portable(SessionGetOutputSchema),
    },
    [VVOC_GUI_METHODS.sessionPatch]: {
      input: portable(SessionPatchInputSchema),
      output: portable(SessionPatchOutputSchema),
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
// END_BLOCK_RPC_DEFINITION

// START_BLOCK_REPLY_DECODERS
/** Strict client-side decoder for the `defaults.get` reply. */
export function decodeDefaultsGetOutput(value: unknown): DefaultsGetOutput {
  return Schema.decodeUnknownSync(DefaultsGetOutputSchema)(value);
}

/** Strict client-side decoder for the `defaults.set` reply. */
export function decodeDefaultsSetOutput(value: unknown): DefaultsSetOutput {
  return Schema.decodeUnknownSync(DefaultsSetOutputSchema)(value);
}

/** Strict client-side decoder for the `session.get` reply. */
export function decodeSessionGetOutput(value: unknown): SessionGetOutput {
  return Schema.decodeUnknownSync(SessionGetOutputSchema)(value);
}

/** Strict client-side decoder for the `session.patch` reply. */
export function decodeSessionPatchOutput(value: unknown): SessionPatchOutput {
  return Schema.decodeUnknownSync(SessionPatchOutputSchema)(value);
}
// END_BLOCK_REPLY_DECODERS
