// FILE: src/lib/session-history.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the shipped vvoc-project-session-history extractor against synthetic OpenCode schemas covering all three storage eras.
//   SCOPE: Post-migration session_part assistant-text extraction with the typed non-text exclusion, pre-migration inline content, the legacy V1 message/part path, edit/write tool-part file collection with other tools excluded, inline-wins precedence for transition-era rows, and percent-encoded read-only database URIs — skipped when python3 is unavailable.
//   DEPENDS: [bun:test, bun:sqlite, node:child_process, node:fs, node:os, node:path, templates/skills/vvoc-project-session-history/scripts/project_history.py]
//   LINKS: [M-CLI-MANAGED-SKILLS, V-M-CLI-MANAGED-SKILLS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SCRIPT_URL - Resolved URL of the shipped project_history.py extractor.
//   SCRIPT_PATH - File path passed to the python3 interpreter.
//   PYTHON - python3 path from Bun.which, or null when unavailable.
//   SESSION_COLUMNS - Column list shared by the synthetic session tables.
//   json - JSON.stringify wrapper for fixture payloads.
//   buildFixture - Creates a temp project with a three-era synthetic database.
//   runExtractor - Runs the shipped extractor with python3 over a fixture.
//   pythonTest - test or test.skip depending on python3 availability.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-PART-EXTRACTOR T-003 - Added the python3-gated synthetic-schema regression test covering post-migration session_part extraction, the typed exclusion, the three coexisting eras, edit/write file collection, and the percent-encoded URI.]
// END_CHANGE_SUMMARY

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const SCRIPT_URL = new URL(
  "../../templates/skills/vvoc-project-session-history/scripts/project_history.py",
  import.meta.url,
);
const SCRIPT_PATH = SCRIPT_URL.pathname;
const PYTHON = Bun.which("python3");

