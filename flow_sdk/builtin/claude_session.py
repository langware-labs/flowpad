from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)


class ClaudeSession(Entity):
    """Claude CLI session entity.

    Auto-registered via Entity.__init_subclass__ so Entity.from_record()
    uses this class when indexing claude_session records.
    """

    type: str = APIField(default=RecordType.CLAUDE_SESSION)
    message_count: int = APIField(default=0)
    cwd: str | None = APIField(default=None)
    slug: str | None = APIField(default=None)
    worker_session_id: str | None = APIField(default=None)
    # True when this session's transcript arrived via a shared message and was
    # materialized under ``<instance>/received_transcripts/<worker>/<id>.jsonl``.
    # Such a session NEVER ran on this machine (its id is not under
    # ``~/.claude/projects/``), so it cannot be ``claude --resume``-d locally —
    # the UI hides the resume affordance and offers an analyze-transcript worker
    # instead. Locally-created sessions are indexed from their on-disk JSONL and
    # never set this, so they default ``False``.
    received: bool = APIField(default=False)

    # Local copy state — a received session is local-authoritative and has no hub
    # twin, so a (hypothetical) hub refresh must never clear ``received``.
    LOCAL_ONLY_FIELDS: ClassVar[frozenset[str]] = Entity.LOCAL_ONLY_FIELDS | frozenset({"received"})

    _api_visible: ClassVar[bool] = False

    @classmethod
    async def get_by_id(cls, eid: str) -> "ClaudeSession | None":
        """DB lookup, with on-disk recovery for unindexed sessions.

        A session is a ``claude_session`` ENTITY only after the indexer scans it
        (click-triggered) — so the live session, or any never-indexed transcript,
        has no DB row and the plain lookup returns ``None``. Consumers that only
        need the owning project (the lens loader's project heal, the Tab project
        mint) then can't resolve it, even though the transcript is sitting on
        disk under ``~/.claude/projects/<cwd-encoded>/<id>.jsonl`` and its cwd
        maps to a project. Recover that here, server-side, so every caller of
        ``get_by_id`` heals uniformly: resolve the transcript → read its cwd →
        stamp ``project_id`` via the SAME primitive the indexer uses
        (``resolve_project_id_for_cwd``), so a later real index reconciles
        cleanly. The recovered entity is transient (NOT persisted — persisting is
        what indexing does); ``None`` still means "no transcript anywhere".
        """
        found = await super().get_by_id(eid)
        if found is not None:
            return found
        return cls._recover_from_disk(eid)

    @classmethod
    def _recover_from_disk(cls, eid: str) -> "ClaudeSession | None":
        from flow_sdk.transcript_analyzer.resolver import (  # noqa: PLC0415
            TranscriptNotFoundError,
            resolve_session_jsonl,
        )

        try:
            path = resolve_session_jsonl("claude", eid)
        except (TranscriptNotFoundError, ValueError):
            return None  # no transcript on disk → genuinely unknown
        except Exception:  # never let recovery turn a miss into a 500
            logger.debug("ClaudeSession recovery: resolve failed for %s", eid, exc_info=True)
            return None

        cwd = cls._read_cwd(path)
        project_id: str | None = None
        if cwd:
            from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd  # noqa: PLC0415

            project_id = resolve_project_id_for_cwd(cwd)
        # A received transcript lives under the instance store, never under
        # ``~/.claude/projects`` — it never ran on this machine.
        received = "received_transcripts" in path.parts
        return cls(id=eid, cwd=cwd, project_id=project_id, received=received)

    @staticmethod
    def _read_cwd(path: Path) -> str | None:
        """First ``cwd`` in a session JSONL (cwd appears near the top). Mirrors
        ``_real_path_from_jsonl`` but for one known file instead of a dir glob."""
        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i >= 50:
                        break
                    if '"cwd"' not in line:
                        continue
                    try:
                        cwd = json.loads(line).get("cwd")
                    except (json.JSONDecodeError, ValueError):
                        continue
                    if isinstance(cwd, str) and cwd:
                        return cwd
        except OSError:
            pass
        return None

