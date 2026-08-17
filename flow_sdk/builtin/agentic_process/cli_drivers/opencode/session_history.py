"""OpenCode transcript discovery, store projection, and history replay.

OpenCode 1.18.16 keeps sessions in a SQLite database (``opencode.db``), not in
the per-message JSON tree older documentation describes and not in an
append-only JSONL like claude/codex/copilot. Nothing there is tail-readable, so
**FlowPad owns the canonical JSONL in both modes**:

* headless — the stdout tee written by :class:`OpenCodeCLIStreamWorker`
  (``TranscriptFormat.OPENCODE_STREAM``);
* PTY — a projection assembled from the store
  (``TranscriptFormat.OPENCODE_SESSION``).

The projection is cheap and faithful because ``part.data`` in the database is
the *same shape* as the ``part`` object in the stdout stream, so one parser
serves both formats. The store additionally carries the user's own message,
which the stdout stream never emits (upstream #29997) — so a PTY session
actually replays more completely than a headless one.

Only the ``session`` / ``message`` / ``part`` tables are ever read, always
read-only: the same database also holds provider credentials.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Iterator

from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import (
    entry_to_replay_flow_data,
    load_transcript_history as shared_load_transcript_history,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import TranscriptFormat
from flow_sdk.transcript_analyzer.resolver import sqlite_source_mtime

from .event_to_flowdata import _element_type_for_kind

logger = logging.getLogger(__name__)

DB_FILENAME = "opencode.db"

# part.data["type"] (store) → stream event type. The store uses the hyphenated
# part names; the stdout stream wraps them in an underscored envelope type.
_PART_TYPE_TO_EVENT: dict[str, str] = {
    "step-start": "step_start",
    "step-finish": "step_finish",
    "text": "text",
    "reasoning": "reasoning",
    "tool": "tool_use",
    "file": "file",
    "patch": "patch",
    "snapshot": "snapshot",
    "agent": "agent",
}


def opencode_transcript_path_for_process(process_id: str) -> Path:
    """Process-local JSONL tee path for OpenCode stdout events."""
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    directory = shadow_dir_for("agentic_process", process_id)
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "opencode_transcript.jsonl"


def opencode_session_projection_path(process_id: str | None, session_id: str) -> Path:
    """Where the store projection for one session is materialised.

    Process-scoped when a process owns the session (so it is cleaned up with
    that process); otherwise instance-scoped, for by-session-id lookups such as
    the ``/transcripts`` route.
    """
    safe = "".join(ch for ch in session_id if ch.isalnum() or ch in "-_")
    if process_id:
        from flow_sdk.fs_store.record_paths import shadow_dir_for

        directory = shadow_dir_for("agentic_process", process_id) / "opencode"
    else:
        from flow_sdk.instance_settings import get_instance_settings

        directory = get_instance_settings().records_data_dir / "opencode_sessions"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"session_{safe}.jsonl"


def opencode_data_dir() -> Path:
    """OpenCode's data root — instance-redirectable, never a hardcoded ``~``.

    OpenCode itself resolves this from ``XDG_DATA_HOME`` (it publishes no
    ``OPENCODE_DATA_DIR``; setting that is a no-op, verified on 1.18.16).
    """
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().opencode_data_dir


def opencode_db_path() -> Path:
    return opencode_data_dir() / DB_FILENAME


def _connect_readonly(db_path: Path) -> sqlite3.Connection | None:
    if not db_path.exists():
        return None
    try:
        return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        logger.debug("opencode: cannot open store read-only at %s", db_path, exc_info=True)
        return None


def find_opencode_session(session_id: str) -> str | None:
    """Return the session id iff the store actually has it.

    ``opencode run --session <unknown>`` exits 1 with "Session not found", so
    every resume must be gated on this — the same reason codex gates on
    ``find_codex_session_jsonl``.
    """
    if not session_id:
        return None
    con = _connect_readonly(opencode_db_path())
    if con is None:
        return None
    try:
        row = con.execute("SELECT id FROM session WHERE id = ?", (session_id,)).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        logger.debug("opencode: session probe failed", exc_info=True)
        return None
    finally:
        con.close()


def opencode_session_cwd(session_id: str) -> str | None:
    """The working directory the store recorded for a session, if any.

    Used by the cross-vendor session resolver, which needs a cwd to place a
    resumed session — the other three vendors read it off their session file's
    header; opencode's lives in the ``session.directory`` column.
    """
    if not session_id:
        return None
    con = _connect_readonly(opencode_db_path())
    if con is None:
        return None
    try:
        row = con.execute(
            "SELECT directory FROM session WHERE id = ?", (session_id,)
        ).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        logger.debug("opencode: session-cwd probe failed", exc_info=True)
        return None
    finally:
        con.close()


def find_latest_opencode_session(*, cwd: str | None, since_ms: int | None = None) -> str | None:
    """Newest session recorded for this working directory, if any.

    ``since_ms`` bounds the answer to sessions the store created at or after
    that epoch-ms instant. Callers resolving a session for a specific PROCESS
    must pass it: a directory routinely accumulates sessions across runs, and an
    unbounded answer means a freshly-launched process adopts the previous run's
    conversation and replays somebody else's history into its pane.
    """
    if not cwd:
        return None
    con = _connect_readonly(opencode_db_path())
    if con is None:
        return None
    try:
        if since_ms is None:
            row = con.execute(
                "SELECT id FROM session WHERE directory = ? ORDER BY rowid DESC LIMIT 1",
                (str(cwd),),
            ).fetchone()
        else:
            row = con.execute(
                "SELECT id FROM session WHERE directory = ? AND time_created >= ? "
                "ORDER BY rowid DESC LIMIT 1",
                (str(cwd), int(since_ms)),
            ).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        logger.debug("opencode: latest-session probe failed", exc_info=True)
        return None
    finally:
        con.close()


def external_session_ids() -> set[str]:
    """Every session id the vendor store knows — the ephemeral-hygiene probe."""
    con = _connect_readonly(opencode_db_path())
    if con is None:
        return set()
    try:
        return {row[0] for row in con.execute("SELECT id FROM session")}
    except sqlite3.Error:
        return set()
    finally:
        con.close()


def _iter_store_events(con: sqlite3.Connection, session_id: str) -> Iterator[dict[str, Any]]:
    """Project the store's rows into stdout-stream-shaped events."""
    rows = con.execute(
        """
        SELECT p.data, p.time_created, p.message_id, m.data
        FROM part p
        JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ?
        ORDER BY p.time_created, p.rowid
        """,
        (session_id,),
    )
    seen_user_messages: set[str] = set()
    for part_json, time_created, message_id, message_json in rows:
        try:
            part = json.loads(part_json)
            message = json.loads(message_json)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(part, dict):
            continue
        role = (message or {}).get("role") if isinstance(message, dict) else None
        part.setdefault("messageID", message_id)
        part.setdefault("sessionID", session_id)
        if role == "user":
            # The stdout stream never emits the user's own message (#29997);
            # the store does, so a projected session replays it properly.
            if message_id in seen_user_messages:
                continue
            seen_user_messages.add(message_id)
            yield {
                "type": "flowpad.user_prompt",
                "timestamp": time_created,
                "sessionID": session_id,
                "part": part,
            }
            continue
        event_type = _PART_TYPE_TO_EVENT.get(str(part.get("type") or ""))
        if event_type is None:
            continue
        event = {
            "type": event_type,
            "timestamp": time_created,
            "sessionID": session_id,
            "part": part,
        }
        # The stdout stream names no model anywhere, but the store records it on
        # the assistant message row. Carry it so replayed entries are priced
        # against the model that actually ran rather than the pricing default.
        if isinstance(message, dict):
            model_id = message.get("modelID")
            provider_id = message.get("providerID")
            if model_id:
                event["model"] = f"{provider_id}/{model_id}" if provider_id else str(model_id)
        yield event


