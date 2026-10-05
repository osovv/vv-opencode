// FILE: src/lib/session-graph.test.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Exercise the bundled vv-reflect session-graph extractor against a synthetic
//     OpenCode 2.x schema (session_v2 + session_message): target resolution (explicit, child,
//     default newest-top-level and newest-matched fallback), subagent-tree recursion, tool
//     friction signals, changed-file semantics, message tails, and the depth/max-nodes
//     truncation markers.
//   SCOPE: Deterministic instruction-contract coverage for the shipped Python extractor; skipped
//     when python3 is unavailable on PATH.
//   DEPENDS: [bun:test, bun:sqlite, node:child_process, node:fs, node:os, node:path, node:url]
//   LINKS: [M-CLI-MANAGED-SKILLS, V-M-CLI-MANAGED-SKILLS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SCRIPT_URL - Resolved URL of the shipped session-graph.py extractor.
//   SCRIPT_PATH - File path passed to the python3 interpreter.
//   PYTHON - python3 path from Bun.which, or null when unavailable.
//   ToolEntry - Shape of a live-schema tool content entry.
//   MessageData - Shape of a synthetic session_message payload.
//   tool - Builds a synthetic tool content entry.
//   insertMessage - Inserts one synthetic session_message row.
//   buildFixture - Creates a temp DB with the 2.x schema and a root/child/older-root tree.
//   runExtractorRaw - Runs the extractor against the fixture and returns raw stdout.
//   runExtractor - Runs the extractor and parses its JSON output.
//   pythonTest - test or test.skip depending on python3 availability.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added default/fallback resolution, changed-file semantics, max-nodes cap, and md truncation coverage.]
// END_CHANGE_SUMMARY

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

const SCRIPT_URL = new URL(
  "../../templates/skills/vv-reflect/references/session-graph.py",
  import.meta.url,
);
const SCRIPT_PATH = SCRIPT_URL.pathname;
const PYTHON = Bun.which("python3");

type ToolEntry = { type: "tool"; name: string; state: { status: string; input: unknown } };
type MessageData = { text?: string; files?: unknown[]; content?: unknown[] };

function tool(name: string, status: string, input: unknown): ToolEntry {
  return { type: "tool", name, state: { status, input } };
}

function insertMessage(
  db: Database,
  sessionId: string,
  seq: number,
  type: "user" | "assistant",
  data: MessageData,
): void {
  db.query(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)",
  ).run(
    `m-${sessionId}-${seq}`,
    sessionId,
    type,
    seq,
    1000 + seq,
    1000 + seq,
    JSON.stringify(data),
  );
}

function buildFixture(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "vvoc-session-graph-"));
  const dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)");
  db.run(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER, time_updated INTEGER, summary_diffs TEXT)",
  );
  db.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  db.run("INSERT INTO project (id, worktree) VALUES ('p1', ?)", [dir]);
  db.run(
    "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, version, agent, cost, tokens_input, tokens_output, time_created, time_updated, summary_diffs) VALUES ('root','p1',NULL,?, 'Root session','2.0.18','vv-controller',0.5,1000,200,1000,600000,NULL)",
    [dir],
  );
  db.run(
    "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, version, agent, cost, tokens_input, tokens_output, time_created, time_updated, summary_diffs) VALUES ('child','p1','root',?, 'Child session','2.0.18','vv-implementer',0.1,300,40,1000,5000,NULL)",
    [dir],
  );
  db.run(
    "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, version, agent, cost, tokens_input, tokens_output, time_created, time_updated, summary_diffs) VALUES ('root-old','p1',NULL,?, 'Older root','1.18.33','vv-controller',0,0,0,100,200,NULL)",
    [dir],
  );
  insertMessage(db, "root", 1, "user", {
    text: "please fix it",
    // Live 2.x user attachments are objects, not bare path strings.
    files: [
      {
        data: "",
        mime: "text/plain",
        source: { type: "file", path: "/tmp/x" },
        name: "a.txt",
        mention: null,
      },
    ],
  });
  insertMessage(db, "root", 2, "assistant", {
    content: [
      tool("shell", "completed", { command: "bun test" }),
      tool("shell", "completed", { command: "bun test" }),
      tool("shell", "completed", { command: "bun test" }),
      tool("read", "error", { filePath: "src/a.ts" }),
      tool("edit", "completed", { filePath: "src/edited.ts" }),
      { type: "text", text: "done" },
    ],
  });
  insertMessage(db, "child", 1, "assistant", {
    content: [
      tool("shell", "error", { command: "vitest run" }),
      { type: "text", text: "child done" },
    ],
  });
  db.close();
  return { dir, dbPath };
}

