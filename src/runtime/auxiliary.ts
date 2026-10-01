// FILE: src/runtime/auxiliary.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide snapshot-bound auxiliary generation for titles and Guardian inference through an explicitly bound native child session and native session.generate.
//   SCOPE: Family-bound auxiliary child creation (explicit agent/model binding, not a fork that copies the parent agent), awaited snapshot-qualified switchModel, title-result short-circuit, retention of native title message content, recursion/deadlock guard, and fail-closed refusal when no family policy is bound. Never calls the stateless experimental generate API and never invents a model.
//   DEPENDS: [src/runtime/model-registry.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AuxiliaryServiceDeps - Injectable native boundaries for snapshot-bound auxiliary generation.
//   createAuxiliaryService - Build the snapshot-bound auxiliary service consumed by title and Guardian.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 attempt 5 - Auxiliary children are created by the runtime as real imported parented sessions carrying host-owned workload metadata; this service records kind/role for that import.]
// END_CHANGE_SUMMARY

import { primarySelection, qualifySelection } from "./model-registry.js";
import {
  SnapshotUnboundError,
  type AuxiliaryMessageContent,
  type AuxiliaryService,
  type AuxiliarySessionApi,
  type FamilyCapture,
} from "./types.js";

/** Injectable native boundaries for snapshot-bound auxiliary generation. */
export interface AuxiliaryServiceDeps {
  familyOf(sessionID: string): Promise<string>;
  policy(sessionID: string): Promise<FamilyCapture | undefined>;
  readonly session: AuxiliarySessionApi;
}

const TITLE_INSTRUCTION =
  "Generate a short, specific title for this session from the conversation above.";

/** Build a title prompt from retained native messages plus a stable instruction. */
function titlePrompt(messages: ReadonlyArray<AuxiliaryMessageContent> | undefined): string {
  if (messages === undefined || messages.length === 0) return TITLE_INSTRUCTION;
  const transcript = messages
    .slice(-8)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  return `${transcript}\n\n${TITLE_INSTRUCTION}`;
}

/**
 * Build the snapshot-bound auxiliary service. Bound work runs on a verified
 * lineage child of the family root whose model is the family's captured,
 * family-qualified selection; unbound work refuses to fabricate a model.
 */
export function createAuxiliaryService(deps: AuxiliaryServiceDeps): AuxiliaryService {
  const children = new Map<string, string>();
  const active = new Set<string>();

  async function boundChild(
    capture: FamilyCapture,
    kind: "title" | "compaction" | "generate",
    role: string | undefined,
  ): Promise<string | undefined> {
    const base = role === undefined ? primarySelection(capture) : capture.roleModels[role];
    if (base === undefined) return undefined;
    const selection = qualifySelection(capture, base);
    const cacheKey = `${capture.familyId}\u0000${kind}`;
    let child = children.get(cacheKey);
    if (child === undefined) {
      const created = await deps.session.create({
        parentID: capture.familyId,
        locationDirectory: capture.location.directory,
        title: `vvoc ${kind}`,
        kind,
        ...(role === undefined ? {} : { role }),
        model: selection,
      });
      children.set(cacheKey, created.sessionID);
      child = created.sessionID;
    }
    await deps.session.switchModel({ sessionID: child, model: selection });
    return child;
  }

  async function generateBound(
    capture: FamilyCapture,
    kind: "title" | "compaction" | "generate",
    prompt: string,
    role: string | undefined,
  ): Promise<{ text: string } | undefined> {
    const child = await boundChild(capture, kind, role);
    if (child === undefined) return undefined;
    return deps.session.generate({ sessionID: child, prompt });
  }

  const service: AuxiliaryService = {
    async title(event) {
      // A host-supplied title always wins; the plugin never overrides it.
      if (typeof event.result === "string" && event.result.length > 0) return event.result;
      const capture = await deps.policy(event.sessionID);
      if (capture === undefined) return undefined;
      // Guard the whole family against a bound generate recursively re-entering title work.
      if (active.has(capture.familyId)) return undefined;
      active.add(capture.familyId);
      try {
        const generated = await generateBound(
          capture,
          "title",
          titlePrompt(event.messages),
          event.role,
        );
        return generated?.text;
      } finally {
        active.delete(capture.familyId);
      }
    },
    async generate(input) {
      const capture = await deps.policy(input.sessionID);
      if (capture === undefined) {
        throw new SnapshotUnboundError(
          "Auxiliary generation requires a bound family snapshot; refusing stateless generation.",
        );
      }
      if (active.has(capture.familyId)) {
        throw new SnapshotUnboundError("Auxiliary generation is already running for this family.");
      }
      active.add(capture.familyId);
      try {
        return await generateBound(capture, input.kind, input.prompt, input.role);
      } finally {
        active.delete(capture.familyId);
      }
    },
  };

  return service;
}