def assemble_session_jsonl(session_id: str, process_id: str | None = None) -> Path | None:
    """Materialise the store projection for *session_id*, reusing it when fresh.

    ``tail_status`` runs on every serialize, so the freshness check is a hard
    requirement rather than an optimisation: when the database has not been
    written since the projection was, the existing file is returned untouched.
    """
    if not session_id:
        return None
    db_path = opencode_db_path()
    # WAL-aware: the store's own mtime does not move while a session is being
    # written (autocheckpoint is 1000 pages), so keying freshness on it would
    # pin the projection to the first turn forever — a live PTY turn would
    # never see its own user message land.
    db_mtime = sqlite_source_mtime(db_path)
    if db_mtime is None:
        return None

    out = opencode_session_projection_path(process_id, session_id)
    try:
        if out.exists() and out.stat().st_mtime >= db_mtime:
            return out
    except OSError:
        pass

    con = _connect_readonly(db_path)
    if con is None:
        return None
    try:
        tmp = out.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            wrote = False
            for event in _iter_store_events(con, session_id):
                handle.write(json.dumps(event, separators=(",", ":")) + "\n")
                wrote = True
        if not wrote:
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(out)  # atomic: a concurrent reader never sees a partial file
        return out
    except (OSError, sqlite3.Error):
        logger.debug("opencode: session projection failed for %s", session_id, exc_info=True)
        return None
    finally:
        con.close()


# ---------------------------------------------------------------------------
# History replay
# ---------------------------------------------------------------------------


def load_transcript_history(
    transcript: Path,
    *,
    transcript_format: TranscriptFormat | str | None = None,
) -> list[FlowData]:
    """This vendor's format guess + mapping over the shared replay envelope."""
    return shared_load_transcript_history(
        "opencode",
        transcript,
        _element_type_for_kind,
        transcript_format=transcript_format or _format_for_path(transcript),
        logger=logger,
    )

def load_session_history(session_id: str, process_id: str | None = None) -> list[FlowData]:
    transcript: Path | None = None
    if process_id:
        candidate = opencode_transcript_path_for_process(process_id)
        if candidate.exists():
            transcript = candidate
        elif session_id:
            transcript = assemble_session_jsonl(session_id, process_id)
    if transcript is None or not transcript.exists():
        return []
    return load_transcript_history(transcript)


def _entry_to_replay_flow_data(entry) -> list[FlowData]:
    """This vendor's element-type mapping over the shared replay envelope."""
    return entry_to_replay_flow_data(entry, _element_type_for_kind)

def _format_for_path(path: Path) -> TranscriptFormat:
    if path.name.startswith("session_"):
        return TranscriptFormat.OPENCODE_SESSION
    return TranscriptFormat.OPENCODE_STREAM
