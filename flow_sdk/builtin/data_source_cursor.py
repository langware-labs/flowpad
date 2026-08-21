"""DataSourceCursor — "since last pull", one row per stream.

**Per stream, never a dict on the DataSource.** Cursors advance on every poll.
A dict field would make every stream's advance a read-modify-write of the same
row (concurrent advances lose each other) and would leave nowhere to record
per-stream health. A row per stream gives failure isolation for free: one feed
returning 500s leaves its siblings advancing normally.

**The state is split, and the split is enforced by a test.** Resumption is
driven entirely by ``state`` — an opaque dict only the driver touches (RSS keeps
``{etag, last_modified}`` there, Hacker News a changed-id pointer). If the sync
loop ever reads a key out of it, the abstraction has leaked and the next
provider will need a special case; ``test_cursor_state_is_opaque`` catches that.
``high_water`` is the operator-facing half: recorded so a human can see how far
a stream got, never read back as a floor.
"""
from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional

from pydantic import model_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.core.entity.legacy_fields import adopt_renamed
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.schema.types import EntityType


class DataSourceCursor(Entity):
    type: str = APIField(default=EntityType.DATA_SOURCE_CURSOR.value)

    data_source_id: str = APIField(default="")
    segment_key: str = APIField(default="", description="Feed URL, channel id — the unit of sync")
    segment_label: str = APIField(default="")
    enabled: bool = APIField(default=True)

    # ── operator-facing — recorded, never read back as sync input ──
    high_water: Optional[str] = APIField(
        default=None, description="Greatest successfully-ingested ordinal (observability)"
    )

    # ── opaque half — ONLY the driver reads or writes this ──
    state: dict = APIField(default_factory=dict)

    last_synced_at: Optional[datetime] = APIField(default=None)
    last_attempted_at: Optional[datetime] = APIField(default=None)

    health: str = APIField(default=SourceHealth.NEVER_SYNCED.value)
    error_code: Optional[str] = APIField(default=None)
    error_detail: Optional[str] = APIField(default=None)
    consecutive_failures: int = APIField(default=0)

    _api_visible: ClassVar[bool] = True

    @model_validator(mode="before")
    @classmethod
    def _adopt_legacy_stream_key(cls, data):
        """Rows written before the segment rename carry ``stream_key``.

        Without this they load with an empty ``segment_key``, so a pre-rename
        cursor reads as a segment that was never polled and the next fetch
        re-walks it from the start. Same shape as
        ``DataSource._adopt_legacy_enabled``.
        """
        return adopt_renamed(
            data, {"stream_key": "segment_key", "stream_label": "segment_label"}
        )

    @classmethod
    async def ensure_for(
        cls, data_source_id: str, segment_key: str, *, segment_label: str = ""
    ) -> "DataSourceCursor":
        """Get-or-create, keyed on ``(data_source_id, segment_key)``.

        Never resets an existing cursor's position — re-declaring a stream finds
        the row that already tracks it, so adding a feed twice cannot lose sync
        state. The identity is the lookup below, not the id: ids are ``uuid4``,
        and a cursor written before that change resolves here exactly the same.
        """
        existing = await cls.get_one({
            "data_source_id": data_source_id,
            "segment_key": segment_key,
        })
        if existing is not None:
            if segment_label and existing.segment_label != segment_label:
                existing.segment_label = segment_label
                await existing.save()
            return existing
        row = cls(
            data_source_id=data_source_id,
            segment_key=segment_key,
            segment_label=segment_label,
        )
        await row.save()
        return row
