"""Cross-worker validator: confirms a worker-session record's actual project
matches the project the caller expected.

Used by both Claude (``ClaudeSessionRecord``) and Codex (``CodexSessionRecord``)
session-retrieval paths to surface the "session jsonl exists, but it belongs to
a different project than the one we're asking about" case as a typed result —
instead of silently returning a record from the wrong project, or returning
``None`` and rendering an empty terminal.

Why this isn't an abstract base class: the two worker types share *nothing* in
how they're stored on disk. Claude buckets by encoded project path; Codex
buckets by date. The only shared invariant is "every session record knows its
``cwd``", and that's enough to derive the canonical project_id via
``Project.derive_id_for_path(cwd)`` — pure, sync, side-effect-free.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class ProjectMismatch:
    """A worker-session record was found, but it belongs to a different
    project than the caller expected. Surface as a banner, not as silent
    empty state. ``actual_project_id`` may be ``None`` when the session's
    ``cwd`` no longer maps to any project the local instance knows."""

    expected_project_id: str
    actual_project_id: str | None
    jsonl_path: str | None
    actual_cwd: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def validate_project_id(
    expected_project_id: str | None,
    record: Any,
) -> ProjectMismatch | None:
    """Return a ``ProjectMismatch`` if the session's actual project differs
    from ``expected_project_id``; otherwise ``None``.

    Pure-sync: derives the actual project_id from the record's ``cwd`` via
    ``Project.derive_id_for_path`` (uuid5 over canonical posix path). No DB
    access, no async. Safe to call from inside an executor thread or any
    sync caller (``ClaudeSessionRecord.get`` callers in the AgenticProcess
    record code, the discovery action handler, etc.).

    Returns ``None`` when:
      - ``expected_project_id`` is empty (caller didn't ask for validation)
      - ``record`` is ``None`` (nothing to validate against)
      - The record has no ``cwd`` (can't derive actual)
      - Expected and actual agree
    """
    if not expected_project_id or record is None:
        return None
    # `record.cwd` may be shadowed by an empty string in ``__dict__`` set at
    # construction time — the descriptor's lazy JSONL parse only runs via
    # ``get_prop``. Try the direct attr first (cheap), fall back to get_prop.
    cwd = getattr(record, "cwd", "") or ""
    if not cwd and hasattr(record, "get_prop"):
        try:
            cwd = record.get_prop("cwd") or ""
        except Exception:
            cwd = ""
    if not cwd:
        return None
    from flow_sdk.builtin.project import Project
    actual_project_id = Project.derive_id_for_path(cwd)
    if not actual_project_id or actual_project_id == expected_project_id:
        return None
    return ProjectMismatch(
        expected_project_id=expected_project_id,
        actual_project_id=actual_project_id,
        jsonl_path=getattr(record, "jsonl_path", None),
        actual_cwd=cwd,
    )
