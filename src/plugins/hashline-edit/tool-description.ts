// FILE: src/plugins/hashline-edit/tool-description.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide the LLM-facing tool description for the hash-anchored edit override.
//   SCOPE: Stable instructions for read-then-edit workflow, anchor usage, operation choice, literal payload semantics, and stale-anchor recovery.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HASHLINE_EDIT_DESCRIPTION - Canonical LLM-facing description for the hashline-backed `edit` tool.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.8.0 - Documented literal application, physical single-line entries, blank-payload rejection, exact echo trimming with warnings, and the post-edit diff summary.]
// END_CHANGE_SUMMARY
export const HASHLINE_EDIT_DESCRIPTION = `Edit files using exact hash-anchored line references from the latest Read output.

<must>
1. SNAPSHOT: All edits in one call reference the ORIGINAL file state. Do NOT adjust line numbers for prior edits in the same batch — the system applies them bottom-up automatically.
2. replace replaces ONE line at pos. It does NOT accept end. For multi-line replacement, use replace_range.
3. replace_range with pos+end replaces ALL lines FROM pos THROUGH end (BOTH INCLUSIVE). The end line WILL BE replaced. If you set end to a line that belongs to the next function/method/statement, that line is DELETED.
   CORRECT: pos on the first line to replace, end on the LAST line to replace — not the line after.
4. lines must contain ONLY the content that belongs inside the replaced range. Lines AFTER end survive unchanged — do NOT include them in lines. If you do, they will appear twice.
   INSERTION SAFETY: To add a function, handler, statement, or block NEXT TO existing code, use append/prepend anchored to a surviving line. To add code AFTER a closed block, append after its final structural closing line. Do NOT replace that closing line merely to reproduce it and add content after it.
   STRUCTURAL CLOSURES: If replace_range intentionally consumes lines containing closing syntax such as }, });, ], ), );, or </tag>, lines MUST include every closure required by the resulting code. Never assume the tool reconstructs omitted closing syntax.
5. Tags MUST be copied exactly from read output or >>> mismatch output. NEVER guess or reconstruct tags.
6. Batch = multiple operations in edits[], NOT one big replace covering everything. Each operation targets the smallest possible change.
7. lines must contain plain replacement text only (no LINE#HASH#ANCHOR| prefixes, no diff + markers).
8. CRITICAL: Double-quote characters inside lines strings MUST be escaped as \\". Unescaped \\" inside a JSON string will break the parser. Example: ["const x = \\"hello\\";"] — NOT ["const x = "hello";"]. Single quotes and backticks do NOT need escaping.
9. LITERAL APPLICATION: payloads are applied byte-for-byte. There is NO merging, splitting, indentation fixing, or other content rewriting. The only automatic removals are exact duplicate echoes, and each one is reported as a Warning line in the result.
10. PHYSICAL LINES: every string[] entry in lines must be exactly one physical line. Entries with embedded newlines are rejected. A string value is split on newlines.
11. DELETION: to delete lines use lines: [] or lines: null with replace/replace_range. lines: [""] is REJECTED because a single blank line is ambiguous — use append/prepend when you really want to insert a blank line.
12. VERIFY: successful results include a bounded diff (@@ block) of what changed. Check that it matches your intent before moving on.
</must>

<operations>
ANCHOR FORMAT:
  Each anchor is \`{line_number}#{hash_id}#{anchor_hash}\` from read output like \`42#VK#AB|content\`.
  Backward-compatible \`{line}#{hash}\` also accepted.

OPERATION CHOICE:
  replace with pos -> replace ONE line at pos (end is rejected)
  replace_range with pos+end -> replace range pos..end INCLUSIVE (both lines replaced); use only when those existing lines must change or be removed
  append with pos -> insert lines AFTER the anchored line; preferred for adding code after a block's final }, });, ], or other closing line
  prepend with pos -> insert lines BEFORE the anchored line; preferred for adding code before an existing declaration or block
  append/prepend without pos -> EOF/BOF insertion (also creates missing files)

CONTENT FORMAT:
  lines: string (single line) or string[] (multi-line, preferred); each array entry is exactly one physical line
  lines: null or lines: [] with replace/replace_range -> DELETE those lines
  lines: [""] with replace/replace_range -> REJECTED (ambiguous); use [] / null to delete, append/prepend to insert blank lines

FILE MODES:
  delete=true deletes file and requires edits=[] with no rename
  rename moves final content to a new path and removes old path
</operations>

<examples>
Given this file after read:
  10#VK#AB|function hello() {
  11#XJ#CD|  console.log("hi");
  12#MB#EF|  console.log("bye");
  13#QR#GH|} // end of hello()

Single-line replace (change line 11):
  { op: "replace", pos: "11#XJ#CD", lines: ["  console.log(\\"hello\\");"] }
  Result: line 11 replaced. Lines 10, 12-13 unchanged.

Range replace (replace lines 11-12, function body):
  { op: "replace_range", pos: "11#XJ#CD", end: "12#MB#EF", lines: ["  return \\"hello world\\";"] }
  Result: lines 11-12 removed, replaced by 1 new line. Lines 10, 13 unchanged.

BAD - end is one line too far (DELETES closing brace):
  { op: "replace_range", pos: "11#XJ#CD", end: "13#QR#GH", lines: ["  return \\"hello world\\";"] }
  Result: line 13 (closing brace) is REPLACED too — function is broken!
  CORRECT: use end: "12#MB#EF" — only replace lines 11-12, keep line 13 unchanged.

BAD - lines extend past end (DUPLICATES line 13):
  { op: "replace_range", pos: "11#XJ#CD", end: "12#MB#EF", lines: ["  return \\"hi\\";", "}"] }
  Line 13 is "}" which already exists after end. Including it in lines duplicates it.
  CORRECT: { op: "replace_range", pos: "11#XJ#CD", end: "12#MB#EF", lines: ["  return \\"hi\\";"] }

Append after a line (insert between functions):
  { op: "append", pos: "13#QR#GH", lines: ["", "function added() {", "  return true;", "}"] }
  Result: 4 lines inserted after line 13. All existing lines unchanged.

BAD - replacing a closing line only to insert after it:
  { op: "replace_range", pos: "13#QR#GH", end: "13#QR#GH", lines: ["} // end of hello()", "", "function added() {", "}"] }
  This unnecessarily consumes the existing closing line. If that closure is omitted or altered, hello() becomes unbalanced.
  CORRECT: { op: "append", pos: "13#QR#GH", lines: ["", "function added() {", "}"] }

When a structural rewrite really changes both opening and closing syntax:
  Use replace_range covering the complete structure, and include the required replacement closures explicitly. Re-read the edited region or run the narrow syntax/type check immediately afterward.
</examples>

<auto>
Built-in normalization (you do NOT need to handle these):
  BOM and CRLF line endings are preserved automatically.
  Hashline prefixes and diff + markers copied into text are auto-stripped.
  Exact duplicate echoes are dropped and reported as Warning lines: a payload line identical to the append/prepend anchor line, or a range payload longer than its range whose first/last line exactly duplicates a surviving neighbor.
Everything else is applied literally — no merging, splitting, or indentation fixes.
</auto>

Recovery:
- If you get a hash mismatch error, copy the updated anchors shown in that error or re-read the file before retrying.`;
