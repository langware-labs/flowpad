"""Boot lift: re-derive ``updated_date`` for conversations written before ``UTCDateTime``.

Only conversation recency is repaired: it is re-derivable from its messages' ``sent_at``, which kept
its offset in the row's JSON. Candidates are conversations with a message whose ``sent_at`` carries
a non-zero offset. Runs once: a marker beside the database records it, since ``UTCDateTime`` stops
new rows from going wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage

MARKER = "offset_recency.repaired"


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
            "SELECT DISTINCT substr(parent, 14) FROM ("
            " SELECT json_extract(data, '$.parent_type_id') AS parent, json_extract(data, '$.sent_at') AS sent"
            " FROM entities WHERE type = ?)"
            " WHERE parent LIKE 'conversation-%'"
            " AND sent GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND sent NOT GLOB '*[+-]00:00'",
            (FlowMessage.get_type(),),
        )
        return [rid for (rid,) in rows if rid]
    finally:
        conn.close()


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> Report:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    report = Report(dry_run=dry_run)
    path = Path(db_path or get_instance_settings().db_path)
    marker = path.parent / MARKER
    if marker.exists():
        return report
    for rid in _candidate_ids(str(path)):
        try:
            conv = await Conversation.get_one({"id": rid})
            if conv is None:
                continue
            want = Conversation.recency(await conv.messages_by_edge())
            have = Conversation._as_datetime(conv.updated_date)
            if want is None or have == want:
                continue
            if not dry_run:
                conv.updated_date = want
                await conv.save(None, notify=False)
            report.moved.append(f"{rid[:8]}: {have} -> {want}")
        except Exception as e:  # noqa: BLE001 — one bad row never stops the boot's pass
            report.failed.append(f"{rid[:8]} ({e})")
    if not dry_run and not report.failed:
        marker.touch()
    return report
