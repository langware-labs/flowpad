"""A received data source gives back its author's private config.

``data_source.json`` used to hold the whole driver config and the user who owned the source, so a
teammate who received the project adopted the author's account — a Gmail source signed in as the
author's address with this machine's password, and Google refused it. A config field a driver declares
``Sharing.PRIVATE`` no longer reaches the file; this pass clears the ones already adopted.

A row is a received one when its owner is a user other than this machine's. Its private config fields
are emptied, so the source falls back to this machine's own account or owes setup. Rows the local user
or an agent owns are left alone, and so is a driver that is not loaded (it declares nothing private yet).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Report:
    cleared: dict[str, dict] = field(default_factory=dict)  # row id → its data without the private fields
    fields: list[str] = field(default_factory=list)  # "<row id>: <provider>.<field>"

    def summary(self) -> str:
        return f"received data sources: {len(self.fields)} private field(s) on {len(self.cleared)} source(s) to clear"


def plan(conn) -> Report:
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    report = Report()
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").fetchone():
        return report
    local = conn.execute("SELECT id FROM entities WHERE type = 'user' AND uname = 'local'").fetchone()
    if local is None:
        return report
    for row_id, raw in conn.execute("SELECT id, data FROM entities WHERE type = 'data_source' ORDER BY id"):
        try:
            data = json.loads(raw or "{}")
        except ValueError:
            continue
        owner, config, provider = str(data.get("owner") or ""), data.get("config"), str(data.get("provider") or "")
        if not owner.startswith("user-") or owner == f"user-{local[0]}" or not isinstance(config, dict):
            continue
        private = sorted(k for k in DataDriver.private_config_fields(provider) if config.get(k))
        if private:
            data["config"] = {k: v for k, v in config.items() if k not in private}
            report.cleared[row_id] = data
            report.fields += [f"{row_id[:8]}: {provider}.{k}" for k in private]
    return report


def migrate(dry_run: bool = True, db: Path | None = None) -> Report:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    conn = open_sqlite(str(db or get_instance_settings().db_path))
    try:
        report = plan(conn)
        if not dry_run and report.cleared:
            conn.executemany(
                "UPDATE entities SET data = ? WHERE id = ?",
                [(json.dumps(data), row_id) for row_id, data in report.cleared.items()],
            )
            conn.commit()
        return report
    finally:
        conn.close()
