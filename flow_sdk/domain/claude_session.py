from __future__ import annotations

from typing import Any, ClassVar

from pydantic import PrivateAttr

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
    _record: Any = PrivateAttr(default=None)

    def __init__(self, _record=None, /, **data):
        if _record is not None:
            sid = getattr(_record, "session_id", None)
            if sid and "worker_session_id" not in data:
                data["worker_session_id"] = sid
        super().__init__(**data)
        if _record is not None:
            self._record = _record

    @classmethod
    def fromRecord(cls, rec) -> "ClaudeSession":
        """Create a ClaudeSession domain object from a ClaudeSessionRecord."""
        return cls(rec)

    @property
    def record(self):
        return self._record

    def start(self, prompt: str) -> None:
        """Start the session. Requires a Shell to be attached."""
        raise RuntimeError("ClaudeSession.start() requires a Shell")
