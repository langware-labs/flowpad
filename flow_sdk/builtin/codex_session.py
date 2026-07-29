"""Codex CLI session entity. Mirrors ``ClaudeSession`` for codex rollouts.

Source: rollout JSONLs under ``<home>/.codex/sessions/`` discovered by the
codex indexer walker. The session id is the thread_id from the session_meta
envelope.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType


class CodexSession(Entity):
    """Codex CLI session entity.

    On-disk parsing lives in ``fs_store/indexer/functions/codex_sessions.py``,
    wired to the indexer via ``TypeInfo`` callable slots for ``codex_session``.
    """

    type: str = APIField(default=RecordType.CODEX_SESSION)
    message_count: int = APIField(default=0, sharing=Sharing.PRIVATE)
    cwd: str | None = APIField(default=None, sharing=Sharing.PRIVATE)
    slug: str | None = APIField(default=None)
    worker_session_id: str | None = APIField(default=None)
    # The rollout JSONL — see ``ClaudeSession.asset_ref`` for why this must be
    # declared rather than inherited from the record.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    received: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)

    LOCAL_ONLY_FIELDS: ClassVar[frozenset[str]] = Entity.LOCAL_ONLY_FIELDS | frozenset({"received"})

    _api_visible: ClassVar[bool] = False
