"""Unit tests for the Topic entity (blessed dot-taxonomy names).

Contract under test (no LLM, no server):
  * Identity is the name: uuid5 minting is deterministic across construction,
    normalization variants, and reloads — late blessing is stable.
  * Names are strictly validated on adoption (the bus stays permissive).
  * ``resolve_topic`` is wiki-link-style: entity or None, and NEVER mints.
  * The type is registered (entity class + type metadata) so the generic
    graph CRUD path can serve it.
"""

import pytest

from flow_sdk.builtin.topic import RESERVED_ROOTS, Topic, resolve_topic
from flow_sdk.schema.type_info import register_all
from flow_sdk.schema.types import EntityType

register_all()


def test_id_is_deterministic_uuid5_of_the_name():
    from flow_sdk.fs_store.identifier import is_valid_entity_id

    a = Topic(name="flow.step.done")
    b = Topic(name="  Flow.Step.Done ")  # normalization variant → same identity
    assert a.id == b.id
    assert a.name == b.name == "flow.step.done"
    assert a.uname == "flow.step.done"
    assert is_valid_entity_id(a.id)
    assert Topic(name="flow.step.failed").id != a.id


def test_namespace_topic_accepted_first_segment_only():
    t = Topic(name="--acme--.orders.created")
    assert t.name == "--acme--.orders.created"
    with pytest.raises(ValueError):
        Topic(name="orders.--acme--.created")


def test_invalid_names_rejected_on_adoption():
    for bad in ("", "flow..done", "flow step", "flow:step"):
        with pytest.raises((ValueError, TypeError)):
            Topic(name=bad)


def test_conforming_caller_id_is_kept():
    # Materialize/hub reconstruction path: a valid v4/v5 id wins over the name.
    pre_minted = "11111111-2222-4333-8444-555555555555"
    t = Topic(id=pre_minted, name="flow.step.done")
    assert t.id == pre_minted


@pytest.mark.asyncio
async def test_roundtrip_and_late_blessing_converges():
    t = Topic(name="shipping.orders.created", description="An order was placed")
    await t.save()

    loaded = await Topic.get_by_id(t.id)
    assert loaded is not None
    assert loaded.name == "shipping.orders.created"
    assert loaded.description == "An order was placed"
    assert loaded.model_dump(mode="json")["type"] == EntityType.TOPIC.value

    # Blessing the same name again (another instance, another day) converges
    # on the same id — this is what makes hub sync dedupe for free.
    assert Topic(name="shipping.orders.created").id == t.id


@pytest.mark.asyncio
async def test_resolve_topic_hit_miss_and_never_mints():
    t = Topic(name="--acme--.machines.online", title="Machine online")
    await t.save()

    hit = await resolve_topic("  --Acme--.Machines.Online ")  # canonical-form resolution
    assert hit is not None and hit.id == t.id

    miss = await resolve_topic("totally.anonymous.topic")
    assert miss is None
    # Anonymous stays anonymous: resolution never created a row.
    assert await resolve_topic("totally.anonymous.topic") is None

    assert await resolve_topic("not a topic!") is None  # invalid → None, no raise


def test_reserved_roots_match_the_cross_language_fixture():
    """RESERVED_ROOTS is derived from the seed; the fixture pins it against the
    TS mirror (RESERVED_TOPIC_ROOTS in ts_sdk/src/entities/topic.ts) exactly
    like the grammar cases."""
    import json
    from pathlib import Path

    fixture = json.loads(
        (Path(__file__).parent.parent / "fixtures" / "flow_event_contract.json").read_text()
    )["grammar"]["reserved_roots"]
    assert sorted(RESERVED_ROOTS) == fixture


@pytest.mark.asyncio
async def test_reserved_root_rejected_for_user_topics():
    with pytest.raises(ValueError, match="reserved system root"):
        await Topic(name="flow.hacked").save()
    # Namespaced and non-reserved roots are open to users.
    await Topic(name="--acme--.orders.created").save()
    await Topic(name="shipping.box.packed").save()


@pytest.mark.asyncio
async def test_seed_system_topics_idempotent():
    from flow_sdk.builtin.topic import SYSTEM_TOPIC_SEED, seed_system_topics

    first = await seed_system_topics()
    assert first == len(SYSTEM_TOPIC_SEED)  # fresh DB: every row written
    assert await seed_system_topics() == 0  # re-run converges to a no-op

    blessed = await resolve_topic("flow.step.done")
    assert blessed is not None and blessed.system and blessed.title == "Flow step done"

    # Every seeded name is grammar-valid and reserved-rooted by a system row.
    for name, _title, _desc in SYSTEM_TOPIC_SEED:
        assert Topic(name=name).name == name


def test_topic_registered():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    assert SchemaRegistry.get_entity_cls("topic") is Topic
    assert "topic" in SchemaRegistry.get_all_types()
    assert SchemaRegistry.get_icon("topic") == "Hash"
