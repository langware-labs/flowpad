"""Boot lift: re-derive ``updated_date`` for conversations whose stored recency is not their newest
message's send time. Two passes, each once (a marker beside the database records it):

* written before ``UTCDateTime`` — a message's ``sent_at`` carries a non-zero offset, which the row's
  JSON kept; ``UTCDateTime`` stops new rows from going wrong.
* moved by something that was not a message — recency used to read a message's ``updated_date``
  (a read receipt advances it), and an ordinary save of the conversation stamped it "now";
  candidates are every conversation that has a message.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage

MARKER = "offset_recency.repaired"
RECENCY_MARKER = "message_recency.repaired"


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)  # "<conversation id>: <old> -> <new>"
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"conversation recency: {'would fix' if self.dry_run else 'fixed'} {len(self.moved)} conversation(s)"]
        if self.failed:
            out.append("conversation recency: NOT fixed: " + ", ".join(self.failed))
        return out


_OFFSET_SENT = "sent GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND sent NOT GLOB '*[+-]00:00'"
_HAS_MESSAGE = "1 = 1"


def _candidate_ids(db_path: str, where: str = _OFFSET_SENT) -> list[str]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    conn = open_sqlite(db_path, mode="ro")
    try:
        rows = conn.execute(
            "SELECT DISTINCT substr(parent, 14) FROM ("
            " SELECT json_extract(data, '$.parent_type_id') AS parent, json_extract(data, '$.sent_at') AS sent"
            " FROM entities WHERE type = ?)"
            f" WHERE parent LIKE 'conversation-%' AND {where}",
            (FlowMessage.get_type(),),
        )
        return [rid for (rid,) in rows if rid]
    finally:
        conn.close()


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> Report:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    report = Report(dry_run=dry_run)
    path = Path(db_path or get_instance_settings().db_path)
    for marker_name, where in ((MARKER, _OFFSET_SENT), (RECENCY_MARKER, _HAS_MESSAGE)):
        await _rederive(path, path.parent / marker_name, where, report)
    return report


async def _rederive(path: Path, marker: Path, where: str, report: Report) -> None:
    dry_run, failed_before = report.dry_run, len(report.failed)
    if marker.exists():
        return
    for rid in _candidate_ids(str(path), where):
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
    if not dry_run and len(report.failed) == failed_before:
        marker.touch()