const SESSION_COLUMNS =
  "id, project_id, parent_id, slug, directory, title, time_created, time_updated, " +
  "summary_files, summary_additions, summary_deletions, summary_diffs";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function buildFixture(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "vvoc-session-history-"));
  mkdirSync(join(dir, "proj"));
  const projectDir = realpathSync(join(dir, "proj"));
  // The '?' in the name pins the percent-encoded read-only URI on every run.
  const dbPath = join(dir, "history?mark.db");
  const db = new Database(dbPath);

  db.exec(`CREATE TABLE session_v2 (${SESSION_COLUMNS.replace(/,/g, " text,")} text)`);
  db.exec("CREATE TABLE session (same_schema_placeholder text)");
  db.exec("DROP TABLE session");
  db.exec(`CREATE TABLE session (${SESSION_COLUMNS.replace(/,/g, " text,")} text)`);
  db.exec(
    "CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, " +
      "seq integer, time_created integer, time_updated integer, data text)",
  );
  db.exec(
    "CREATE TABLE session_part (message_id text, session_id text, ordinal integer, " +
      "type text, call_id text, time_created integer, time_updated integer, data text)",
  );
  db.exec(
    "CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, data text)",
  );
  db.exec(
    "CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, " +
      "time_created integer, data text)",
  );

  const base = 1790000000000;

  // Era 3 — post-migration: assistant rows with empty inline content whose
  // parts (reasoning, text, tool) live in session_part.
  db.run(`INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    "S_PARTS",
    "p1",
    null,
    "post-migration",
    projectDir,
    "Post migration session",
    base,
    base + 300,
    null,
    null,
    null,
    null,
  ]);
  db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
    "m1",
    "S_PARTS",
    "user",
    1,
    base + 1,
    base + 1,
    json({ time: { created: base + 1 }, text: "user asks for a recap" }),
  ]);
  db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
    "m2",
    "S_PARTS",
    "assistant",
    2,
    base + 2,
    base + 2,
    json({ time: { created: base + 2 }, content: [] }),
  ]);
  const partRows: Array<[string, number, string, number, string]> = [
    ["m2", 0, "reasoning", base + 2, json({ type: "reasoning", text: "SECRET_REASONING_MARKER" })],
    ["m2", 1, "text", base + 2, json({ type: "text", text: "assistant final answer" })],
    [
      "m2",
      2,
      "tool",
      base + 2,
      json({
        type: "tool",
        name: "edit",
        state: {
          status: "completed",
          input: { oldString: "x", newString: "y", path: join(projectDir, "src", "edited.ts") },
        },
      }),
    ],
    [
      "m2",
      3,
      "tool",
      base + 2,
      json({
        type: "tool",
        name: "read",
        state: { status: "completed", input: { path: join(projectDir, "src", "read-only.ts") } },
      }),
    ],
    [
      "m2",
      4,
      "tool",
      base + 2,
      json({
        type: "tool",
        name: "write",
        state: {
          status: "completed",
          input: { content: "x", path: join(projectDir, "generated.md") },
        },
      }),
    ],
  ];
  for (const [messageId, ordinal, type, time, data] of partRows) {
    db.run("INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)", [
      messageId,
      "S_PARTS",
      ordinal,
      type,
      null,
      time,
      time,
      data,
    ]);
  }

  // Era 2 — pre-migration V2: assistant text inline in session_message content.
  // The transition row m4 keeps BOTH inline content and session_part text;
  // inline must win without duplication.
  db.run(`INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    "S_INLINE",
    "p1",
    null,
    "pre-migration",
    projectDir,
    "Inline era session",
    base,
    base + 200,
    null,
    null,
    null,
    null,
  ]);
  db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
    "m3",
    "S_INLINE",
    "assistant",
    1,
    base + 1,
    base + 1,
    json({
      time: { created: base + 1 },
      content: [
        { type: "reasoning", text: "INLINE_REASONING_MARKER" },
        { type: "text", text: "inline era answer" },
      ],
    }),
  ]);
  db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
    "m4",
    "S_INLINE",
    "assistant",
    2,
    base + 2,
    base + 2,
    json({
      time: { created: base + 2 },
      content: [{ type: "text", text: "transition inline wins" }],
    }),
  ]);
  db.run("INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)", [
    "m4",
    "S_INLINE",
    0,
    "text",
    null,
    base + 2,
    base + 2,
    json({ type: "text", text: "transition part must not surface" }),
  ]);

  // Era 1 — legacy V1: the session exists only in the session table with
  // messages in message+part.
  db.run(`INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    "S_V1",
    "p1",
    null,
    "legacy",
    projectDir,
    "Legacy era session",
    base,
    base + 100,
    null,
    null,
    null,
    null,
  ]);
  db.run("INSERT INTO message VALUES (?,?,?,?)", ["lm1", "S_V1", base + 1, json({ role: "user" })]);
  db.run("INSERT INTO part VALUES (?,?,?,?,?)", [
    "lp1",
    "lm1",
    "S_V1",
    base + 1,
    json({ type: "text", text: "legacy user question" }),
  ]);
  db.run("INSERT INTO message VALUES (?,?,?,?)", [
    "lm2",
    "S_V1",
    base + 2,
    json({ role: "assistant" }),
  ]);
  db.run("INSERT INTO part VALUES (?,?,?,?,?)", [
    "lp2",
    "lm2",
    "S_V1",
    base + 2,
    json({ type: "text", text: "legacy era answer" }),
  ]);

  db.close();
  return { dir, dbPath };
}

function runExtractor(dbPath: string, projectDir: string, extra: string[] = []): string {
  return execFileSync(
    PYTHON as string,
    [SCRIPT_PATH, "--db", dbPath, "--project", projectDir, ...extra],
    { encoding: "utf8" },
  );
}
const pythonTest = test.skipIf(!PYTHON);

pythonTest("extracts assistant text from session_part for post-migration sessions", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const output = runExtractor(dbPath, join(dir, "proj"), ["--sessions", "10"]);

    expect(output).toContain("## Post migration session");
    expect(output).toContain("user asks for a recap");
    expect(output).toContain("ASSISTANT (");
    expect(output).toContain("assistant final answer");
    expect(output).not.toContain("SECRET_REASONING_MARKER");
    expect(output).toContain("Files mentioned by recorded patches: ");
    expect(output).toContain("`src/edited.ts`");
    expect(output).toContain("`generated.md`");
    expect(output).not.toContain("read-only.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("keeps pre-migration inline content and the legacy V1 path unchanged", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const output = runExtractor(dbPath, join(dir, "proj"), ["--sessions", "10"]);

    expect(output).toContain("## Inline era session");
    expect(output).toContain("inline era answer");
    expect(output).not.toContain("INLINE_REASONING_MARKER");
    expect(output).toContain("transition inline wins");
    expect(output).not.toContain("transition part must not surface");

    expect(output).toContain("## Legacy era session");
    expect(output).toContain("legacy user question");
    expect(output).toContain("legacy era answer");

    // All three eras surface exactly one session heading each.
    expect(output.match(/^- Session: `S_/gm)?.length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
