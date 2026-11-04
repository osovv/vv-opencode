#!/usr/bin/env python3
"""Build a bounded, read-only view of one OpenCode 2.x session and its subagent tree.

The reflector agent uses this as its mechanical pre-pass: it resolves the target
session, walks the session_v2 parent/child tree, and reports tool-call friction
signals (errors, retries, heavy tool use, test invocations) plus a short message
tail per node. `--archive` switches to a streaming machine-wide aggregate over
many sessions, with filters and JSON/Markdown output.

The current schema stores tool entries in `session_message`; the legacy `part`
table is a subset of those calls (the same callID appears in both). Read both
only by unioning on the call id, with `session_message` winning; never sum the
two tables. The extractor never writes to the database or the repository.

Invocation examples:

    python3 "$HOME/.config/opencode/skills/vvoc/vv-reflect/references/session-graph.py" \
        --project "$PWD" --format json

    python3 "$HOME/.config/opencode/skills/vvoc/vv-reflect/references/session-graph.py" \
        --archive --since 2026-02-01 --out /tmp/opencode/archive
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
from collections import Counter, defaultdict
from datetime import date, datetime, time, timezone
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
        description="Read-only OpenCode 2.x session + subagent tree with friction signals, or a machine-wide archive aggregate."
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--project", type=Path, default=None)
    parser.add_argument("--session", type=str, default=None)
    parser.add_argument("--child", type=str, default=None)
    parser.add_argument("--depth", type=int, default=MAX_DEPTH_DEFAULT)
    parser.add_argument("--max-nodes", type=int, default=MAX_NODES_DEFAULT)
    parser.add_argument("--tail-messages", type=int, default=4)
    parser.add_argument("--message-chars", type=int, default=1200)
    parser.add_argument("--top-tools", type=int, default=6)
    parser.add_argument("--format", choices=("json", "md"), default="json")
    parser.add_argument(
        "--archive",
        action="store_true",
        help="Aggregate tool calls across sessions instead of walking one session tree.",
    )
    parser.add_argument("--since", type=str, default=None, help="Archive lower bound (YYYY-MM-DD).")
    parser.add_argument("--until", type=str, default=None, help="Archive upper bound (YYYY-MM-DD).")
    parser.add_argument("--agent", type=str, default=None, help="Archive filter by session agent.")
    parser.add_argument("--skill", type=str, default=None, help="Archive filter by loaded skill id.")
    parser.add_argument("--top", type=int, default=10, help="Archive top-N rows per section.")
    parser.add_argument("--out", type=Path, default=None, help="Archive output directory.")
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


def parse_date_bound(value: str | None, label: str, end_of_day: bool) -> int | None:
    if value is None:
        return None
    try:
        day = date.fromisoformat(value)
    except ValueError:
        fail(f"{label} must be YYYY-MM-DD, got {value!r}")
    moment = datetime.combine(day, time.max if end_of_day else time.min, tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def tool_name(entry: dict[str, Any]) -> str:
    name = entry.get("name") or entry.get("tool")
    return str(name) if name else "unknown"


def tool_input(entry: dict[str, Any]) -> Any:
    state = entry.get("state")
    if isinstance(state, dict) and state.get("input") is not None:
        return state.get("input")
    return entry.get("input")


def tool_status(entry: dict[str, Any]) -> str:
    state = entry.get("state")
    if isinstance(state, dict) and state.get("status") is not None:
        return str(state.get("status"))
    return str(entry.get("status") or "unknown")


def tool_time(entry: dict[str, Any], fallback: Any) -> int | None:
    state = entry.get("state")
    if isinstance(state, dict):
        timing = state.get("time")
        if isinstance(timing, dict):
            for key in ("completed", "start", "created"):
                value = timing.get(key)
                if isinstance(value, (int, float)):
                    return int(value)
    timing = entry.get("time")
    if isinstance(timing, dict):
        for key in ("completed", "start", "created"):
            value = timing.get(key)
            if isinstance(value, (int, float)):
                return int(value)
    if isinstance(timing, (int, float)):
        return int(timing)
    if isinstance(fallback, (int, float)):
        return int(fallback)
    return None


def tool_error_text(entry: dict[str, Any]) -> str | None:
    if tool_status(entry) != "error":
        return None
    state = entry.get("state")
    candidates: list[Any] = []
    if isinstance(state, dict):
        for key in ("error", "message", "output"):
            candidates.append(state.get(key))
    candidates.append(entry.get("error"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate
        if isinstance(candidate, dict):
            for key in ("message", "name", "type", "value"):
                value = candidate.get(key)
                if isinstance(value, str) and value.strip():
                    return value
    return "unknown error"


def normalize_error(text: str) -> str:
    normalized = re.sub(r"\b[0-9a-f]{8,}\b", "<hex>", text, flags=re.IGNORECASE)
    normalized = re.sub(r"\b\d+(?:\.\d+)?\b", "<n>", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized[:300]


def first_argument_signature(name: str, value: Any) -> str:
    if isinstance(value, dict):
        for key in (
            "command",
            "filePath",
            "file",
            "path",
            "pattern",
            "query",
            "url",
            "id",
            "name",
            "agent",
            "prompt",
        ):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return f"{key}={candidate.strip()[:160]}"
        if value:
            key = sorted(value)[0]
            candidate = value[key]
            return f"{key}={str(candidate)[:160]}"
    if isinstance(value, str):
        return value[:160]
    return ""


def skill_id_for_call(name: str, value: Any) -> str | None:
    if name != "skill" or not isinstance(value, dict):
        return None
    for key in ("id", "name"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def archive_session_rows(
    connection: sqlite3.Connection,
    tables: set[str],
    args: argparse.Namespace,
    since_ms: int | None,
    until_ms: int | None,
) -> dict[str, dict[str, Any]]:
    project_roots: dict[str, str] = {}
    if "project" in tables:
        for row in connection.execute("SELECT id, worktree FROM project"):
            project_roots[str(row["id"])] = normalized_path(row["worktree"]) or ""
    root_filter = normalized_path(args.project) if args.project is not None else None
    if args.project is not None and root_filter is None:
        fail(f"project directory does not exist: {args.project}")

    sessions: dict[str, dict[str, Any]] = {}
    for row in connection.execute(
        """
        SELECT id, project_id, parent_id, directory, title, agent, cost,
               time_created, time_updated
        FROM session_v2
        """
    ):
        created = row["time_created"]
        if since_ms is not None and (not isinstance(created, (int, float)) or created < since_ms):
            continue
        if until_ms is not None and (not isinstance(created, (int, float)) or created > until_ms):
            continue
        if args.agent is not None and str(row["agent"] or "") != args.agent:
            continue
        directory = normalized_path(row["directory"])
        project_root = project_roots.get(str(row["project_id"] or ""), "")
        if root_filter is not None and not (
            is_within(directory, root_filter) or is_within(project_root, root_filter)
        ):
            continue
        sessions[str(row["id"])] = {
            "id": str(row["id"]),
            "project_id": str(row["project_id"] or ""),
            "project": project_root or directory or "unknown",
            "parent_id": row["parent_id"],
            "directory": directory or "",
            "title": str(row["title"] or ""),
            "agent": str(row["agent"] or "unknown"),
            "cost": float(row["cost"] or 0),
            "time_created": int(created) if isinstance(created, (int, float)) else 0,
        }
    return sessions


def archive_calls(
    connection: sqlite3.Connection,
    tables: set[str],
    sessions: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    calls: dict[str, dict[str, Any]] = {}

    if "part" in tables:
        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(part)")
        }
        for row in connection.execute("SELECT * FROM part"):
            data = load_json(row["data"])
            if not isinstance(data, dict) or data.get("type") != "tool":
                continue
            call_id = data.get("callID") or data.get("id")
            session_id = row["session_id"] if "session_id" in columns else data.get("sessionID")
            if not call_id or not session_id or str(session_id) not in sessions:
                continue
            calls[str(call_id)] = {
                "id": str(call_id),
                "session_id": str(session_id),
                "name": tool_name(data),
                "status": tool_status(data),
                "input": tool_input(data),
                "time": tool_time(data, row["time_created"] if "time_created" in columns else None),
                "error": tool_error_text(data),
            }

    for row in connection.execute(
        """
        SELECT session_id, seq, time_created, data
        FROM session_message
        WHERE type = 'assistant'
        ORDER BY seq
        """
    ):
        session_id = str(row["session_id"])
        if session_id not in sessions:
            continue
        data = load_json(row["data"])
        if not isinstance(data, dict):
            continue
        content = data.get("content")
        if not isinstance(content, list):
            continue
        for entry in content:
            if not isinstance(entry, dict) or entry.get("type") != "tool":
                continue
            call_id = entry.get("id")
            if not call_id:
                continue
            calls[str(call_id)] = {
                "id": str(call_id),
                "session_id": session_id,
                "name": tool_name(entry),
                "status": tool_status(entry),
                "input": tool_input(entry),
                "time": tool_time(entry, row["time_created"]),
                "error": tool_error_text(entry),
            }
    return calls


def archive_aggregate(
    connection: sqlite3.Connection,
    tables: set[str],
    args: argparse.Namespace,
) -> dict[str, Any]:
    since_ms = parse_date_bound(args.since, "--since", False)
    until_ms = parse_date_bound(args.until, "--until", True)
    if since_ms is not None and until_ms is not None and since_ms > until_ms:
        fail("--since must not be after --until")

    sessions = archive_session_rows(connection, tables, args, since_ms, until_ms)
    calls = archive_calls(connection, tables, sessions)

    if args.skill is not None:
        matching_sessions = {
            call["session_id"]
            for call in calls.values()
            if skill_id_for_call(call["name"], call["input"]) == args.skill
        }
        sessions = {
            session_id: session
            for session_id, session in sessions.items()
            if session_id in matching_sessions
        }
        calls = {
            call_id: call
            for call_id, call in calls.items()
            if call["session_id"] in sessions
        }

    tool_stats: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"calls": 0, "errors": 0, "sessions": set(), "months": Counter()}
    )
    skills: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"loads": 0, "sessions": set(), "projects": set()}
    )
    agents: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"sessions": set(), "calls": 0, "errors": 0}
    )
    projects: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"calls": 0, "errors": 0, "sessions": set(), "tools": Counter()}
    )
    repeated: dict[tuple[str, str], dict[str, Any]] = defaultdict(
        lambda: {"calls": 0, "errors": 0, "sessions": set()}
    )
    error_counter: Counter[str] = Counter()
    session_stats: dict[str, dict[str, int]] = defaultdict(
        lambda: {"calls": 0, "errors": 0}
    )
    skill_loads = 0
    subagent_calls = 0

    for call in calls.values():
        session = sessions[call["session_id"]]
        name = call["name"]
        status = call["status"]
        is_error = status == "error"
        session_id = call["session_id"]
        when = call["time"] or session["time_created"]
        month = (
            datetime.fromtimestamp(when / 1000, tz=timezone.utc).strftime("%Y-%m")
            if isinstance(when, (int, float)) and when > 0
            else "unknown"
        )
        stats = tool_stats[name]
        stats["calls"] += 1
        stats["errors"] += 1 if is_error else 0
        stats["sessions"].add(session_id)
        stats["months"][month] += 1

        agent = agents[session["agent"]]
        agent["sessions"].add(session_id)
        agent["calls"] += 1
        agent["errors"] += 1 if is_error else 0

        project = projects[session["project"]]
        project["calls"] += 1
        project["errors"] += 1 if is_error else 0
        project["sessions"].add(session_id)
        project["tools"][name] += 1

        session_stat = session_stats[session_id]
        session_stat["calls"] += 1
        session_stat["errors"] += 1 if is_error else 0

        signature = (name, first_argument_signature(name, call["input"]))
        repeat = repeated[signature]
        repeat["calls"] += 1
        repeat["errors"] += 1 if is_error else 0
        repeat["sessions"].add(session_id)

        skill_id = skill_id_for_call(name, call["input"])
        if skill_id is not None:
            skill_loads += 1
            skill = skills[skill_id]
            skill["loads"] += 1
            skill["sessions"].add(session_id)
            skill["projects"].add(session["project"])
        if name in {"subagent", "task"}:
            subagent_calls += 1

        if is_error:
            message = normalize_error(call.get("error") or tool_error_text(call) or "unknown error")
            error_counter[message] += 1

    top = args.top
    if top <= 0:
        fail("--top must be positive")

    serialized_tools = []
    for name, stats in sorted(tool_stats.items(), key=lambda item: (-item[1]["calls"], item[0])):
        serialized_tools.append(
            {
                "name": name,
                "calls": stats["calls"],
                "errors": stats["errors"],
                "rate": round(stats["errors"] / stats["calls"], 4) if stats["calls"] else 0,
                "sessions": len(stats["sessions"]),
                "months": dict(sorted(stats["months"].items())),
            }
        )

    serialized_skills = [
        {
            "id": skill_id,
            "loads": stats["loads"],
            "sessions": len(stats["sessions"]),
            "projects": len(stats["projects"]),
        }
        for skill_id, stats in sorted(skills.items(), key=lambda item: (-item[1]["loads"], item[0]))
    ]

    serialized_agents = [
        {
            "agent": name,
            "sessions": len(stats["sessions"]),
            "calls": stats["calls"],
            "errors": stats["errors"],
        }
        for name, stats in sorted(agents.items(), key=lambda item: (-item[1]["calls"], item[0]))
    ]

    serialized_projects = [
        {
            "project": name,
            "calls": stats["calls"],
            "errors": stats["errors"],
            "sessions": len(stats["sessions"]),
            "top_tools": [
                {"name": tool, "calls": count}
                for tool, count in stats["tools"].most_common(top)
            ],
        }
        for name, stats in sorted(projects.items(), key=lambda item: (-item[1]["calls"], item[0]))
    ]

    serialized_repeated = [
        {
            "tool": name,
            "shape": shape,
            "calls": stats["calls"],
            "errors": stats["errors"],
            "sessions": len(stats["sessions"]),
        }
        for (name, shape), stats in sorted(
            repeated.items(), key=lambda item: (-item[1]["calls"], item[0])
        )
        if stats["calls"] >= 2
    ][:top]

    session_rows = []
    for session_id, stats in session_stats.items():
        session = sessions[session_id]
        session_rows.append(
            {
                "id": session_id,
                "title": session["title"],
                "agent": session["agent"],
                "project": session["project"],
                "calls": stats["calls"],
                "errors": stats["errors"],
                "time_created": timestamp(session["time_created"]),
            }
        )
    by_errors = sorted(session_rows, key=lambda row: (-row["errors"], -row["calls"]))[:top]
    by_calls = sorted(session_rows, key=lambda row: (-row["calls"], -row["errors"]))[:top]

    return {
        "kind": "archive",
        "database": str(args.db.expanduser().resolve()),
        "schema": "session_v2",
        "filters": {
            "since": args.since,
            "until": args.until,
            "project": str(args.project) if args.project is not None else None,
            "agent": args.agent,
            "skill": args.skill,
        },
        "totals": {
            "sessions": len(sessions),
            "calls": len(calls),
            "errors": sum(stats["errors"] for stats in tool_stats.values()),
            "tools": len(tool_stats),
            "skill_loads": skill_loads,
            "subagent_calls": subagent_calls,
        },
        "tools": serialized_tools,
        "skills": serialized_skills,
        "agents": serialized_agents,
        "projects": serialized_projects,
        "repeated_calls": serialized_repeated,
        "top_errors": [
            {"message": message, "count": count}
            for message, count in error_counter.most_common(top)
        ],
        "sessions": {"by_errors": by_errors, "by_calls": by_calls},
    }


def render_archive_md(payload: dict[str, Any]) -> str:
    totals = payload["totals"]
    filters = payload["filters"]
    lines = [
        "# OpenCode archive aggregate",
        "",
        f"- Database: `{payload['database']}` (read-only)",
        f"- Sessions: {totals['sessions']}",
        f"- Tool calls: {totals['calls']}",
        f"- Errors: {totals['errors']}",
        f"- Tools: {totals['tools']}",
        f"- Skill loads: {totals['skill_loads']}",
        f"- Subagent calls: {totals['subagent_calls']}",
        f"- Filters: since={filters['since'] or 'none'}, until={filters['until'] or 'none'}, project={filters['project'] or 'none'}, agent={filters['agent'] or 'none'}, skill={filters['skill'] or 'none'}",
        "",
        "## Tools",
        "",
        "| Tool | Calls | Errors | Rate | Sessions |",
        "|---|---:|---:|---:|---:|",
    ]
    for tool in payload["tools"]:
        lines.append(
            f"| {tool['name']} | {tool['calls']} | {tool['errors']} | {tool['rate']:.2%} | {tool['sessions']} |"
        )

    lines.extend(["", "## Skills", "", "| Skill | Loads | Sessions | Projects |", "|---|---:|---:|---:|"])
    if payload["skills"]:
        for skill in payload["skills"]:
            lines.append(
                f"| {skill['id']} | {skill['loads']} | {skill['sessions']} | {skill['projects']} |"
            )
    else:
        lines.append("| none | 0 | 0 | 0 |")

    lines.extend(["", "## Agents", "", "| Agent | Sessions | Calls | Errors |", "|---|---:|---:|---:|"])
    for agent in payload["agents"]:
        lines.append(
            f"| {agent['agent']} | {agent['sessions']} | {agent['calls']} | {agent['errors']} |"
        )

    lines.extend(["", "## Projects", "", "| Project | Calls | Errors | Sessions |", "|---|---:|---:|---:|"])
    for project in payload["projects"]:
        lines.append(
            f"| {project['project']} | {project['calls']} | {project['errors']} | {project['sessions']} |"
        )

    lines.extend(["", "## Repeated call shapes", "", "| Tool | Shape | Calls | Errors | Sessions |", "|---|---|---:|---:|---:|"])
    if payload["repeated_calls"]:
        for item in payload["repeated_calls"]:
            lines.append(
                f"| {item['tool']} | `{item['shape']}` | {item['calls']} | {item['errors']} | {item['sessions']} |"
            )
    else:
        lines.append("| none | - | 0 | 0 | 0 |")

    lines.extend(["", "## Top errors", ""])
    if payload["top_errors"]:
        for item in payload["top_errors"]:
            lines.append(f"- {item['count']}× {item['message']}")
    else:
        lines.append("- none")

    lines.extend(["", "## Sessions by errors", "", "| Session | Agent | Calls | Errors |", "|---|---|---:|---:|"])
    for session in payload["sessions"]["by_errors"]:
        lines.append(
            f"| {session['id']} {session['title']} | {session['agent']} | {session['calls']} | {session['errors']} |"
        )

    return "\n".join(lines) + "\n"


def write_archive_outputs(payload: dict[str, Any], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "aggregate.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "digest.md").write_text(render_archive_md(payload), encoding="utf-8")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    if args.depth < 0 or args.max_nodes <= 0:
        fail("--depth must be non-negative and --max-nodes must be positive")
    root = project_root(args.project if args.project is not None else Path.cwd())
    connection = connect_readonly(args.db)
    try:
        tables = table_names(connection)
        if "session_v2" not in tables or "session_message" not in tables:
            fail(
                "unsupported OpenCode schema: expected session_v2 and session_message "
                f"(found: {', '.join(sorted(tables)) or 'none'})"
            )
        if args.archive:
            payload = archive_aggregate(connection, tables, args)
            if args.out is not None:
                write_archive_outputs(payload, args.out)
                print(
                    json.dumps(
                        {
                            "sessions": payload["totals"]["sessions"],
                            "calls": payload["totals"]["calls"],
                            "errors": payload["totals"]["errors"],
                            "tools": payload["totals"]["tools"],
                            "skill_loads": payload["totals"]["skill_loads"],
                            "subagent_calls": payload["totals"]["subagent_calls"],
                            "written_to": str(args.out.expanduser().resolve()),
                        },
                        ensure_ascii=False,
                    )
                )
            elif args.format == "md":
                print(render_archive_md(payload), end="")
            else:
                print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))
            return

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
