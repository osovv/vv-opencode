// FILE: src/runtime/auxiliary.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide family-settings-bound auxiliary generation for titles and Guardian inference through an explicitly created native child session and native session.generate.
//   SCOPE: Auxiliary child creation parented to the family root (explicit role model from the family settings, recorded workload metadata, not a fork that copies the parent agent), awaited model pinning per use, title-result short-circuit, retention of native title message content, recursion/deadlock guard, and fail-closed refusal when no family settings can be resolved. Never calls the stateless experimental generate API and never invents a model.
//   DEPENDS: [src/runtime/session-settings.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AuxiliaryServiceDeps - Injectable native boundaries for settings-bound auxiliary generation.
//   primarySettingsSelection - Select the family's default model for auxiliary work.
//   createAuxiliaryService - Build the settings-bound auxiliary service consumed by title and Guardian.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Auxiliary children now bind through the family settings view: role selections come from root metadata, qualification and snapshot variants are gone, and the child model is the plain resolved selection.]
// END_CHANGE_SUMMARY

import { SessionLineageError, type FamilySettingsView } from "./session-settings.js";
import type {
  AuxiliaryMessageContent,
  AuxiliaryService,
  AuxiliarySessionApi,
  ModelSelection,
} from "./types.js";

/** Injectable native boundaries for settings-bound auxiliary generation. */
export interface AuxiliaryServiceDeps {
  familyOf(sessionID: string): Promise<string>;
  policy(sessionID: string): Promise<FamilySettingsView | undefined>;
  readonly session: AuxiliarySessionApi;
  /** Runtime location directory used when the family root exposes none. */
  readonly fallbackDirectory: string;
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

/** Select the family's default model for auxiliary work: default role, first role, then the root's native model. */
export function primarySettingsSelection(view: FamilySettingsView): ModelSelection | undefined {
  const defaultRole = view.roleModels.default;
  if (defaultRole !== undefined) return defaultRole;
  for (const selection of Object.values(view.roleModels)) return selection;
  return view.rootModel;
}

/**
 * Build the settings-bound auxiliary service. Bound work runs on a verified
 * lineage child of the family root whose model is the family's resolved role
 * selection; unresolvable settings refuse to fabricate a model.
 */
export function createAuxiliaryService(deps: AuxiliaryServiceDeps): AuxiliaryService {
  const children = new Map<string, string>();
  const active = new Set<string>();

  async function boundChild(
    view: FamilySettingsView,
    kind: "title" | "compaction" | "generate",
    role: string | undefined,
  ): Promise<string | undefined> {
    const selection = role === undefined ? primarySettingsSelection(view) : view.roleModels[role];
    if (selection === undefined) return undefined;
    const cacheKey = `${view.familyId}\u0000${kind}`;
    let child = children.get(cacheKey);
    if (child === undefined) {
      const created = await deps.session.create({
        parentID: view.familyId,
        locationDirectory: view.locationDirectory ?? deps.fallbackDirectory,
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
    view: FamilySettingsView,
    kind: "title" | "compaction" | "generate",
    prompt: string,
    role: string | undefined,
  ): Promise<{ text: string } | undefined> {
    const child = await boundChild(view, kind, role);
    if (child === undefined) return undefined;
    return deps.session.generate({ sessionID: child, prompt });
  }

  const service: AuxiliaryService = {
    async title(event) {
      // A host-supplied title always wins; the plugin never overrides it.
      if (typeof event.result === "string" && event.result.length > 0) return event.result;
      const view = await deps.policy(event.sessionID);
      if (view === undefined) return undefined;
      // Guard the whole family against a bound generate recursively re-entering title work.
      if (active.has(view.familyId)) return undefined;
      active.add(view.familyId);
      try {
        const generated = await generateBound(
          view,
          "title",
          titlePrompt(event.messages),
          event.role,
        );
        return generated?.text;
      } finally {
        active.delete(view.familyId);
      }
    },
    async generate(input) {
      const view = await deps.policy(input.sessionID);
      if (view === undefined) {
        throw new SessionLineageError(
          "Auxiliary generation requires resolvable family settings; refusing stateless generation.",
        );
      }
      if (active.has(view.familyId)) {
        throw new SessionLineageError("Auxiliary generation is already running for this family.");
      }
      active.add(view.familyId);
      try {
        return await generateBound(view, input.kind, input.prompt, input.role);
      } finally {
        active.delete(view.familyId);
      }
    },
  };

  return service;
}
