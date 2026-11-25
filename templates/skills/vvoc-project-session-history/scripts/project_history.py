#!/usr/bin/env python3
"""Extract a bounded, readable recap source from OpenCode's local SQLite history."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote


DEFAULT_DB = Path("~/.local/share/opencode/opencode.db").expanduser()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract recent OpenCode sessions for the current project as Markdown."
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--sessions", type=int, default=6)
    parser.add_argument("--include-children", action="store_true")
    parser.add_argument("--skip-newest", action="store_true")
    parser.add_argument("--head-user-messages", type=int, default=2)
    parser.add_argument("--tail-messages", type=int, default=7)
    parser.add_argument("--message-chars", type=int, default=1800)
    return parser.parse_args()


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def normalized_path(value: str | os.PathLike[str] | None) -> str | None:
    if not value:
        return None
    return os.path.realpath(os.path.abspath(os.path.expanduser(os.fspath(value))))


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
        root = normalized_path(result.stdout.strip())
        return root or start
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return start


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    path = db_path.expanduser().resolve()
    if not path.is_file():
        fail(f"OpenCode database not found: {path}")
    # Percent-encode the path: SQLite URI parsing treats '?' and '#' as
    # query/fragment delimiters, so raw interpolation breaks odd --db values.
    connection = sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=10)
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
            worktree = normalized_path(row["worktree"])
            if worktree == root:
                project_ids.add(row["id"])
    if "project_directory" in tables:
        for row in connection.execute(
            "SELECT project_id, directory FROM project_directory"
        ):
            directory = normalized_path(row["directory"])
            if directory == root:
                project_ids.add(row["project_id"])
    return project_ids


def select_sessions(
    connection: sqlite3.Connection,
    tables: set[str],
    root: str,
    count: int,
    include_children: bool,
    skip_newest: bool,
) -> list[sqlite3.Row]:
    # OpenCode V2 writes sessions into session_v2; the legacy V1 session table
    # stopped receiving rows around 2026-10-02 and is absent entirely on hosts
    # that started with V2. List columns explicitly: the two tables share the
    # columns below but order them differently, so SELECT * would misalign.
    session_columns = (
        "id, project_id, parent_id, slug, directory, title, time_updated, "
        "summary_files, summary_additions, summary_deletions, summary_diffs"
    )
    sources: list[str] = []
    if "session_v2" in tables:
        sources.append(f"SELECT {session_columns} FROM session_v2")
    if "session" in tables:
        if sources:
            sources.append(
                f"SELECT {session_columns} FROM session "
                "WHERE id NOT IN (SELECT id FROM session_v2)"
            )
        else:
            sources.append(f"SELECT {session_columns} FROM session")
    if not sources:
        fail("database has neither session nor session_v2 table")

    project_ids = matching_project_ids(connection, tables, root)
    rows = list(connection.execute(" UNION ALL ".join(sources)))
    matched = []
    for row in rows:
        directory = normalized_path(row["directory"])
        same_project = row["project_id"] in project_ids
        if not same_project and not is_within(directory, root):
            continue
        if not include_children and row["parent_id"] is not None:
            continue
        matched.append(row)

    matched.sort(key=lambda row: row["time_updated"] or 0, reverse=True)
    if skip_newest and matched:
        matched = matched[1:]
    return matched[:count]


def content_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        texts = [content_text(item) for item in value]
        return "\n".join(text for text in texts if text)
    if not isinstance(value, dict):
        return ""

    item_type = str(value.get("type", "")).lower()
    if item_type in {"text", "input_text", "output_text"} and isinstance(
        value.get("text"), str
    ):
        return value["text"].strip()
    if item_type:
        # Typed non-text parts (reasoning, tool, step-start, ...) must not leak
        # their inner "text"/"content" fields into the recap: only type:text
        # parts carry conversation text.
        return ""
    for key in ("text", "content", "message", "prompt", "output"):
        if key in value:
            text = content_text(value[key])
            if text:
                return text
    return ""


def legacy_messages(
    connection: sqlite3.Connection, tables: set[str], session_id: str
) -> list[dict[str, Any]]:
    if not {"message", "part"}.issubset(tables):
        return []
    rows = connection.execute(
        """
        SELECT
          m.id AS message_id,
          m.time_created AS message_time,
          m.data AS message_data,
          p.time_created AS part_time,
          p.data AS part_data
        FROM message AS m
        LEFT JOIN part AS p ON p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY m.time_created, m.id, p.time_created, p.id
        """,
        (session_id,),
    )

    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        message_data = load_json(row["message_data"])
        role = message_data.get("role")
        if role not in {"user", "assistant"}:
            continue
        entry = grouped.setdefault(
            row["message_id"],
            {"role": role, "time": row["message_time"], "texts": []},
        )
        part_data = load_json(row["part_data"])
        if part_data.get("type") == "text" and isinstance(part_data.get("text"), str):
            text = part_data["text"].strip()
            if text:
                entry["texts"].append(text)

    messages = []
    for entry in grouped.values():
        text = "\n".join(entry.pop("texts"))
        if text:
            entry["text"] = text
            messages.append(entry)
    return messages


def modern_messages(
    connection: sqlite3.Connection, tables: set[str], session_id: str
) -> list[dict[str, Any]]:
    # OpenCode's 2026-11-25 storage migration moved message parts into
    # session_part (keyed by session_message.id, ordered by ordinal) while
    # assistant session_message rows keep content=[]. Preload the text parts
    # for this session once; a message row uses them only when its inline
    # extraction is empty, so transition-era rows cannot duplicate.
    part_texts: dict[str, list[str]] = {}
    if "session_part" in tables:
        for row in connection.execute(
            """
            SELECT message_id, ordinal, data
            FROM session_part
            WHERE session_id = ? AND type = 'text'
            ORDER BY message_id, ordinal
            """,
            (session_id,),
        ):
            text = content_text(load_json(row["data"]))
            if text:
                part_texts.setdefault(row["message_id"], []).append(text)

    messages: list[dict[str, Any]] = []
    if "session_message" in tables:
        for row in connection.execute(
            """
            SELECT id, type, time_created, data
            FROM session_message
            WHERE session_id = ?
            ORDER BY time_created, seq, id
            """,
            (session_id,),
        ):
            data = load_json(row["data"])
            row_type = str(row["type"] or "").lower()
            role = data.get("role")
            if role not in {"user", "assistant"}:
                if row_type in {"user", "assistant"}:
                    role = row_type
                elif row_type.startswith("user-"):
                    role = "user"
                elif row_type.startswith("assistant-"):
                    role = "assistant"
            if role not in {"user", "assistant"}:
                continue
            text = content_text(data)
            if not text:
                text = "\n".join(part_texts.get(row["id"], []))
            if text:
                messages.append(
                    {"role": role, "time": row["time_created"], "text": text}
                )

    if "session_input" in tables:
        for row in connection.execute(
            """
            SELECT time_created, prompt
            FROM session_input
            WHERE session_id = ?
            ORDER BY admitted_seq, id
            """,
            (session_id,),
        ):
            text = content_text(load_json(row["prompt"])) or str(row["prompt"]).strip()
            if text:
                messages.append(
                    {"role": "user", "time": row["time_created"], "text": text}
                )
    return messages


def deduplicate_messages(messages: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    seen: set[tuple[str, str]] = set()
    for message in sorted(messages, key=lambda item: item.get("time") or 0):
        key = (message["role"], " ".join(message["text"].split()))
        if not key[1] or key in seen:
            continue
        seen.add(key)
        result.append(message)
    return result


def choose_messages(
    messages: list[dict[str, Any]], head_users: int, tail_messages: int
) -> tuple[list[dict[str, Any]], int]:
    selected_indexes: set[int] = set()
    user_count = 0
    for index, message in enumerate(messages):
        if message["role"] == "user" and user_count < head_users:
            selected_indexes.add(index)
            user_count += 1
    start = max(0, len(messages) - tail_messages)
    selected_indexes.update(range(start, len(messages)))
    selected = [message for index, message in enumerate(messages) if index in selected_indexes]
    return selected, len(messages) - len(selected)


def todos(
    connection: sqlite3.Connection, tables: set[str], session_id: str
) -> list[sqlite3.Row]:
    if "todo" not in tables:
        return []
    return list(
        connection.execute(
            """
            SELECT content, status, priority, position
            FROM todo
            WHERE session_id = ?
            ORDER BY position
            """,
            (session_id,),
        )
    )


def relative_project_file(value: Any, root: str) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    path = normalized_path(value if os.path.isabs(value) else os.path.join(root, value))
    if path is None or not is_within(path, root):
        return None
    return os.path.relpath(path, root)


def collect_files_from_json(value: Any, root: str, result: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            collect_files_from_json(item, root, result)
        return
    if not isinstance(value, dict):
        return
    for key in ("file", "filePath", "path"):
        file_name = relative_project_file(value.get(key), root)
        if file_name:
            result.append(file_name)
    if isinstance(value.get("files"), list):
        for item in value["files"]:
            if isinstance(item, str):
                file_name = relative_project_file(item, root)
                if file_name:
                    result.append(file_name)
            else:
                collect_files_from_json(item, root, result)
    if "diffs" in value:
        collect_files_from_json(value["diffs"], root, result)


def changed_files(
    connection: sqlite3.Connection,
    tables: set[str],
    session: sqlite3.Row,
    root: str,
) -> list[str]:
    found: list[str] = []
    collect_files_from_json(load_json(session["summary_diffs"]), root, found)

    if "message" in tables:
        for row in connection.execute(
            "SELECT data FROM message WHERE session_id = ?", (session["id"],)
        ):
            data = load_json(row["data"])
            collect_files_from_json(data.get("summary", {}), root, found)

    if "part" in tables:
        for row in connection.execute(
            "SELECT data FROM part WHERE session_id = ?", (session["id"],)
        ):
            data = load_json(row["data"])
            if data.get("type") == "patch":
                collect_files_from_json(data, root, found)

    # Post-migration patch parts live in session_part tool rows: edit and
    # write carry the touched file in state.input.path. Other tools are not
    # recorded patches and contribute nothing.
    if "session_part" in tables:
        for row in connection.execute(
            "SELECT data FROM session_part WHERE session_id = ? AND type = 'tool'",
            (session["id"],),
        ):
            data = load_json(row["data"])
            if str(data.get("name", "")).lower() in {"edit", "write"}:
                state = data.get("state")
                if isinstance(state, dict) and isinstance(state.get("input"), dict):
                    collect_files_from_json(state["input"], root, found)

    unique = []
    seen = set()
    for file_name in found:
        if file_name not in seen:
            seen.add(file_name)
            unique.append(file_name)
    return unique


def truncate(text: str, maximum: int) -> str:
    compact = text.strip()
    if len(compact) <= maximum:
        return compact
    return compact[: maximum - 1].rstrip() + "…"


def render_session(
    connection: sqlite3.Connection,
    tables: set[str],
    session: sqlite3.Row,
    root: str,
    head_users: int,
    tail_messages: int,
    message_chars: int,
) -> None:
    kind = "child" if session["parent_id"] else "top-level"
    print(f"## {session['title'] or session['slug'] or 'untitled session'}")
    print()
    print(f"- Session: `{session['id']}` ({kind})")
    print(f"- Updated: {timestamp(session['time_updated'])}")
    if session["parent_id"]:
        print(f"- Parent: `{session['parent_id']}`")
    summary = (
        session["summary_files"],
        session["summary_additions"],
        session["summary_deletions"],
    )
    if any(isinstance(value, (int, float)) and value for value in summary):
        print(
            "- Recorded diff: "
            f"{summary[0] or 0} files, +{summary[1] or 0}/-{summary[2] or 0}"
        )

    files = changed_files(connection, tables, session, root)
    if files:
        preview = files[:24]
        suffix = f" (+{len(files) - len(preview)} more)" if len(files) > len(preview) else ""
        print(f"- Files mentioned by recorded patches: {', '.join(f'`{item}`' for item in preview)}{suffix}")

    session_todos = todos(connection, tables, session["id"])
    if session_todos:
        print("- Todos recorded at session end (may be stale):")
        for item in session_todos[:15]:
            print(
                f"  - [{item['status']}] ({item['priority']}) "
                f"{truncate(item['content'], 500)}"
            )
        if len(session_todos) > 15:
            print(f"  - … {len(session_todos) - 15} more")

    legacy = legacy_messages(connection, tables, session["id"])
    modern = modern_messages(connection, tables, session["id"])
    messages = deduplicate_messages([*legacy, *modern])
    selected, omitted = choose_messages(messages, head_users, tail_messages)
    if selected:
        print("- Selected conversation evidence:")
        for message in selected:
            label = "USER" if message["role"] == "user" else "ASSISTANT"
            text = truncate(message["text"], message_chars).replace("\n", "\n    ")
            print(f"  - {label} ({timestamp(message['time'])}):\n    {text}")
        if omitted:
            print(f"  - … {omitted} intermediate text messages omitted")
    elif messages:
        print("- Conversation evidence omitted by the requested message limits.")
    else:
        print("- No user/assistant text messages were found in supported schemas.")
    print()


def validate_limits(args: argparse.Namespace) -> None:
    for name in (
        "sessions",
        "head_user_messages",
        "tail_messages",
        "message_chars",
    ):
        if getattr(args, name) < 0:
            fail(f"--{name.replace('_', '-')} must be non-negative")
    if args.sessions == 0:
        fail("--sessions must be greater than zero")
    if args.message_chars < 200:
        fail("--message-chars must be at least 200")


def main() -> None:
    args = parse_args()
    validate_limits(args)
    root = project_root(args.project)
    connection = connect_readonly(args.db)
    try:
        tables = table_names(connection)
        sessions = select_sessions(
            connection,
            tables,
            root,
            args.sessions,
            args.include_children,
            args.skip_newest,
        )
        print("# OpenCode project session history")
        print()
        print(f"- Project root: `{root}`")
        print(f"- Database: `{args.db.expanduser().resolve()}` (read-only)")
        print(
            "- Scope: "
            + ("top-level and child sessions" if args.include_children else "top-level sessions")
        )
        print(f"- Sessions returned: {len(sessions)}")
        print()
        if not sessions:
            print("No matching sessions found.")
            return
        for session in sessions:
            render_session(
                connection,
                tables,
                session,
                root,
                args.head_user_messages,
                args.tail_messages,
                args.message_chars,
            )
    finally:
        connection.close()


if __name__ == "__main__":
    main()
