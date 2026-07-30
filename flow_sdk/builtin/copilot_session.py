"""Copilot CLI session entity. Mirrors ``CodexSession`` for copilot sessions.

Source: ``~/.copilot/session-state/<session_id>/events.jsonl`` discovered by the
copilot indexer walker. The session id is the session-state directory name.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType


class CopilotSession(Entity):
    """Copilot CLI session entity.

    On-disk parsing lives in ``fs_store/indexer/functions/copilot_sessions.py``,
    wired to the indexer via ``TypeInfo`` callable slots for ``copilot_session``.
    """

    type: str = APIField(default=RecordType.COPILOT_SESSION)
    message_count: int = APIField(default=0, sharing=Sharing.PRIVATE)
    cwd: str | None = APIField(default=None, sharing=Sharing.PRIVATE)
    slug: str | None = APIField(default=None)
    worker_session_id: str | None = APIField(default=None)
    # The events JSONL — see ``ClaudeSession.asset_ref`` for why this must be
    # declared rather than inherited from the record.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    received: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)


    _api_visible: ClassVar[bool] = False
