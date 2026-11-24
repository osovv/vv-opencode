// FILE: src/lib/opencode/vvoc-orchestration-migration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Remove legacy root and per-preset orchestration sections from existing vvoc.json documents with a timestamped backup and a change report before strict schema validation.
//   SCOPE: Explicit project and global document discovery, formatting-preserving key removal through jsonc-parser edits, timestamped sibling backups, per-file removed-section reporting, and left-untouched invalid JSON. It never creates, renders, or validates a config document; strict validation remains the caller's job so unlisted errors still fail loudly.
//   DEPENDS: [jsonc-parser, node:fs/promises, src/lib/opencode/paths.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MigratedVvocDocument - One migrated document with its removed sections and backup path.
//   VvocOrchestrationMigrationOutcome - Migrated, unchanged, and invalid documents from one pass.
//   migrateVvocOrchestration - Removes legacy orchestration sections from the given config documents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-REMOVE-SESSION-ORCHESTRATION-PROFILES T-004 - Added the explicit host-gated legacy orchestration migration with backup and change reporting.]
// END_CHANGE_SUMMARY

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { readFile, writeFile } from "node:fs/promises";

/** One migrated document with its removed sections and backup path. */
export interface MigratedVvocDocument {
  readonly path: string;
  readonly sections: readonly string[];
  readonly backupPath: string;
}

/** Migrated, unchanged, and invalid documents from one migration pass. */
export interface VvocOrchestrationMigrationOutcome {
  readonly migrated: readonly MigratedVvocDocument[];
  readonly unchanged: readonly string[];
  readonly skippedInvalid: readonly string[];
}

const EDIT_OPTIONS = {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Remove every root and per-preset orchestration section from each document.
 * A document with no such sections is unchanged and gets no backup. Invalid JSON
 * is left untouched so the strict config read that follows fails loudly instead
 * of the migration hiding the problem. The pass is idempotent.
 */
export async function migrateVvocOrchestration(
  paths: ReadonlyArray<{ readonly vvocConfigPath: string }>,
): Promise<VvocOrchestrationMigrationOutcome> {
  const migrated: MigratedVvocDocument[] = [];
  const unchanged: string[] = [];
  const skippedInvalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of paths) {
    const filePath = entry.vvocConfigPath;
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const text = await readOptionalText(filePath);
    if (text === undefined) {
      unchanged.push(filePath);
      continue;
    }

    const errors: ParseError[] = [];
    const document: unknown = parse(text, errors);
    if (errors.length > 0 || !isRecord(document)) {
      skippedInvalid.push(filePath);
      continue;
    }

    let edited = text;
    const sections: string[] = [];
    if (Object.hasOwn(document, "orchestration")) {
      edited = applyEdits(edited, modify(edited, ["orchestration"], undefined, EDIT_OPTIONS));
      sections.push("orchestration");
    }
    if (isRecord(document.presets)) {
      for (const [presetName, preset] of Object.entries(document.presets)) {
        if (!isRecord(preset) || !Object.hasOwn(preset, "orchestration")) continue;
        edited = applyEdits(
          edited,
          modify(edited, ["presets", presetName, "orchestration"], undefined, EDIT_OPTIONS),
        );
        sections.push(`presets.${presetName}.orchestration`);
      }
    }

    if (sections.length === 0) {
      unchanged.push(filePath);
      continue;
    }

    const backupPath = `${filePath}.vvoc-backup-${Date.now()}`;
    await writeFile(backupPath, text, "utf8");
    await writeFile(filePath, edited, "utf8");
    migrated.push({ path: filePath, sections, backupPath });
  }

  return { migrated, unchanged, skippedInvalid };
}
