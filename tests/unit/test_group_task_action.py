"""Group-task unit coverage: member-folder dedup, member-list normalization,
and the kind/parent_id/assignee/submission_url frontmatter round-trip."""

from __future__ import annotations

import pytest

from flow_sdk.app.actions.group_task_action import (
    _group_members,
    _member_asset_ref,
    _safe_task_folder_name,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.task import extract_task
from flow_sdk.schema.type_info import register_all


@pytest.fixture(scope="module", autouse=True)
def _registered():
    register_all()


def _task_md_body_from(entity) -> str:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    return SchemaRegistry.get("task").default_body_fn(entity)


# ── member folder dedup ─────────────────────────────────────────────────────


def test_safe_task_folder_name_slugs_like_fs_record():
    assert _safe_task_folder_name("Ship It!") == "ship_it_"
    assert _safe_task_folder_name("  ") == "untitled"
    assert _safe_task_folder_name(None) == "untitled"


def test_member_asset_ref_is_deduped_sibling_of_parent():
    ref = _member_asset_ref("/scope/tasks/ship_it/", "Ship It", "abcdef12-3456-7890-aaaa-bbbbccccdddd")
    assert ref == "/scope/tasks/ship_it--m-abcdef12"
    # A second member gets a distinct folder (dedup by child id prefix).
    ref2 = _member_asset_ref("/scope/tasks/ship_it/", "Ship It", "ffffffff-0000-0000-0000-000000000000")
    assert ref2 != ref


def test_member_asset_ref_requires_parent_ref_and_id():
    assert _member_asset_ref(None, "T", "abc") is None
    assert _member_asset_ref("/scope/tasks/t/", "T", None) is None


# ── member list normalization ───────────────────────────────────────────────


def _group(contacts):
    from flow_sdk.builtin.contacts_group import ContactsGroup

    return ContactsGroup.model_validate({"name": "g", "contacts": contacts})


def test_group_members_dedupes_normalizes_and_drops_owner():
    members, failed = _group_members(
        _group(
            [
                {"email": "Alice@X.com"},
                {"email": "alice@x.com"},  # dupe after normalize
                {"email": "owner@x.com"},  # the owner — dropped
                {"email": "bob@x.com", "name": "Bob"},
            ]
        ),
        owner_email="owner@x.com",
    )
    assert members == ["alice@x.com", "bob@x.com"]
    assert failed == []


def test_group_members_reports_email_less_entries():
    members, failed = _group_members(_group([{"name": "No Email"}, {"email": "a@x.com"}]), None)
    assert members == ["a@x.com"]
    assert len(failed) == 1 and "No Email" in failed[0]["error"]


# ── group resolution (stored group_id vs computed explicit members) ────────


@pytest.mark.asyncio
async def test_resolve_group_builds_transient_group_from_members():
    from flow_sdk.app.actions.group_task_action import _resolve_group

    group = await _resolve_group(
        {
            "members": [
                {"email": "Alice@X.com", "name": "Alice"},
                "not-a-dict",  # ignored
                {"email": "bob@x.com"},
            ],
        }
    )
    assert [c.get("email") for c in group.contacts] == ["Alice@X.com", "bob@x.com"]
    # The transient group feeds _group_members exactly like a stored one.
    members, failed = _group_members(group, owner_email="alice@x.com")
    assert members == ["bob@x.com"]
    assert failed == []


@pytest.mark.asyncio
async def test_resolve_group_requires_group_id_or_members():
    from fastapi import HTTPException

    from flow_sdk.app.actions.group_task_action import _resolve_group

    with pytest.raises(HTTPException) as exc:
        await _resolve_group({})
    assert exc.value.status_code == 400
    assert "'group_id' or 'members'" in exc.value.detail


# ── frontmatter round-trip of the new fields ────────────────────────────────


def test_group_fields_round_trip_task_md(tmp_path):
    from flow_sdk.builtin.task import Task, TaskKind

    child = Task(
        title="Ship It",
        parent_id="11111111-2222-4333-8444-555566667777",
        assignee="bob@x.com",
        submission_url="https://github.com/x/y/pull/1",
        kind=TaskKind.STANDARD,
    )
    folder = tmp_path / "tasks" / "ship_it--m-deadbeef"
    folder.mkdir(parents=True)
    (folder / "task.md").write_text(_task_md_body_from(child), encoding="utf-8")

    rec = extract_task(FSRef(folder))[0]
    assert rec.parent_id == "11111111-2222-4333-8444-555566667777"
    assert rec.assignee == "bob@x.com"
    assert rec.submission_url == "https://github.com/x/y/pull/1"
    assert rec.kind == "standard"


def test_group_kind_round_trips(tmp_path):
    from flow_sdk.builtin.task import Task, TaskKind

    parent = Task(title="Overview", kind=TaskKind.GROUP)
    folder = tmp_path / "tasks" / "overview"
    folder.mkdir(parents=True)
    (folder / "task.md").write_text(_task_md_body_from(parent), encoding="utf-8")

    rec = extract_task(FSRef(folder))[0]
    assert rec.kind == "group"
    # Empty parent_id is dropped from frontmatter (not a leak, just clean yaml).
    assert "parent_id" not in (folder / "task.md").read_text(encoding="utf-8")


# ── bundle packing of loose attachments ─────────────────────────────────────
