from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import ClassVar, Optional

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
    # The transcript JSONL itself — a session's entire substance is this file, so
    # it is a file-backed asset like any other (see the ``transcripts`` family in
    # ``claude_session_type_info``). MUST be declared: the indexer's FSRecord
    # already carries the path in ``meta_dict()``, but an undeclared field is
    # dropped by pydantic ``extra="ignore"``, which left every row with a null
    # asset_ref and made the type look file-LESS to the bundle packer. That one
    # gap is what forced the transcript to travel as a separately-named raw file
    # and be re-paired by content sniffing on the receiver.
    asset_ref: Optional[str] = APIField(None)
    # True when this session's transcript arrived via a shared message. Such a
    # session NEVER ran on this machine, so it cannot be ``claude --resume``-d
    # locally — the UI hides the resume affordance and offers an
    # analyze-transcript worker instead. Stamped at install through the generic
    # ``TypeInfo.receive_row_overrides`` slot; locally-indexed sessions never set
    # it, so they default ``False``.
    received: bool = APIField(default=False)

    # Local copy state — a received session is local-authoritative and has no hub
    # twin, so a (hypothetical) hub refresh must never clear ``received``.
    LOCAL_ONLY_FIELDS: ClassVar[frozenset[str]] = Entity.LOCAL_ONLY_FIELDS | frozenset({"received"})

    _api_visible: ClassVar[bool] = False

    @classmethod
    async def get_by_id(cls, eid: str) -> "ClaudeSession | None":
        """DB lookup, with on-disk recovery for unindexed LOCAL sessions.

        A session becomes an entity only once the indexer scans it, so a live or
        never-indexed run has no row and the plain lookup misses — leaving the
        lens loader and the Tab project mint unable to resolve a project that is
        sitting right there in the transcript's ``cwd``. Recover it server-side
        so every caller heals uniformly: resolve the transcript → read its cwd →
        stamp ``project_id`` through the SAME primitive the indexer uses, so a
        later real index reconciles cleanly. Transient (never persisted —
        persisting is what indexing does); ``None`` still means "no transcript".

        Safe for foreign sessions BECAUSE ``resolve_session_jsonl`` now searches
        only this machine's CLI dirs. A RECEIVED session is a real installed row
        (with ``received=True`` and its own ``asset_ref``), so it is found by the
        DB lookup above and never reaches recovery. Before the received-store
        fallback was removed, this path could hand back another user's
        transcript and make their live session look resumable.
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
            return None  # no local transcript → genuinely unknown
        except Exception:  # never let recovery turn a miss into a 500
            logger.debug("ClaudeSession recovery: resolve failed for %s", eid, exc_info=True)
            return None

        cwd = cls._read_cwd(path)
        project_id: str | None = None
        if cwd:
            from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd  # noqa: PLC0415

            project_id = resolve_project_id_for_cwd(cwd)
        # Only a locally-run transcript can be recovered, so this is never a
        # received session (those resolve from their DB row above).
        return cls(id=eid, cwd=cwd, project_id=project_id, asset_ref=str(path))

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
