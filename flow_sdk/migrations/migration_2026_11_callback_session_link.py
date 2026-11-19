"""A callback rule and its session hold each other in SHARED context, and an ended rule keeps its session.

Before, the link was private on both sides and removed from both when the rule ended, so an ended
automation could not say which session made it. This pass rebuilds the link from the one place that
kept it — the rule's ``prompt_process`` action:

- every callback rule whose session still exists gets that session in its shared context;
- the session holds the rule in its shared context only while the rule has not ended;
- the old private entries (and their sidecar data) on both sides go.

Idempotent — a second run changes nothing.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_11_callback_session_link
    uv run -m flow_sdk.migrations.migration_2026_11_callback_session_link --apply
"""

from __future__ import annotations

import copy
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

SESSION = "agentic_process-"


@dataclass
class Report:
    changed: dict[str, dict] = field(default_factory=dict)  # row id -> its new data

    def summary(self) -> str:
        return f"callback links: {len(self.changed)} row(s) to rewrite"


def _move(data: dict, typeid: str, *, shared: bool) -> bool:
    """``typeid`` leaves the row's private context and is in its shared context iff ``shared``."""
    before = copy.deepcopy(data)
    held = list(data.get("shared_context_entities") or [])
    if not shared:
        held = [t for t in held if t != typeid]
        (data.get("shared_context_entity_data") or {}).pop(typeid, None)
    elif typeid not in held:
        held.append(typeid)
    data["shared_context_entities"] = held
    data["private_context_entities_"] = [t for t in data.get("private_context_entities_") or [] if t != typeid]
    (data.get("private_context_entity_data") or {}).pop(typeid, None)
    return data != before


def plan(conn) -> Report:
    report = Report()
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").fetchone():
        return report
    rows: dict[str, dict] = {}

    def load(row_id: str, row_type: str) -> dict | None:
        if row_id not in rows:
            found = conn.execute("SELECT data FROM entities WHERE id = ? AND type = ?", (row_id, row_type)).fetchone()
            if found is None:
                return None
            rows[row_id] = json.loads(found[0] or "{}")
        return rows[row_id]

    for rule_id, raw in conn.execute("SELECT id, data FROM entities WHERE type = 'trigger' ORDER BY id").fetchall():
        rule = json.loads(raw or "{}")
        actions = rule.get("actions") or ([rule["action"]] if rule.get("action") else [])
        target = next((str(a.get("target_type_id") or "") for a in actions
                       if a.get("action_type") == "prompt_process" and a.get("target_type_id")), "")
        if not target.startswith(SESSION):
            continue
        session_id = target.removeprefix(SESSION)
        session = load(session_id, "agentic_process")
        if session is None:
            continue
        if _move(rule, target, shared=True):
            report.changed[rule_id] = rule
        if _move(session, f"trigger-{rule_id}", shared=not rule.get("ended_reason")):
            report.changed[session_id] = session
    return report


def migrate(dry_run: bool = True, db: Path | None = None) -> Report:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    conn = open_sqlite(str(db or get_instance_settings().db_path))
    try:
        report = plan(conn)
        if not dry_run and report.changed:
            conn.executemany("UPDATE entities SET data = ? WHERE id = ?",
                             [(json.dumps(data), row_id) for row_id, data in report.changed.items()])
            conn.commit()
        return report
    finally:
        conn.close()


if __name__ == "__main__":
    print(migrate(dry_run="--apply" not in sys.argv).summary())  # noqa: T201 - CLI report
