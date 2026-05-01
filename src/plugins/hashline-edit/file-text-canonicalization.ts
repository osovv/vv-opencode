// FILE: src/plugins/hashline-edit/file-text-canonicalization.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Canonicalize file text for anchor validation while preserving BOM and original line endings on write-back.
//   SCOPE: BOM stripping, line-ending normalization, and restoration of the original text envelope after edits.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FileTextEnvelope - Captures the canonical content plus original BOM and line-ending style.
//   canonicalizeFileText - Normalize file text to LF without losing BOM or line-ending metadata.
//   restoreFileText - Reapply the original line-ending style and BOM to canonical content.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

export interface FileTextEnvelope {
  content: string;
  hadBom: boolean;
  lineEnding: "\n" | "\r\n";
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) {
    return "\n";
  }
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

function stripBom(content: string): { content: string; hadBom: boolean } {
  if (!content.startsWith("\uFEFF")) {
    return { content, hadBom: false };
  }
  return { content: content.slice(1), hadBom: true };
}

function normalizeToLf(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n"): string {
  if (lineEnding === "\n") {
    return content;
  }
  return content.replace(/\n/g, "\r\n");
}

export function canonicalizeFileText(content: string): FileTextEnvelope {
  const stripped = stripBom(content);
  return {
    content: normalizeToLf(stripped.content),
    hadBom: stripped.hadBom,
    lineEnding: detectLineEnding(stripped.content),
  };
}

export function restoreFileText(content: string, envelope: FileTextEnvelope): string {
  const withLineEnding = restoreLineEndings(content, envelope.lineEnding);
  return envelope.hadBom ? `\uFEFF${withLineEnding}` : withLineEnding;
}
