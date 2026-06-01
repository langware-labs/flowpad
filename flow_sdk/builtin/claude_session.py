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

    _api_visible: ClassVar[bool] = False

