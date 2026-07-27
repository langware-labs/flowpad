"""The name/title contract across the hub boundary.

Every entity carries BOTH display slots (``name`` and ``title``), both optional,
on the local side AND on the hub. Each type authors exactly one of them — a
project's label is ``name``, a task's is ``title`` — and neither side renames one
into the other in transit.

Why the two slots must both exist rather than one-per-type: a payload key that
isn't a declared field is dropped SILENTLY. Locally pydantic's ``extra="ignore"``
eats it; on the hub the CRUD handlers skip anything failing ``is_api_field`` with
only a log line. So a label arriving under the "other" key didn't raise, it just
became ``None`` — surfacing later as a nameless invitation row with no trace back
to the crossing point.

Contract under test:

  * base ``Entity`` declares both slots, both optional, both API fields, and
    every builtin type inherits them.
  * ``Project`` authors ``name``: ``_hub_body`` sends it verbatim with no
    ``name``→``title`` rename (the seam a project RENAME fell through — the
    reflected update PUT sends the raw request body, not ``_hub_body``).
  * ``materialize_remote_membership_entity`` mirrors whichever slot the hub
    filled, with no title→name coercion.
  * ``_merge_hub_entity_into_local`` merges both slots back from a hub echo —
    the return leg of the same rename.
"""

from uuid import uuid4

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.builtin.task import Task
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.schema.type_info import register_all

register_all()


# ── the base contract ────────────────────────────────────────────────────────


def test_base_entity_declares_both_display_slots_optional():
    """Both slots live on ``Entity`` itself and default to None."""
    for slot in ("name", "title"):
        assert slot in Entity.model_fields, f"Entity must declare {slot!r}"
        assert Entity.model_fields[slot].default is None, f"{slot!r} must be optional"
        assert Entity.is_api_field(slot), f"{slot!r} must be API-visible or the hub echo can't merge it"


def test_every_entity_type_carries_both_slots():
    """Inheritance, not per-type declaration, is what makes the slots universal."""
    from flow_sdk.core.entity.entity_model import Entity as _E

    subclasses = []
    stack = [_E]
    while stack:
        cls = stack.pop()
        for sub in cls.__subclasses__():
            subclasses.append(sub)
            stack.append(sub)

    assert subclasses, "expected builtin Entity subclasses to be registered"
    for sub in subclasses:
        assert "name" in sub.model_fields, f"{sub.__name__} lost the name slot"
        assert "title" in sub.model_fields, f"{sub.__name__} lost the title slot"


def test_a_title_only_type_still_has_a_name_slot():
    """A task authors ``title``; ``name`` exists and is simply unset."""
    task = Task(title="ship it")
    assert task.title == "ship it"
    assert task.name is None


# ── project authors ``name`` on both sides ───────────────────────────────────


def test_project_hub_body_sends_name_verbatim():
    """No name→title rename: the hub Project's label field is ``name`` too."""
    p = Project(name="demo", fs_storage_mount_path="/tmp/demo_name_title")
    body = p._hub_body()
    assert body["name"] == "demo"
    assert "title" not in body, "a project leaves ``title`` unset; exclude_none drops it"


def test_project_rename_reaches_the_hub_through_the_reflected_update():
    """Regression: renaming a SHARED project used to die at the hub.

    The reflected update (``_hub_reflect.reflect_to_hub``) PUTs the raw request
    body — it never calls ``_hub_body``, so the old name→title mapping did not
    apply and the hub dropped ``name`` as an unknown field. The rename stuck
    locally and silently never propagated. The body key must be one the hub
    declares.
    """
    from flow_sdk.builtin.project import Project as LocalProject

    rename_body = {"name": "renamed in the UI"}
    for key in rename_body:
        assert LocalProject.is_api_field(key), f"{key!r} must be a field the hub also declares"


def test_merge_hub_entity_into_local_applies_both_slots():
    """The return leg: a hub echo of either slot merges onto the local row."""
    from flow_sdk.server.routes._hub_reflect import _merge_hub_entity_into_local

    p = Project(name="old name", fs_storage_mount_path="/tmp/demo_merge")
    updates = _merge_hub_entity_into_local(p, {"name": "new name"})
    assert updates == {"name": "new name"}

    t = Task(title="old title")
    updates = _merge_hub_entity_into_local(t, {"title": "new title"})
    assert updates == {"title": "new title"}


def test_merge_skips_a_slot_that_did_not_change():
    from flow_sdk.server.routes._hub_reflect import _merge_hub_entity_into_local

    p = Project(name="same", fs_storage_mount_path="/tmp/demo_merge_noop")
    assert _merge_hub_entity_into_local(p, {"name": "same"}) == {}


# ── inbound mirror keeps whichever slot the hub filled ───────────────────────


@pytest.mark.asyncio
async def test_materialize_mirrors_hub_project_name_verbatim():
    from flow_sdk.app.actions.membership_sync import materialize_remote_membership_entity

    project = await materialize_remote_membership_entity(
        Project,
        {"id": str(uuid4()), "name": "Shared Project"},
        f"user-{uuid4()}",
    )
    assert project is not None
    assert project.name == "Shared Project"
    assert project.remote is True


@pytest.mark.asyncio
async def test_materialize_does_not_coerce_title_into_name():
    """The old title→name shim is gone — a hub project's label arrives as ``name``.

    A payload carrying only ``title`` is mirrored into ``title``, left where the
    sender put it, rather than being silently rewritten into ``name``.
    """
    from flow_sdk.app.actions.membership_sync import materialize_remote_membership_entity

    project = await materialize_remote_membership_entity(
        Project,
        {"id": str(uuid4()), "title": "Not A Project Label"},
        f"user-{uuid4()}",
    )
    assert project is not None
    assert project.name is None, "no coercion: ``title`` must not be rewritten into ``name``"
    assert project.title == "Not A Project Label"


@pytest.mark.asyncio
async def test_materialize_updates_an_existing_mirror_on_rename():
    """A renamed hub project converges the already-materialized local row."""
    from flow_sdk.app.actions.membership_sync import materialize_remote_membership_entity

    pid = str(uuid4())
    someone = f"user-{uuid4()}"
    first = await materialize_remote_membership_entity(Project, {"id": pid, "name": "before"}, someone)
    assert first is not None and first.name == "before"

    second = await materialize_remote_membership_entity(Project, {"id": pid, "name": "after"}, someone)
    assert second is not None
    assert second.name == "after"
    assert second.id == pid, "the rename converges the same row, it does not fork a new one"
