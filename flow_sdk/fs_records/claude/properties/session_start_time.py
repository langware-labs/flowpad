"""SessionStartTimePropertyRecord — first timestamp from a JSONL session file."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar, TYPE_CHECKING

from flow_sdk.fs_store.property_record import PropertyRecord

if TYPE_CHECKING:
    from flow_sdk.fs_store.record import Record


class SessionStartTimePropertyRecord(PropertyRecord):
    """ISO timestamp of the first JSONL entry in this session.

    ttl=-1 means cache forever once computed — the first event timestamp
    of a session never changes.
    """

    _record_type: ClassVar[str] = "prop_session_start_time"
    _default_ttl: ClassVar[float] = -1  # cache forever

    def run_discovery(self, instance: "Record", force: bool = False) -> str | None:
        path = getattr(instance, "jsonl_path", None) or instance.source_file
        if path:
            p = Path(path)
            try:
                with open(p, encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            raw = json.loads(line)
                            ts = raw.get("timestamp")
                            if ts:
                                return str(ts)
                        except json.JSONDecodeError:
                            continue
                # Fallback: use file ctime as ISO string
                return datetime.fromtimestamp(
                    p.stat().st_ctime, tz=timezone.utc
                ).isoformat()
            except OSError:
                pass
        return None
