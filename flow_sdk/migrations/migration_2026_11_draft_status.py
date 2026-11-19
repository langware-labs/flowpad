"""Boot lift: a draft message says so in its ``delivery_status``.

"Draft" used to be a flag of its own (``is_draft``) beside the delivery lifecycle; it is now the
lifecycle's first state (``DeliveryStatus.DRAFT``). This pass moves the rows written before that —
those whose stored data still says ``is_draft`` and whose status does not. A draft was never sent
from here, so it also stops counting as this machine's outbound. Cheap on every later boot: the
candidate query matches no row once each one is moved.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"draft status: {'would move' if self.dry_run else 'moved'} {len(self.moved)} draft message(s)"]
        if self.failed:
            out.append("draft status: NOT moved: " + ", ".join(self.failed))
        return out


def _flagged_ids(db_path: str) -> list[str]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    conn = open_sqlite(db_path, mode="ro")
    try:
        return [
            rid
            for (rid,) in conn.execute(
                "SELECT id FROM entities WHERE type = ? AND json_extract(data, '$.is_draft') = 1"
                " AND COALESCE(json_extract(data, '$.delivery_status'), '') != ?",
                (FlowMessage.get_type(), DeliveryStatus.DRAFT.value),
            )
        ]
    finally:
        conn.close()


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> Report:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    report = Report(dry_run=dry_run)
    for rid in _flagged_ids(db_path or str(get_instance_settings().db_path)):
        try:
            fm = await FlowMessage.get_one({"id": rid})
            if fm is None:
                continue
            if not dry_run:
                fm.delivery_status = DeliveryStatus.DRAFT.value
                fm.outbound = False
                await fm.save(None, notify=False)
            report.moved.append(rid[:8])
        except Exception as e:  # noqa: BLE001 — one bad row never stops the boot's pass
            report.failed.append(f"{rid[:8]} ({e})")
    return report
