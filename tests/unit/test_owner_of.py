"""``owner`` is the one key the inbox partitions by; ``owner_of`` is its one reader.

Three rows can answer the question today — an explicit ``owner``, a legacy
source that only carries ``config.agent_id``, and a bare row — and every
consumer must get the same answer from all three, before and after the
backfill. The last test is the one that would have caught a silent
serialisation mismatch: a ``TypeId`` that stored as anything but the plain
``"type-id"`` string would make every ``owner`` filter and the ``_v2`` index
match nothing while every read still looked fine.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.user import User
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.inbox.projection import default_owner, is_agent_owner, owner_of
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _agent_tid() -> TypeId:
    return TypeId(type=EntityType.AGENT.value, id=str(uuid.uuid4()))


async def _local_user() -> User:
    local = await User.get_local()
    if local is None:
        local = User(uname="local", name="local")
        await local.save(notify=False)
    return local


async def test_explicit_owner_wins_over_a_legacy_agent_id():
    tid = _agent_tid()
    source = DataSource(name="s", provider="cloud_email", owner=tid, config={"agent_id": str(uuid.uuid4())})
    assert await owner_of(source) == tid


async def test_a_legacy_source_with_only_config_agent_id_is_that_agents():
    agent_id = str(uuid.uuid4())
    source = DataSource(name="s", provider="cloud_email", config={"agent_id": agent_id})
    owner = await owner_of(source)
    assert owner == TypeId(type=EntityType.AGENT.value, id=agent_id)
    assert is_agent_owner(owner)


async def test_a_bare_row_is_the_local_users():
    local = await _local_user()
    source = DataSource(name="s", provider="rss")
    owner = await owner_of(source)
    assert owner == await default_owner()
    assert owner == TypeId(type=EntityType.USER.value, id=str(local.id))
    assert not is_agent_owner(owner)


async def test_owner_serialises_as_the_plain_typeid_string_and_is_queryable():
    """Risk 1 from the plan: the field must be a filterable string on the wire."""
    tid = _agent_tid()
    source = DataSource(name="owned", provider="rss", owner=tid)
    assert source.model_dump(mode="json")["owner"] == str(tid)

    await source.save(notify=False)
    found = await DataSource.get_one({"owner": str(tid)})
    assert found is not None and found.id == source.id
    assert found.owner == tid


async def test_thread_lookup_narrows_by_owner_and_stays_pre_owner_without_it():
    a, b = _agent_tid(), _agent_tid()
    key = f"thread-{uuid.uuid4()}"
    ta = MessageThread(id=str(uuid.uuid4()), channel="slack", thread_key=key, owner=a, conversation_id=str(uuid.uuid4()))
    tb = MessageThread(id=str(uuid.uuid4()), channel="slack", thread_key=key, owner=b, conversation_id=str(uuid.uuid4()))
    await ta.save(notify=False)
    await tb.save(notify=False)

    assert (await MessageThread.find_existing("slack", key, a)).id == ta.id
    assert (await MessageThread.find_existing("slack", key, b)).id == tb.id
    # Owner omitted on a key two owners share: the pre-owner lookup must NOT
    # silently pick one — `get_one` refuses an ambiguous key. This is why the
    # projection's resolve-or-create always passes the owner, and why its
    # legacy fallback is scoped to `owner IS NULL` rather than "any owner".
    with pytest.raises(ValueError, match="Multiple"):
        await MessageThread.find_existing("slack", key)


# ── Phase 2: writers stamp owner; the thread seam keeps owners apart ─────────


async def test_two_owners_on_one_key_get_two_threads_and_one_owner_gets_one():
    """Enters through `resolve_thread`, the projection's real thread seam."""
    from flow_sdk.inbox.projection import resolve_thread

    a, b = _agent_tid(), _agent_tid()
    key = f"ts-{uuid.uuid4()}"
    ta1 = await resolve_thread("slack", key, a, title="t")
    ta2 = await resolve_thread("slack", key, a, title="t")
    tb = await resolve_thread("slack", key, b, title="t")
    assert ta1.id == ta2.id, "the same owner must resolve one thread"
    assert tb.id != ta1.id, "a second owner on the same key must not merge into the first"
    assert ta1.conversation_id != tb.conversation_id


