from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType


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

