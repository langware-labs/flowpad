"""Codex CLI session entity. Mirrors ``ClaudeSession`` for codex rollouts.

Source: rollout JSONLs under ``<home>/.codex/sessions/`` discovered by the
codex indexer walker. The session id is the thread_id from the session_meta
envelope.
"""
from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType


class CodexSession(Entity):
    """Codex CLI session entity.

    On-disk parsing lives in ``fs_store/indexer/functions/codex_sessions.py``,
    wired to the indexer via ``TypeInfo`` callable slots for ``codex_session``.
    """

    type: str = APIField(default=RecordType.CODEX_SESSION)
    message_count: int = APIField(default=0)
    cwd: str | None = APIField(default=None)
    slug: str | None = APIField(default=None)
    worker_session_id: str | None = APIField(default=None)

    _api_visible: ClassVar[bool] = False
