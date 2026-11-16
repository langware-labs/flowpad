"""Boot lift: re-derive the recency of conversations whose messages carry a sender's UTC offset.

The SQLite ``DateTime`` columns kept no zone, so an aware ``updated_date`` was written as its
wall clock: mail stamped ``09:25+05:30`` (03:55Z) gave its conversation ``09:25`` read back as
UTC — 5.5h in the future, "just now" in the stream inbox. ``UTCDateTime`` fixes the write; this
pass fixes the rows written before it.

Candidates are conversations holding a message whose ``sent_at`` has a non-zero offset. Each
gets the projection's own rule (``updated_date = max(message.event_time)``) and is saved only
when that differs, so a later boot matches the candidates and writes nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)  # "<conversation id>: <old> -> <new>"
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"offset recency: {'would fix' if self.dry_run else 'fixed'} {len(self.moved)} conversation(s)"]
        if self.failed:
            out.append("offset recency: NOT fixed: " + ", ".join(self.failed))
        return out


def _candidate_ids(db_path: str) -> list[str]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    conn = open_sqlite(db_path, mode="ro")
    try:
        rows = conn.execute(
            "SELECT DISTINCT substr(json_extract(data, '$.parent_type_id'), 14) FROM entities"
            " WHERE type = ? AND json_extract(data, '$.parent_type_id') LIKE 'conversation-%'"
            " AND json_extract(data, '$.sent_at') GLOB '*[+-][0-9][0-9]:[0-9][0-9]'"
            " AND json_extract(data, '$.sent_at') NOT GLOB '*[+-]00:00'",
            (FlowMessage.get_type(),),
        )
        return [rid for (rid,) in rows if rid]
    finally:
        conn.close()


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> Report:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    report = Report(dry_run=dry_run)
    for rid in _candidate_ids(db_path or str(get_instance_settings().db_path)):
        try:
            conv = await Conversation.get_one({"id": rid})
            if conv is None:
                continue
            times = [t for t in (Conversation._as_datetime(m.event_time) for m in await conv.messages_by_edge()) if t]
            want = max(times) if times else None
            have = Conversation._as_datetime(conv.updated_date)
            if want is None or have == want:
                continue
            if not dry_run:
                conv.updated_date = want
                await conv.save(None, notify=False)
            report.moved.append(f"{rid[:8]}: {have} -> {want}")
        except Exception as e:  # noqa: BLE001 — one bad row never stops the boot's pass
            report.failed.append(f"{rid[:8]} ({e})")
    return report
