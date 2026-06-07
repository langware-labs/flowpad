"""Resolve a worker session id to its on-disk JSONL path.

One helper, two glob branches — Claude (``~/.claude/projects/<encoded>/<sid>.jsonl``)
Codex (``~/.codex/sessions/**/rollout-*-<sid>.jsonl``), and Copilot
(``~/.copilot/session-state/<sid>/events.jsonl``). Used by every entry
point that exposes a transcript: the ``/api/v1/workers/<wtype>/<sid>/transcript``
route, ``AgenticProcess.transcript()`` action, and any in-process consumer that
has ``(worker_type, session_id)`` and needs the actual file.

Replaces the old pattern of clients computing paths themselves from
``Project.project_encoded_name`` (which had a bug: encoded paths derived from
the bound project's mount path could diverge from the cwd Claude CLI actually
ran in, producing dead paths). The resolver always finds what's actually on disk.
"""

from __future__ import annotations

from pathlib import Path


def _claude_projects_dir() -> Path:
    return Path.home() / ".claude" / "projects"


def _codex_sessions_dir() -> Path:
    return Path.home() / ".codex" / "sessions"


def _copilot_session_state_dir() -> Path:
    return Path.home() / ".copilot" / "session-state"


class TranscriptNotFoundError(LookupError):
    """Raised when no JSONL exists for ``(worker_type, session_id)``."""


def resolve_session_jsonl(worker_type: str, session_id: str) -> Path:
    """Return the absolute Path to the JSONL file for this session.

    Raises ``TranscriptNotFoundError`` when no match is found, ``ValueError``
    on unsupported worker types.
    """
    wt = worker_type.lower().strip()
    if wt == "claude":
        return _resolve_claude(session_id)
    if wt == "codex":
        return _resolve_codex(session_id)
    if wt == "copilot":
        return _resolve_copilot(session_id)
    raise ValueError(f"Unsupported worker_type: {worker_type!r}")


def _resolve_claude(session_id: str) -> Path:
    projects = _claude_projects_dir()
    if not projects.is_dir():
        raise TranscriptNotFoundError(
            f"~/.claude/projects/ not found; cannot resolve session {session_id}"
        )
    matches = list(projects.glob(f"*/{session_id}.jsonl"))
    if not matches:
        raise TranscriptNotFoundError(
            f"No claude transcript JSONL found for session_id={session_id}"
        )
    if len(matches) > 1:
        # UUIDs are globally unique; multiple matches would imply user-level
        # filesystem corruption. Pick the most-recently-modified to be defensive.
        matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0]


def _resolve_codex(session_id: str) -> Path:
    sessions = _codex_sessions_dir()
    if not sessions.is_dir():
        raise TranscriptNotFoundError(
            f"~/.codex/sessions/ not found; cannot resolve session {session_id}"
        )
    matches = list(sessions.glob(f"**/rollout-*-{session_id}.jsonl"))
    if not matches:
        raise TranscriptNotFoundError(
            f"No codex rollout JSONL found for session_id={session_id}"
        )
    if len(matches) > 1:
        matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0]


def _resolve_copilot(session_id: str) -> Path:
    sessions = _copilot_session_state_dir()
    if not sessions.is_dir():
        raise TranscriptNotFoundError(
            f"~/.copilot/session-state/ not found; cannot resolve session {session_id}"
        )
    path = sessions / session_id / "events.jsonl"
    if not path.exists():
        raise TranscriptNotFoundError(
            f"No copilot events JSONL found for session_id={session_id}"
        )
    return path