function runExtractorRaw(dbPath: string, projectDir: string, extra: string[]): string {
  return execFileSync(
    PYTHON as string,
    [SCRIPT_PATH, "--db", dbPath, "--project", projectDir, ...extra],
    { encoding: "utf8" },
  );
}

function runExtractor(
  dbPath: string,
  projectDir: string,
  extra: string[],
): Record<string, unknown> {
  return JSON.parse(runExtractorRaw(dbPath, projectDir, ["--format", "json", ...extra])) as Record<
    string,
    unknown
  >;
}

const pythonTest = test.skipIf(!PYTHON);

pythonTest("extracts the subagent tree and friction signals from the 2.x schema", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const payload = runExtractor(dbPath, dir, ["--session", "root", "--depth", "2"]);
    const target = payload.target as { id: string; source: string };
    const summary = payload.summary as Record<string, unknown>;
    const tree = payload.tree as {
      children: Array<Record<string, unknown>>;
      files: string[];
      tail: Array<{ role: string; text: string }>;
    };
    const rootStats = (payload.tree as { stats: Record<string, unknown> }).stats;

    expect(target.id).toBe("root");
    expect(target.source).toBe("explicit-session");
    expect(tree.children.map((c) => c.id)).toEqual(["child"]);
    expect(rootStats.tool_calls).toBe(5);
    expect(rootStats.errors).toBe(1);
    expect(rootStats.test_runs).toBe(3);
    expect((rootStats.repeated as unknown[]).length).toBeGreaterThan(0);
    expect(summary.subagents).toBe(1);
    expect(summary.errors).toBe(2);
    expect(summary.test_runs).toBe(4);
    expect(summary.dropped_children).toBe(0);
    expect((summary.nodes_with_errors as string[]).sort()).toEqual(["child", "root"]);
    // Only mutating tools count as changed files; reads and user attachments do not.
    expect(tree.files).toContain("src/edited.ts");
    expect(tree.files).not.toContain("src/a.ts");
    expect(tree.tail.some((m) => m.role === "user" && m.text.includes("please fix it"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("resolves the parent from a child id", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const payload = runExtractor(dbPath, dir, ["--child", "child"]);
    expect((payload.target as { id: string }).id).toBe("root");
    expect((payload.target as { source: string }).source).toBe("parent-of-child");
    expect((payload.summary as { sessions: number }).sessions).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("resolves the newest top-level session by default", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const payload = runExtractor(dbPath, dir, []);
    expect((payload.target as { id: string }).id).toBe("root");
    expect((payload.target as { source: string }).source).toBe("newest-top-level");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("labels the fallback as newest-matched when no top-level session exists", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const db = new Database(dbPath);
    db.run("DELETE FROM session_v2 WHERE parent_id IS NULL");
    db.close();
    const payload = runExtractor(dbPath, dir, []);
    expect((payload.target as { id: string }).id).toBe("child");
    expect((payload.target as { source: string }).source).toBe("newest-matched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("marks truncation instead of silently dropping children", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const payload = runExtractor(dbPath, dir, ["--session", "root", "--depth", "0"]);
    const tree = payload.tree as {
      children: unknown[];
      children_truncated: number;
      truncated: boolean;
    };
    const summary = payload.summary as { dropped_children: number; truncated_nodes: string[] };
    expect(tree.children).toEqual([]);
    expect(tree.children_truncated).toBe(1);
    expect(tree.truncated).toBe(true);
    expect(summary.dropped_children).toBe(1);
    expect(summary.truncated_nodes).toContain("root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("bounds the node count with the max-nodes cap", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const payload = runExtractor(dbPath, dir, [
      "--session",
      "root",
      "--depth",
      "2",
      "--max-nodes",
      "1",
    ]);
    const tree = payload.tree as { children: unknown[]; children_truncated: number };
    expect(tree.children).toEqual([]);
    expect(tree.children_truncated).toBe(1);
    expect((payload.summary as { dropped_children: number }).dropped_children).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

pythonTest("renders a truncation marker in md format", () => {
  const { dir, dbPath } = buildFixture();
  try {
    const output = runExtractorRaw(dbPath, dir, [
      "--session",
      "root",
      "--depth",
      "0",
      "--format",
      "md",
    ]);
    expect(output).toContain("Truncated:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
