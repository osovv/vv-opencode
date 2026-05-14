// FILE: src/plugins/hashline-edit/tool-description.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide the LLM-facing tool description for the hash-anchored edit override.
//   SCOPE: Stable instructions for read-then-edit workflow, anchor usage, operation choice, and stale-anchor recovery.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HASHLINE_EDIT_DESCRIPTION - Canonical LLM-facing description for the hashline-backed `edit` tool.
// END_MODULE_MAP
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Split replace into replace (single line) and replace_range (range) to prevent accidental end-boundary errors.]
// END_CHANGE_SUMMARY
export const HASHLINE_EDIT_DESCRIPTION = `Edit files using exact hash-anchored line references from the latest Read output.

<must>
1. SNAPSHOT: All edits in one call reference the ORIGINAL file state. Do NOT adjust line numbers for prior edits in the same batch — the system applies them bottom-up automatically.
2. replace replaces ONE line at pos. It does NOT accept end. For multi-line replacement, use replace_range.
3. replace_range with pos+end replaces ALL lines FROM pos THROUGH end (BOTH INCLUSIVE). The end line WILL BE replaced. If you set end to a line that belongs to the next function/method/statement, that line is DELETED.
   CORRECT: pos on the first line to replace, end on the LAST line to replace — not the line after.
4. lines must contain ONLY the content that belongs inside the replaced range. Lines AFTER end survive unchanged — do NOT include them in lines. If you do, they will appear twice.
5. Tags MUST be copied exactly from read output or >>> mismatch output. NEVER guess or reconstruct tags.
6. Batch = multiple operations in edits[], NOT one big replace covering everything. Each operation targets the smallest possible change.
7. lines must contain plain replacement text only (no LINE#HASH#ANCHOR| prefixes, no diff + markers).
</must>

<operations>
ANCHOR FORMAT:
  Each anchor is \`{line_number}#{hash_id}#{anchor_hash}\` from read output like \`42#VK#AB|content\`.
  Backward-compatible \`{line}#{hash}\` also accepted.

OPERATION CHOICE:
  replace with pos -> replace ONE line at pos (end is rejected)
  replace_range with pos+end -> replace range pos..end INCLUSIVE (both lines replaced)
  append with pos -> insert lines AFTER the anchored line (use when you need to ADD lines, not replace)
  prepend with pos -> insert lines BEFORE the anchored line
  append/prepend without pos -> EOF/BOF insertion (also creates missing files)

CONTENT FORMAT:
  lines: string (single line) or string[] (multi-line, preferred)
  lines: null or lines: [] with replace -> DELETE those lines

FILE MODES:
  delete=true deletes file and requires edits=[] with no rename
  rename moves final content to a new path and removes old path
<operations>

<examples>
Given this file after read:
  10#VK#AB|function hello() {
  11#XJ#CD|  console.log("hi");
  12#MB#EF|  console.log("bye");
  13#QR#GH|} // end of hello()

Single-line replace (change line 11):
  { op: "replace", pos: "11#XJ#CD", lines: ["  console.log("hello");"] }
  Result: line 11 replaced. Lines 10, 12-13 unchanged.

Range replace (replace lines 11-12, function body):
  { op: "replace_range", pos: "11#XJ#CD", end: "12#MB#EF", lines: ["  return "hello world";"] }
  Result: lines 11-12 removed, replaced by 1 new line. Lines 10, 13 unchanged.

BAD - end is one line too far (DELETES closing brace):
  { op: "replace_range", pos: "11#XJ#CD", end: "13#QR#GH", lines: ["  return "hello world";"] }
  Result: line 13 (closing brace) is REPLACED too — function is broken!
  CORRECT: use end: "12#MB#EF" — only replace lines 11-12, keep line 13 unchanged.

BAD - lines extend past end (DUPLICATES line 13):
  { op: "replace_range", pos: "11#XJ#CD", end: "12#MB#EF", lines: ["  return "hi";", "}"] }
  Line 13 is "}" which already exists after end. Including it in lines duplicates it.
  CORRECT: { op: "replace_range", pos: "11#XJ#CD", end: "12#MB#EF", lines: ["  return "hi";"] }

Append after a line (insert between functions):
  { op: "append", pos: "13#QR#GH", lines: ["", "function added() {", "  return true;", "}"] }
  Result: 4 lines inserted after line 13. All existing lines unchanged.
</examples>

<auto>
Built-in autocorrect (you do NOT need to handle these):
  Merged lines are auto-expanded back to original line count.
  Indentation is auto-restored from original lines.
  BOM and CRLF line endings are preserved automatically.
  Hashline prefixes and diff markers in text are auto-stripped.
  Boundary echo lines (duplicating adjacent surviving lines) are auto-stripped.
</auto>

Recovery:
- If you get a hash mismatch error, copy the updated anchors shown in that error or re-read the file before retrying.`;
