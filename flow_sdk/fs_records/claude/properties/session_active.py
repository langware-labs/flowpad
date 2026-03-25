"""SessionActivePropertyRecord — is this session's JSONL being written to recently?"""

from __future__ import annotations

import time
from pathlib import Path
from typing import ClassVar, TYPE_CHECKING

from flow_sdk.fs_store.property_record import PropertyRecord

if TYPE_CHECKING:
    from flow_sdk.fs_store.record import Record


class SessionActivePropertyRecord(PropertyRecord):
    """Is this session's JSONL currently being written to (mtime within 5 min)?

    ttl=30 means the cached value is valid for 30 seconds. After that,
    get_prop("is_active") automatically re-checks the JSONL mtime so the
    value stays current without requiring explicit discovery(force=True) calls.
    """

    _record_type: ClassVar[str] = "prop_session_active"
    _default_ttl: ClassVar[float] = 30  # auto-refresh every 30s on get_prop()

    MAX_ACTIVE_SECONDS: ClassVar[int] = 300  # 5 minutes of inactivity → inactive

    def run_discovery(self, instance: "Record", force: bool = False) -> bool:
        # Prefer jsonl_path from _data; fall back to source_file
        path = (
            getattr(instance, "jsonl_path", None)
            or instance.source_file
        )
        if path:
            try:
                mtime = Path(path).stat().st_mtime
                return (time.time() - mtime) <= self.MAX_ACTIVE_SECONDS
            except OSError:
                pass
        return False
