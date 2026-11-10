"""An annotation says what it is with ``subkind``; the ``labels`` markers it replaced are read once."""
import pytest

from flow_sdk.builtin.annotation import Annotation
from flow_sdk.builtin.user import User
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp


def test_legacy_labels_are_read_into_the_fields_that_replaced_them():
    assert Annotation(labels=["note:"]).subkind == "note"
    assert Annotation(labels=["note:", "quick-prompt:"]).subkind == "quick_prompt"
    assert Annotation(labels=["x"], subkind="plan").subkind == "plan"
    assert not hasattr(Annotation(), "labels")

    me = User(name="Me", labels=["--user-type--.desktop", "--user--.name-overridden"])
    assert me.desktop and me.name_overridden
    assert not User(name="Them").desktop


@pytest.mark.asyncio
async def test_notes_are_queried_by_subkind():
    target = "task-notes-by-subkind"
    for subkind in ("note", "quick_prompt", "comment"):
        await Annotation(subkind=subkind, target_id=target, content=subkind).save()

    notes = QueryFilter(type="annotation")
    notes.match = ExpressionNode(op=QueryOp.IN, operands=["subkind", ["note", "quick_prompt"]])
    found = [a for a in await Annotation.get_all(notes) if a.target_id == target]
    assert sorted(a.subkind for a in found) == ["note", "quick_prompt"]


@pytest.mark.asyncio
async def test_a_stored_row_that_still_says_labels_loads_with_its_subkind():
    """A row the migration has not reached yet: the stored JSON still carries ``labels``."""
    import json

    from sqlalchemy import text

    from flow_sdk.db import session

    note = await Annotation(subkind="comment", content="legacy").save()
    async with session() as s:
        raw = (await s.execute(text("SELECT data FROM entities WHERE id = :id"), {"id": note.id})).scalar_one()
        data = {**json.loads(raw), "labels": ["note:", "quick-prompt:"]}
        data.pop("subkind")
        await s.execute(text("UPDATE entities SET data = :d WHERE id = :id"), {"d": json.dumps(data), "id": note.id})
        await s.commit()

    assert (await Annotation.get_by_id(note.id)).subkind == "quick_prompt"
