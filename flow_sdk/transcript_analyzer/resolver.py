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
    # FLOWPAD_CLAUDE_HOME / CLAUDE_CONFIG_DIR redirects Claude's home (test
    # isolation, isolated app instances). Resolve through instance settings —
    # the same source of truth the transcript watcher and history indexer use —
    # instead of hardcoding ``~/.claude``, or a redirected home's transcripts
    # are invisible to every resolver consumer (agent-trace, /transcript route).
    # Mirrors ``_codex_sessions_dir`` below.
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().claude_projects_dir


def _codex_sessions_dir() -> Path:
    # CODEX_HOME is instance configuration, not necessarily ``~/.codex`` (for
    # example, isolated app/test instances deliberately point it elsewhere).
    # Keep this resolver on the same source of truth as the Codex driver,
    # transcript watcher, and history indexer.
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().codex_sessions_dir


def _copilot_session_state_dir() -> Path:
    return Path.home() / ".copilot" / "session-state"


class TranscriptNotFoundError(LookupError):
    """Raised when no JSONL exists for ``(worker_type, session_id)``."""


def _validate_path_component(value: str, field: str) -> None:
    """Reject identifiers that could escape or broaden a store lookup."""
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > 255
        or value in {".", ".."}
        or value != value.strip()
        or any(char in value for char in ("/", "\\", "*", "?", "[", "]"))
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError(f"Invalid {field}: expected one filename-safe component")


def resolve_session_jsonl(worker_type: str, session_id: str) -> Path:
    """Return the absolute Path to the JSONL file for this session.

    Tries the worker's local CLI dir first; if that misses, falls back to the
    instance's received-transcripts store (a session shared from another
    machine never ran here, so the CLI dir is empty — the transcript rode in
    with the share). Worker-generic across claude/codex/copilot.

    Raises ``TranscriptNotFoundError`` when no match is found, ``ValueError``
    on unsupported worker types or a ``session_id`` that is not one
    filename-safe path component (ids are interpolated into glob patterns
    below, so a raw ``*``/``../`` must be a hard caller error here — unlike
    ``received_transcript_dest``, which treats it as a non-match).
    """
    wt = worker_type.lower().strip()
    _resolvers = {
        "claude": _resolve_claude,
        "codex": _resolve_codex,
        "copilot": _resolve_copilot,
        "workflow": _resolve_workflow,
    }
    resolver = _resolvers.get(wt)
    if resolver is None:
        raise ValueError(f"Unsupported worker_type: {worker_type!r}")
    _validate_path_component(session_id, "session_id")
    try:
        return resolver(session_id)
    except TranscriptNotFoundError:
        # Cross-machine share fallback: the transcript was materialized under
        # the instance's received-transcripts store on unpack. See
        # ``flow_message_bundle._materialize_received_transcripts``.
        received = _received_transcript(wt, session_id)
        if received is not None:
            return received
        raise


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


def _resolve_workflow(run_id: str) -> Path:
    # Workflow run journals live at
    # ``~/.claude/projects/<slug>/<sessionId>/workflows/wf_<runId>.json``.
    projects = _claude_projects_dir()
    if not projects.is_dir():
        raise TranscriptNotFoundError(
            f"~/.claude/projects/ not found; cannot resolve workflow run {run_id}"
        )
    matches = list(projects.glob(f"*/*/workflows/{run_id}.json"))
    if not matches:
        raise TranscriptNotFoundError(
            f"No workflow run journal found for run_id={run_id}"
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


# ---------------------------------------------------------------------------
# Received (shared) transcripts — sessions that arrived via a shared message
# rather than a local CLI run. Worker-uniform store so the by-session-id open
# path works on a machine that never ran the session.
# ---------------------------------------------------------------------------


def _received_transcripts_dir() -> Path | None:
    """``<instance_dir>/received_transcripts`` — instance-local store for
    transcripts that arrived via a shared message. ``None`` when the instance
    dir can't be resolved (e.g. an out-of-server context); callers treat that
    as a miss."""
    try:
        from flow_sdk.instance_settings import get_instance_settings
        return get_instance_settings().instance_dir / "received_transcripts"
    except Exception:
        return None


def received_transcript_dest(worker_type: str, session_id: str) -> Path | None:
    """Canonical path for a received (shared) transcript:
    ``<instance_dir>/received_transcripts/<worker>/<session_id>.jsonl``.

    The layout is worker-uniform — the parser keys off ``worker_type``, not the
    filename, so one shape serves every worker. ``None`` when no safe
    destination or instance dir is available. The single source of truth for
    the path, shared by the unpack writer and the resolver fallback."""
    try:
        _validate_path_component(worker_type, "worker_type")
        _validate_path_component(session_id, "session_id")
    except ValueError:
        # This helper is also used while inspecting arbitrary transcript/share
        # metadata. An unsafe id is a non-match, not a reason to fail the whole
        # parse or bundle import.
        return None
    base = _received_transcripts_dir()
    return None if base is None else base / worker_type / f"{session_id}.jsonl"


def _received_transcript(worker_type: str, session_id: str) -> Path | None:
    dest = received_transcript_dest(worker_type, session_id)
    return dest if (dest is not None and dest.exists()) else None
