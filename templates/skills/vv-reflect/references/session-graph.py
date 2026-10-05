#!/usr/bin/env python3
"""Build a bounded, read-only view of one OpenCode 2.x session and its subagent tree.

The reflector agent uses this as its mechanical pre-pass: it resolves the target
session, walks the session_v2 parent/child tree, and reports tool-call friction
signals (errors, retries, heavy tool use, test invocations) plus a short message
tail per node. It reads only the current OpenCode 2.x schema (`session_v2` +
`session_message`) and never writes to the database or the repository.

Invocation example:

    python3 "$HOME/.config/opencode/skills/vvoc/vv-reflect/references/session-graph.py" \
        --project "$PWD" --format json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def default_db_path() -> Path:
    override = os.environ.get("OPENCODE_DATA_HOME")
    if override:
        return Path(override).expanduser() / "opencode.db"
    data_home = os.environ.get("XDG_DATA_HOME")
    base = Path(data_home).expanduser() if data_home else Path.home() / ".local" / "share"
    return base / "opencode" / "opencode.db"


DEFAULT_DB = default_db_path()
MUTATING_TOOLS = {
    "edit",
    "write",
    "patch",
    "apply_patch",
    "hashline_edit",
    "str_replace_editor",
    "str_replace",
    "create",
}
MAX_NODES_DEFAULT = 60
MAX_DEPTH_DEFAULT = 4
HEAVY_TOOL_CALLS = 40
REPEAT_THRESHOLD = 3
TEST_COMMAND_RE = re.compile(
    r"\b(vitest|jest|pytest|bun test|go test|cargo test|npm test|pnpm test|"
    r"yarn test|tsc|typecheck|lint|oxlint|eslint|ruff|biome)\b",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read-only OpenCode 2.x session + subagent tree with friction signals."
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--session", type=str, default=None)
    parser.add_argument("--child", type=str, default=None)
    parser.add_argument("--depth", type=int, default=MAX_DEPTH_DEFAULT)
    parser.add_argument("--max-nodes", type=int, default=MAX_NODES_DEFAULT)
    parser.add_argument("--tail-messages", type=int, default=4)
    parser.add_argument("--message-chars", type=int, default=1200)
    parser.add_argument("--top-tools", type=int, default=6)
    parser.add_argument("--format", choices=("json", "md"), default="json")
    return parser.parse_args()


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def normalized_path(value: Any) -> str | None:
    if not value:
        return None
    try:
        return os.path.realpath(os.path.abspath(os.path.expanduser(os.fspath(value))))
    except (TypeError, ValueError):
        return None


def project_root(project: Path) -> str:
    start = normalized_path(project)
    if start is None or not os.path.isdir(start):
        fail(f"project directory does not exist: {project}")
    try:
        result = subprocess.run(
            ["git", "-C", start, "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return normalized_path(result.stdout.strip()) or start
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return start


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    path = db_path.expanduser().resolve()
    if not path.is_file():
        fail(f"OpenCode database not found: {path}")
    try:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=10)
    except sqlite3.Error as error:
        fail(f"cannot open OpenCode database read-only: {error}")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def table_names(connection: sqlite3.Connection) -> set[str]:
    return {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }


def load_json(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def timestamp(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "unknown"
    if number > 100_000_000_000:
        number /= 1000
    try:
        return datetime.fromtimestamp(number).astimezone().isoformat(timespec="minutes")
    except (OverflowError, OSError, ValueError):
        return "unknown"


def is_within(path: str | None, root: str) -> bool:
    if path is None:
        return False
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def matching_project_ids(
    connection: sqlite3.Connection, tables: set[str], root: str
) -> set[str]:
    project_ids: set[str] = set()
    if "project" in tables:
        for row in connection.execute("SELECT id, worktree FROM project"):
            if normalized_path(row["worktree"]) == root:
                project_ids.add(row["id"])
    if "project_directory" in tables:
        for row in connection.execute(
            "SELECT project_id, directory FROM project_directory"
        ):
            if normalized_path(row["directory"]) == root:
                project_ids.add(row["project_id"])
    return project_ids


def fetch_session(
    connection: sqlite3.Connection, session_id: str
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM session_v2 WHERE id = ?", (session_id,)
    ).fetchone()


def resolve_target(
    connection: sqlite3.Connection,
    project_ids: set[str],
    root: str,
    session_arg: str | None,
    child_arg: str | None,
) -> tuple[sqlite3.Row, str]:
    if session_arg:
        row = fetch_session(connection, session_arg)
        if row is None:
            fail(f"session not found: {session_arg}")
        return row, "explicit-session"

    if child_arg:
        child = fetch_session(connection, child_arg)
        if child is None:
            fail(f"session not found: {child_arg}")
        parent_id = child["parent_id"]
        if not parent_id:
            return child, "child-is-top-level"
        parent = fetch_session(connection, parent_id)
        if parent is None:
            fail(f"parent session not found for child: {child_arg}")
        return parent, "parent-of-child"

    rows = list(connection.execute("SELECT * FROM session_v2"))
    matched = [
        row
        for row in rows
        if row["project_id"] in project_ids
        or is_within(normalized_path(row["directory"]), root)
    ]
    if not matched:
        fail("no sessions found for this project")
    top_level = [row for row in matched if not row["parent_id"]]
    pool = top_level if top_level else matched
    pool.sort(key=lambda row: row["time_updated"] or 0, reverse=True)
    source = "newest-top-level" if top_level else "newest-matched"
    return pool[0], source


def children_of(connection: sqlite3.Connection, parent_id: str) -> list[sqlite3.Row]:
    rows = list(
        connection.execute(
            "SELECT * FROM session_v2 WHERE parent_id = ?", (parent_id,)
        )
    )
    rows.sort(key=lambda row: row["time_created"] or 0)
    return rows


def session_messages(
    connection: sqlite3.Connection, session_id: str
) -> list[sqlite3.Row]:
    return list(
        connection.execute(
            """
            SELECT seq, type, time_created, data
            FROM session_message
            WHERE session_id = ?
            ORDER BY seq
            """,
            (session_id,),
        )
    )


def tool_entries(messages: list[sqlite3.Row]) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for row in messages:
        if row["type"] != "assistant":
            continue
        data = load_json(row["data"])
        if not isinstance(data, dict):
            continue
        content = data.get("content")
        if not isinstance(content, list):
            continue
        for entry in content:
            if isinstance(entry, dict) and entry.get("type") == "tool":
                tools.append(entry)
    return tools


def tool_stats(messages: list[sqlite3.Row], top: int) -> dict[str, Any]:
    per_tool: dict[str, int] = {}
    repeats: dict[tuple[str, str], int] = {}
    errors = 0
    tool_calls = 0
    test_runs = 0
    for entry in tool_entries(messages):
        tool_calls += 1
        name = str(entry.get("name") or "unknown")
        per_tool[name] = per_tool.get(name, 0) + 1
        state = entry.get("state")
        if not isinstance(state, dict):
            state = {}
        if str(state.get("status")) == "error":
            errors += 1
        inp = state.get("input")
        if isinstance(inp, dict):
            command = inp.get("command")
            if name in {"shell", "bash"} and isinstance(command, str):
                if TEST_COMMAND_RE.search(command):
                    test_runs += 1
            signature = hashlib.sha1(
                json.dumps(inp, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
        else:
            signature = hashlib.sha1(str(inp).encode("utf-8")).hexdigest()
        repeats[(name, signature)] = repeats.get((name, signature), 0) + 1
    repeated = [
        {"tool": name, "count": count}
        for (name, _), count in sorted(repeats.items(), key=lambda kv: -kv[1])
        if count >= REPEAT_THRESHOLD
    ][:top]
    top_tools = dict(sorted(per_tool.items(), key=lambda kv: -kv[1])[:top])
    return {
        "tool_calls": tool_calls,
        "errors": errors,
        "per_tool": top_tools,
        "repeated": repeated,
        "test_runs": test_runs,
    }


def collect_files(value: Any, found: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            collect_files(item, found)
        return
    if not isinstance(value, dict):
        return
    for key in ("file", "filePath", "path"):
        item = value.get(key)
        if isinstance(item, str) and item:
            found.append(item)
    for key in ("files", "diffs"):
        if key in value:
            collect_files(value[key], found)


def changed_files(messages: list[sqlite3.Row], row: sqlite3.Row) -> list[str]:
    found: list[str] = []
    for entry in tool_entries(messages):
        name = str(entry.get("name") or "")
        if name not in MUTATING_TOOLS:
            continue
        state = entry.get("state")
        if not isinstance(state, dict):
            continue
        collect_files(state.get("input"), found)
    collect_files(load_json(row["summary_diffs"]), found)
    seen: set[str] = set()
    unique: list[str] = []
    for item in found:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def message_tail(
    connection: sqlite3.Connection,
    session_id: str,
    limit: int,
    chars: int,
) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    rows = list(
        connection.execute(
            """
            SELECT seq, type, time_created, data
            FROM session_message
            WHERE session_id = ? AND type IN ('user', 'assistant')
            ORDER BY seq DESC
            LIMIT ?
            """,
            (session_id, limit),
        )
    )
    rows.reverse()
    tail: list[dict[str, Any]] = []
    for row in rows:
        data = load_json(row["data"])
        if not isinstance(data, dict):
            continue
        if row["type"] == "user":
            text = data.get("text") if isinstance(data.get("text"), str) else ""
            role = "user"
        else:
            content = data.get("content")
            parts = [
                entry.get("text", "")
                for entry in content
                if isinstance(entry, dict) and entry.get("type") == "text"
            ] if isinstance(content, list) else []
            text = "\n".join(part for part in parts if part)
            role = "assistant"
        text = text.strip()
        if not text:
            continue
        tail.append(
            {
                "role": role,
                "time": timestamp(row["time_created"]),
                "text": text[:chars],
                "truncated": len(text) > chars,
            }
        )
    return tail


def build_node(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    depth: int,
    args: argparse.Namespace,
    counter: list[int],
) -> dict[str, Any] | None:
    if counter[0] >= args.max_nodes:
        return None
    counter[0] += 1
    messages = session_messages(connection, row["id"])
    stats = tool_stats(messages, args.top_tools)
    signals = {
        "has_errors": stats["errors"] > 0,
        "heavy_tool_use": stats["tool_calls"] >= HEAVY_TOOL_CALLS,
        "ran_tests": stats["test_runs"] > 0,
        "repeated_calls": len(stats["repeated"]) > 0,
    }
    children = children_of(connection, row["id"])
    node: dict[str, Any] = {
        "id": row["id"],
        "parent_id": row["parent_id"],
        "depth": depth,
        "agent": row["agent"],
        "title": row["title"],
        "directory": row["directory"],
        "time_created": timestamp(row["time_created"]),
        "time_updated": timestamp(row["time_updated"]),
        "duration_minutes": round(
            ((row["time_updated"] or 0) - (row["time_created"] or 0)) / 60000, 1
        ),
        "cost": round(row["cost"] or 0, 4),
        "tokens_input": row["tokens_input"] or 0,
        "tokens_output": row["tokens_output"] or 0,
        "signals": signals,
        "stats": stats,
        "files": changed_files(messages, row)[:20],
        "tail": message_tail(connection, row["id"], args.tail_messages, args.message_chars),
        "children": [],
        "children_truncated": 0,
        "truncated": False,
    }
    if depth >= args.depth:
        node["children_truncated"] = len(children)
    else:
        dropped = 0
        for child in children:
            child_node = build_node(connection, child, depth + 1, args, counter)
            if child_node is None:
                dropped += 1
                continue
            node["children"].append(child_node)
        node["children_truncated"] = dropped
    node["truncated"] = node["children_truncated"] > 0
    return node


def collect(node: dict[str, Any], acc: list[dict[str, Any]]) -> None:
    acc.append(node)
    for child in node["children"]:
        collect(child, acc)


def summarize(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "sessions": len(nodes),
        "subagents": sum(1 for node in nodes if node["parent_id"]),
        "max_depth": max((node["depth"] for node in nodes), default=0),
        "tool_calls": sum(node["stats"]["tool_calls"] for node in nodes),
        "errors": sum(node["stats"]["errors"] for node in nodes),
        "test_runs": sum(node["stats"]["test_runs"] for node in nodes),
        "truncated_nodes": [node["id"] for node in nodes if node["truncated"]],
        "dropped_children": sum(node["children_truncated"] for node in nodes),
        "nodes_with_errors": [node["id"] for node in nodes if node["signals"]["has_errors"]],
        "nodes_with_heavy_tool_use": [
            node["id"] for node in nodes if node["signals"]["heavy_tool_use"]
        ],
        "nodes_with_repeated_calls": [
            node["id"] for node in nodes if node["signals"]["repeated_calls"]
        ],
        "nodes_that_ran_tests": [
            node["id"] for node in nodes if node["signals"]["ran_tests"]
        ],
    }


def render_md(payload: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Session graph")
    lines.append("")
    lines.append(f"- Target: `{payload['target']['id']}` ({payload['target']['source']})")
    lines.append(f"- Database: `{payload['database']}` (read-only)")
    summary = payload["summary"]
    lines.append(
        f"- Sessions: {summary['sessions']} (subagents: {summary['subagents']}), "
        f"tool calls: {summary['tool_calls']}, errors: {summary['errors']}, tests: {summary['test_runs']}"
    )
    if summary["dropped_children"]:
        lines.append(
            f"- Truncated: {summary['dropped_children']} child session(s) not traversed "
            f"(depth/max-nodes bound)"
        )
    lines.append("")

    def walk(node: dict[str, Any], depth: int) -> None:
        pad = "  " * depth
        kind = "subagent" if node["parent_id"] else "session"
        marker = f", truncated +{node['children_truncated']}" if node["children_truncated"] else ""
        lines.append(
            f"{pad}- [{kind}] `{node['id']}` {node['title']} "
            f"(tools={node['stats']['tool_calls']}, errors={node['stats']['errors']}, "
            f"tests={node['stats']['test_runs']}, {node['duration_minutes']}m{marker})"
        )
        for child in node["children"]:
            walk(child, depth + 1)

    walk(payload["tree"], 0)
    return "\n".join(lines) + "\n"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    if args.depth < 0 or args.max_nodes <= 0:
        fail("--depth must be non-negative and --max-nodes must be positive")
    root = project_root(args.project)
    connection = connect_readonly(args.db)
    try:
        tables = table_names(connection)
        if "session_v2" not in tables or "session_message" not in tables:
            fail(
                "unsupported OpenCode schema: expected session_v2 and session_message "
                f"(found: {', '.join(sorted(tables)) or 'none'})"
            )
        project_ids = matching_project_ids(connection, tables, root)
        target, source = resolve_target(
            connection, project_ids, root, args.session, args.child
        )
        counter = [0]
        tree = build_node(connection, target, 0, args, counter)
        if tree is None:
            fail("no nodes collected")
        nodes: list[dict[str, Any]] = []
        collect(tree, nodes)
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "database": str(args.db.expanduser().resolve()),
            "project_root": root,
            "schema": "session_v2",
            "target": {"id": target["id"], "title": target["title"], "source": source},
            "tree": tree,
            "summary": summarize(nodes),
        }
        output = render_md(payload) if args.format == "md" else json.dumps(
            payload, indent=2, ensure_ascii=False
        )
        try:
            print(output)
        except BrokenPipeError:
            try:
                sys.stdout.close()
            finally:
                os._exit(0)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
