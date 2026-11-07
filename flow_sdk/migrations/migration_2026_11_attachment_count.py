"""Boot lift: give every Conversation its ``attachment_count``.

``attachment_count`` (the inbox row's paperclip) is projected with ``message_count`` by
``project_pointers_to_entity``, so a conversation counts its files the next time a message
lands. A quiet conversation may never be projected again, so this pass fills the rows that
predate the field — those whose stored data has no ``attachment_count`` key at all.

Each one is counted exactly as the projection counts it (``Conversation.messages_by_edge`` +
``count_listed_files``) and written through the projection's own writer. Cheap on every later
boot: the candidate query matches no row once each one carries the key.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from flow_sdk.builtin.conversation import _PROJECTION_SENTINEL, Conversation


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)  # "<conversation id>: <count>"
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"attachment counts: {'would fill' if self.dry_run else 'filled'} {len(self.moved)} conversation(s)"]
        if self.failed:
            out.append("attachment counts: NOT filled: " + ", ".join(self.failed))
        return out


def _missing_ids(db_path: str) -> list[str]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    conn = open_sqlite(db_path, mode="ro")
    try:
        return [
            rid
            for (rid,) in conn.execute(
                "SELECT id FROM entities WHERE type = ? AND json_type(data, '$.attachment_count') IS NULL",
                (Conversation.get_type(),),
            )
        ]
    finally:
        conn.close()


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> Report:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    report = Report(dry_run=dry_run)
    for rid in _missing_ids(db_path or str(get_instance_settings().db_path)):
        try:
            conv = await Conversation.get_one({"id": rid})
            if conv is None:
                continue
            count = Conversation.count_listed_files(await conv.messages_by_edge())
            if not dry_run:
                conv._set_projection("attachment_count", count, _PROJECTION_SENTINEL)
                await conv.save(None, notify=False)
            report.moved.append(f"{rid[:8]}: {count}")
        except Exception as e:  # noqa: BLE001 — one bad row never stops the boot's pass
            report.failed.append(f"{rid[:8]} ({e})")
    return report
