from flow_sdk._compat import StrEnum
from typing import Any, ClassVar, Dict, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class BookmarkStatus(StrEnum):
    OPEN = "open"
    CLOSED = "closed"
    PENDING = "pending"


class BookmarkType(StrEnum):
    NOTE = "note"
    CONTEXT = "context"
    SUMMARY = "summary"
    NOTIFICATION = "notification"
    NOTIFICATION_FAILED = "notification_failed"
    TERMINAL_ANNOTATION = "terminal_annotation"
    FAVORITE = "favorite"
    PLAN = "plan"


class Bookmark(Entity):
    type: str = APIField(default="bookmark")
    bookmark_type: str = APIField("")
    source: str = APIField("")
    title: str = APIField("")
    content: str = APIField("")
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)
    session_id: str = APIField("")
    work_dir: str = APIField("")
    status: str = APIField(BookmarkStatus.OPEN)
    closed_at: Optional[str] = APIField(None)
    remind_at: Optional[str] = APIField(None)

    @property
    def display_name(self) -> str:
        body = self.content
        if body:
            first_line = str(body).strip().splitlines()[0][:100]
            if first_line:
                return first_line
        if self.title:
            return self.title.strip()
        return self.name or ""
