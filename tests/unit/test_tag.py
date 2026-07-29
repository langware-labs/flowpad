"""Unit tests for the Tag entity (blessed dot-taxonomy names).

Contract under test (no LLM, no server):
  * Identity is the name: uuid5 minting is deterministic across construction,
    normalization variants, and reloads — late blessing is stable.
  * Names are strictly validated on adoption (the bus stays permissive).
  * ``resolve_tag`` is wiki-link-style: entity or None, and NEVER mints.
  * The type is registered (entity class + type metadata) so the generic
    graph CRUD path can serve it.
"""

import pytest

from flow_sdk.builtin.tag import RESERVED_ROOTS, Tag, resolve_tag
from flow_sdk.schema.type_info import register_all
from flow_sdk.schema.types import EntityType

register_all()


def test_id_is_deterministic_uuid5_of_the_name():
    import uuid

    from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid

    a = Tag(name="graph_workflow.step.done")
    b = Tag(name="  Graph_Workflow.Step.Done ")  # normalization variant → same identity
    assert a.id == b.id
    assert a.id == mint_uuid("tag:graph_workflow.step.done", namespace=uuid.NAMESPACE_DNS)
    assert a.name == b.name == "graph_workflow.step.done"
    assert a.uname is None
    assert is_valid_entity_id(a.id)
    assert Tag(name="graph_workflow.step.failed").id != a.id


def test_namespace_tag_accepted_first_segment_only():
    t = Tag(name="--acme--.orders.created")
    assert t.name == "--acme--.orders.created"
    with pytest.raises(ValueError):
        Tag(name="orders.--acme--.created")


def test_invalid_names_rejected_on_adoption():
    for bad in ("", "graph_workflow..done", "flow step", "flow:step"):
        with pytest.raises((ValueError, TypeError)):
            Tag(name=bad)


def test_caller_id_cannot_override_name_identity():
    supplied = "11111111-2222-4333-8444-555555555555"
    assert Tag(id=supplied, name="graph_workflow.step.done").id == Tag(name="graph_workflow.step.done").id


@pytest.mark.asyncio
async def test_roundtrip_and_late_blessing_converges():
    t = Tag(name="shipping.orders.created", description="An order was placed")
    await t.save()

    loaded = await Tag.get_by_id(t.id)
    assert loaded is not None
    assert loaded.name == "shipping.orders.created"
    assert loaded.description == "An order was placed"
    assert loaded.model_dump(mode="json")["type"] == EntityType.TAG.value

    # Blessing the same name again (another instance, another day) converges
    # on the same id — this is what makes hub sync dedupe for free.
    assert Tag(name="shipping.orders.created").id == t.id


@pytest.mark.asyncio
async def test_resolve_tag_hit_miss_and_never_mints():
    t = Tag(name="--acme--.machines.online", title="Machine online")
    await t.save()

    hit = await resolve_tag("  --Acme--.Machines.Online ")  # canonical-form resolution
    assert hit is not None and hit.id == t.id

    miss = await resolve_tag("totally.anonymous.tag")
    assert miss is None
    # Anonymous stays anonymous: resolution never created a row.
    assert await resolve_tag("totally.anonymous.tag") is None

    assert await resolve_tag("not a tag!") is None  # invalid → None, no raise


def test_reserved_roots_match_the_cross_language_fixture():
    """RESERVED_ROOTS is derived from the seed; the fixture pins it against the
    TS mirror (RESERVED_TAG_ROOTS in ts_sdk/src/entities/tag.ts) exactly
    like the grammar cases."""
    import json
    from pathlib import Path

    fixture = json.loads(
        (Path(__file__).parent.parent / "fixtures" / "flow_event_contract.json").read_text()
    )["grammar"]["reserved_roots"]
    assert sorted(RESERVED_ROOTS) == fixture


@pytest.mark.asyncio
async def test_reserved_root_rejected_for_user_tags():
    with pytest.raises(ValueError, match="reserved system root"):
        await Tag(name="graph_workflow.hacked").save()
    # Namespaced and non-reserved roots are open to users.
    await Tag(name="--acme--.orders.created").save()
    await Tag(name="shipping.box.packed").save()


@pytest.mark.asyncio
async def test_seed_system_tags_idempotent():
    from flow_sdk.builtin.tag import SYSTEM_TAG_SEED, seed_system_tags

    # A TestClient lifespan earlier in the full suite performs the real server
    # seed. Establish the fresh-seed precondition explicitly, then leave the
    # canonical vocabulary restored for subsequent tests.
    for name, _title, _description in SYSTEM_TAG_SEED:
        existing = await Tag.get_by_id(Tag(name=name).id)
        if existing is not None:
            await existing.delete()

    first = await seed_system_tags()
    assert first == len(SYSTEM_TAG_SEED)  # fresh DB: every row written
    assert await seed_system_tags() == 0  # re-run converges to a no-op

    blessed = await resolve_tag("graph_workflow.step.done")
    assert blessed is not None and blessed.system and blessed.title == "Graph workflow step done"

    # Every seeded name is grammar-valid and reserved-rooted by a system row.
    for name, _title, _desc in SYSTEM_TAG_SEED:
        assert Tag(name=name).name == name


def test_tag_registered():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    assert SchemaRegistry.get_entity_cls("tag") is Tag
    assert "tag" in SchemaRegistry.get_all_types()
    assert SchemaRegistry.get_icon("tag") == "Hash"