async def test_a_pre_owner_thread_is_adopted_by_the_first_owner_not_forked():
    """The conversation a user has been reading must survive the key change."""
    from flow_sdk.inbox.projection import resolve_thread

    key = f"ts-{uuid.uuid4()}"
    legacy = MessageThread(id=str(uuid.uuid4()), channel="slack", thread_key=key, conversation_id=str(uuid.uuid4()))
    await legacy.save(notify=False)  # owner is None: a row from before the field existed

    a = _agent_tid()
    adopted = await resolve_thread("slack", key, a, title="t")
    assert adopted.id == legacy.id
    assert adopted.conversation_id == legacy.conversation_id
    assert (await MessageThread.get_one({"id": legacy.id})).owner == a

    # Once claimed, it is A's: a second owner mints its own rather than stealing it.
    b = _agent_tid()
    other = await resolve_thread("slack", key, b, title="t")
    assert other.id != legacy.id
    assert await MessageThread.find_unowned("slack", key) is None


async def test_find_for_account_narrows_by_owner_and_is_pre_owner_without_it():
    a, b = _agent_tid(), _agent_tid()
    channel = f"C{uuid.uuid4().hex[:8]}"
    sa = DataSource(name="a", provider="slack", config={"channels": [channel]}, owner=a)
    sb = DataSource(name="b", provider="slack", config={"channels": [channel]}, owner=b)
    await sa.save(notify=False)
    await sb.save(notify=False)

    assert (await DataSource.find_for_account("slack", "channels", channel, owner=a)).id == sa.id
    assert (await DataSource.find_for_account("slack", "channels", channel, owner=b)).id == sb.id
    # Omitted: the pre-owner lookup returns the first match, as it always has.
    assert (await DataSource.find_for_account("slack", "channels", channel)).id in {sa.id, sb.id}


async def test_find_owned_includes_a_legacy_agent_row_and_filters_by_channel():
    agent_id = str(uuid.uuid4())
    tid = TypeId(type=EntityType.AGENT.value, id=agent_id)
    owned = DataSource(name="o", provider="rss", owner=tid, channel="rss")
    legacy = DataSource(name="l", provider="cloud_email", config={"agent_id": agent_id}, channel="agentmail")
    stranger = DataSource(name="s", provider="rss", owner=_agent_tid(), channel="rss")
    for row in (owned, legacy, stranger):
        await row.save(notify=False)
    # The save choke-point must NOT overwrite a legacy row's implied owner with the local user.
    assert (await DataSource.get_one({"id": legacy.id})).owner == tid

    ids = {r.id for r in await DataSource.find_owned(tid)}
    assert ids == {owned.id, legacy.id}
    assert {r.id for r in await DataSource.find_owned(tid, channel="agentmail")} == {legacy.id}


async def test_save_stamps_the_local_user_when_nothing_set_an_owner():
    local = await _local_user()
    source = DataSource(name="mine", provider="rss")
    assert source.owner is None
    await source.save(notify=False)
    assert source.owner == TypeId(type=EntityType.USER.value, id=str(local.id))


async def test_ensure_conversation_entity_stamps_owner_and_adopts_a_pre_owner_row():
    from flow_sdk.app.actions.materialize_flow_message import ensure_conversation_entity
    from flow_sdk.builtin.conversation import Conversation

    a = _agent_tid()
    created = await ensure_conversation_entity(str(uuid.uuid4()), None, title="t", owner=a)
    assert created.owner == a

    await _local_user()
    plain = await ensure_conversation_entity(str(uuid.uuid4()), None, title="t")
    assert plain.owner == await default_owner(), "no owner given → the local user's"

    # A row from before the field existed, touched by a caller that knows the owner.
    pre = Conversation(title="old")
    pre.id = str(uuid.uuid4())
    await pre.save(None, notify=False)
    assert (await Conversation.get_one({"id": pre.id})).owner is None
    adopted = await ensure_conversation_entity(pre.id, None, owner=a)
    assert adopted.owner == a
    assert (await Conversation.get_one({"id": pre.id})).owner == a
