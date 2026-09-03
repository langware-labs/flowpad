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
