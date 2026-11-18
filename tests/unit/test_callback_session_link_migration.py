"""Callback rules get their session back in shared context — on a real sqlite file."""
from __future__ import annotations

import json
import sqlite3

from flow_sdk.migrations import migration_2026_11_callback_session_link as mig

S = "agentic_process-s1"


def _rule(**extra):
    return {"actions": [{"action_type": "prompt_process", "target_type_id": S}], **extra}


def test_rules_keep_their_session_and_only_running_ones_stay_on_it(tmp_path):
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50) NOT NULL, data TEXT)")
    rows = {
        ("live", "trigger"): _rule(private_context_entities_=[S]),
        ("ended", "trigger"): _rule(ended_reason="expired"),
        ("orphan", "trigger"): {"actions": [{"action_type": "prompt_process", "target_type_id": "agentic_process-gone"}]},
        ("s1", "agentic_process"): {"shared_context_entities": ["conversation-c1"],
                                    "private_context_entities_": ["trigger-live", "plan-p1"],
                                    "private_context_entity_data": {"trigger-live": {"context_via": "dynamic"}}},
    }
    conn.executemany("INSERT INTO entities VALUES (?, ?, ?)", [(i, t, json.dumps(d)) for (i, t), d in rows.items()])
    conn.commit()
    conn.close()

    assert sorted(mig.migrate(dry_run=True, db=db).changed) == ["ended", "live", "s1"]
    mig.migrate(dry_run=False, db=db)

    conn = sqlite3.connect(db)
    data = {i: json.loads(d) for i, d in conn.execute("SELECT id, data FROM entities")}
    conn.close()
    assert data["live"]["shared_context_entities"] == [S] and data["live"]["private_context_entities_"] == []
    assert data["ended"]["shared_context_entities"] == [S]
    assert "shared_context_entities" not in data["orphan"]
    assert data["s1"]["shared_context_entities"] == ["conversation-c1", "trigger-live"]
    assert data["s1"]["private_context_entities_"] == ["plan-p1"] and data["s1"]["private_context_entity_data"] == {}
    assert mig.migrate(dry_run=False, db=db).changed == {}
