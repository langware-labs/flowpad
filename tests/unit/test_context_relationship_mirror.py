"""An entity's context is mirrored as ``context`` relationship rows at save.

The lists and the process target stay the source of truth; the rows are what lets the
OTHER side list who holds it, and give an entry a time. Every writer reaches the driver's
save, so that is the one place the rows are kept in step.
"""
from __future__ import annotations

import uuid

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.graph_context import GraphContext
from flow_sdk.db.drivers.db_base_record import TypeId
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.db.relationship_model import ContextRelationship
from tests.pytest_plugin import async_context

CONTEXT = QueryFilter.parse({"type": "context"})


def _tid(type_: str) -> TypeId:
    return TypeId(type=type_, id=str(uuid.uuid4()))


async def _out(entity) -> dict[tuple[str, str], ContextRelationship]:
    return {(str(r.to_typeid), r.kind): r for r in await entity.get_outgoing_relationships(CONTEXT)}


@async_context
async def test_lists_and_roles_are_mirrored_and_follow_the_list():
    conv = await Conversation(title="c").save()
    proc, plan = _tid("agentic_process"), _tid("spec")
    conv.add_shared_context_entities(proc, data={"role": "session"})
    conv.add_private_context_entities(plan)
    await conv.save()

    rows = await _out(conv)
    assert set(rows) == {(str(proc), "shared"), (str(plan), "private")}
    assert rows[(str(proc), "shared")].role == "session"
    assert isinstance(rows[(str(proc), "shared")], ContextRelationship)
    born = rows[(str(plan), "private")].created_date

    # A new role re-roles the row; an untouched entry keeps its time; a removed one loses its row.
    conv.add_shared_context_entities(proc, data={"role": "plan"})
    await conv.save()
    conv.remove_shared_context_entities(proc)
    conv.title = "renamed"
    await conv.save()
    rows = await _out(conv)
    assert set(rows) == {(str(plan), "private")}
    assert rows[(str(plan), "private")].created_date == born


@async_context
async def test_a_list_assigned_directly_is_mirrored_too():
    conv = await Conversation(title="c").save()
    a, b = _tid("spec"), _tid("spec")
    conv.shared_context_entities = [a, b]
    await conv.save()
    conv.shared_context_entities = [b]
    await conv.save()
    assert set(await _out(conv)) == {(str(b), "shared")}


@async_context
async def test_the_target_lists_its_session_and_a_non_entity_target_gets_no_row():
    conv = await Conversation(title="c").save()
    proc = await AgenticProcess(name="p", visible=False, target_typeid_str=str(conv.typeid)).save()
    incoming = await conv.get_incoming_relationships(CONTEXT)
    assert [(str(r.from_typeid), r.kind) for r in incoming] == [(str(proc.typeid), "target")]

    keyed = await AgenticProcess(name="k", visible=False, target_typeid_str="claude_session/abc").save()
    assert await _out(keyed) == {}


def test_a_field_of_bare_ids_names_the_type_it_points_at():
    """A task's origin fields hold bare ids; declared with their type, they are context like any other."""
    from flow_sdk.builtin.task import Task
    from flow_sdk.db.drivers.sqlite.context_mirror import context_entries

    conv, message = str(uuid.uuid4()), str(uuid.uuid4())
    entries = context_entries({"origin_conversation": conv, "origin_message": message}, Task.context_fields)
    assert entries == {("conversation", conv, "origin"): "", ("flow_message", message, "origin"): ""}
    assert context_entries({"origin_conversation": "not-an-id"}, Task.context_fields) == {}


@async_context
async def test_detaching_a_child_keeps_the_context_row_and_delete_drops_it():
    conv = await Conversation(title="c").save()
    proc = await AgenticProcess(name="p", visible=False).save()
    await conv.attach_child(proc, notify=False)
    conv.add_shared_context_entities(proc.typeid)
    await conv.save()

    await conv.detach_child(proc)
    assert set(await _out(conv)) == {(str(proc.typeid), "shared")}

    await proc.delete()
    assert await _out(conv) == {}


@async_context
async def test_backfill_writes_only_missing_rows_and_runs_once():
    """Context stored before the mirror existed gets its rows — once, marked as an estimate."""
    from pathlib import Path

    from sqlalchemy import text

    from flow_sdk.db import session
    from flow_sdk.migrations import migration_2026_11_context_relationships as backfill

    conv = await Conversation(title="old").save()
    kept, lost = _tid("spec"), _tid("spec")
    conv.shared_context_entities = [kept, lost]
    await conv.save()
    async with session() as s:  # as if `lost` had been written before the mirror
        await s.execute(text("DELETE FROM relationships WHERE type='context' AND to_id=:id"), {"id": str(lost.id)})
        db = (await s.execute(text("PRAGMA database_list"))).fetchall()[0][2]

    try:
        assert (await backfill.lift(dry_run=True, db_path=db)).moved
        first = await backfill.lift(dry_run=False, db_path=db)
        assert first.moved and not first.failed
        assert (await backfill.lift(dry_run=False, db_path=db)).moved == []  # the marker: no second scan
        # A context field declared later reopens the pass: rows it is missing get written.
        async with session() as s:
            await s.execute(text("DELETE FROM relationships WHERE type='context' AND to_id=:id"), {"id": str(kept.id)})
        (Path(db).parent / backfill.MARKER).write_text("an older set of declarations\n")
        assert (await backfill.lift(dry_run=False, db_path=db)).moved
    finally:
        (Path(db).parent / backfill.MARKER).unlink(missing_ok=True)

    rows = await _out(conv)
    assert {key: row.backfilled for key, row in rows.items()} == {(str(kept), "shared"): True, (str(lost), "shared"): True}
    assert rows[(str(lost), "shared")].created_date is not None


@async_context
async def test_a_frozen_context_lists_its_members():
    conv = await Conversation(title="member").save()
    frozen = await GraphContext(name="frozen", context_typeids=[str(conv.typeid), "not-an-entity"]).save()
    assert set(await _out(frozen)) == {(str(conv.typeid), "member")}
