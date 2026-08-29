"""PR1: ``Entity.to_common_json()`` — the single portable-JSON strip seam.

Fast, pure model construction (no DB / no fs). Verifies the base sender-local
set + per-type ``TypeInfo.local_fields`` are stripped, portable fields survive,
and nothing local leaks.
"""
import pytest

import flow_sdk.models.entities  # noqa: F401  (register entity types)

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _task(**kw):
    from flow_sdk.builtin.task import Task

    return Task(**kw)


def test_local_fields_is_base_union_per_type():
    t = _task(title="X")
    lf = t._local_fields()
    # base
    assert {"scope", "project_id", "asset_ref", "origin", "members"} <= lf
    # per-type additions declared on task's TypeInfo
    assert {"my_process_id", "project_root", "project_name"} <= lf


def test_portable_fields_survive():
    t = _task(title="Ship", status="in_progress", parent_type_id="task-abc")
    c = t.to_common_json()
    assert c["title"] == "Ship"
    assert c["status"] == "in_progress"
    assert c["parent_type_id"] == "task-abc"  # THE link that must travel
    assert c["type"] == "task"
    assert c["id"]


def test_sender_local_fields_stripped():
    t = _task(title="Ship")
    t.project_id = "proj-local"
    t.scope = "project"
    t.origin = {"provider": "github"}
    c = t.to_common_json()
    for f in ("project_id", "scope", "asset_ref", "origin", "remote",
              "system", "created_by", "updated_by", "members", "tags",
              "fetched_at", "message_count", "expand"):
        assert f not in c, f"{f} leaked into to_common_json()"


def test_no_local_field_leaks_general():
    """Leak guard: no member of _local_fields() may appear in the dump."""
    t = _task(title="Ship", status="done")
    c = t.to_common_json()
    leaked = sorted(f for f in t._local_fields() if f in c)
    assert leaked == [], f"sender-local fields leaked: {leaked}"
