"""The operator controls: poll_now, reset_cursors, purge_items.

These exist because the engine has no reset concept at all and ingestion had no
way to re-fetch. Two of the tests here are really about traps rather than
plumbing: that ``config_error`` is a permanent latch without ``poll_now``, and
that ``reset_cursors`` on its own is a deliberate no-op against existing records
because the ids are deterministic and the digest gate is doing its job.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.health import SourceHealth

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


async def _source(**kw) -> DataSource:
    base = dict(provider="rss", account_key=f"acct-{uuid.uuid4().hex[:8]}", name="Feed")
    base.update(kw)
    src = DataSource(
        id=DataSource.allocate_deterministic_id(base["provider"], base["account_key"]), **base
    )
    await src.save()
    return src


def test_the_actions_are_reachable_over_http_not_just_callable():
    """Calling the methods directly proves nothing about the route.

    The dispatcher fills handler arguments by inspecting the signature, and it
    resolves an annotated `request` by IDENTITY (`param.annotation is Request`,
    server/routes/graph.py:194) — so under postponed evaluation the annotation
    is a string, no match is found, and every action 400s with "Missing required
    argument: request" while every direct-call test still passes. These actions
    need no request, so they declare none (the `capability.py` convention) and
    the trap cannot apply. This test pins both halves.
    """
    import inspect

    from flow_sdk.actions.action_registry import action as registry

    registered = set(registry.function_registry)
    for name in ("poll_now", "reset_cursors", "purge_items"):
        assert f"data_source.{name}" in registered, f"{name} is not routable"

    for name in ("poll_now_action", "reset_cursors_action", "purge_items_action"):
        params = set(inspect.signature(getattr(DataSource, name)).parameters) - {"self"}
        assert not params, (
            f"DataSource.{name} declares {sorted(params)}; the dispatcher must fill "
            "every declared parameter, and an annotated `request` only resolves when "
            "the annotation is the live class rather than a string"
        )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_poll_now_is_the_only_unlatch_for_config_error():
    """`is_due` refuses a config_error source, and nothing else clears it."""
    src = await _source(
        health=SourceHealth.CONFIG_ERROR.value,
        error_code="unknown_provider",
        error_detail="boom",
        next_poll_at=NOW - timedelta(hours=1),
    )
    assert src.is_due(NOW) is False, (
        "precondition: a config_error source is parked even when its next poll "
        "is long past — that is the latch"
    )

    await src.poll_now_action()

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health != SourceHealth.CONFIG_ERROR.value
    assert refreshed.error_code is None and refreshed.error_detail is None
    assert refreshed.is_due(NOW) is True, "still parked — the latch has no exit"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_poll_now_does_not_wake_a_disabled_source():
    """Disabled is a user decision; 'poll now' must not override it."""
    src = await _source(enabled=False)
    await src.poll_now_action()
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.is_due(NOW) is False


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reset_cursors_clears_position_including_opaque_state():
    """The opaque half matters most: an ETag left behind means the next poll
    answers 304 and the 'reset' fetches nothing at all."""
    src = await _source()
    cursor = await DataSourceCursor.ensure_for(src.id, "https://a.test/feed")
    cursor.high_water = "2026-07-30T10:00:00+00:00"
    cursor.state = {"etag": 'W/"v1"', "last_modified": "Wed, 30 Jul 2026 10:00:00 GMT"}
    cursor.health = SourceHealth.TRANSIENT_ERROR.value
    cursor.consecutive_failures = 3
    cursor.error_code = "server_error"
    synced = NOW - timedelta(hours=1)
    cursor.last_synced_at = synced
    await cursor.save()

    await src.reset_cursors_action()

    after = await DataSourceCursor.ensure_for(src.id, "https://a.test/feed")
    assert after.high_water is None
    assert after.state == {}, "provider-opaque state survived — the re-fetch will 304"
    assert after.consecutive_failures == 0
    assert after.error_code is None
    assert after.last_synced_at is not None, (
        "last_synced_at was cleared, so the next run reads as first_run → BACKFILL, "
        "which suppresses per-item events and makes a deliberate re-fetch silent"
    )
    assert (await DataSource.get_one({"id": src.id})).is_due(NOW) is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_purge_items_removes_only_this_sources_records():
    mine = await _source()
    theirs = await _source()
    for src in (mine, theirs):
        item = SourceItem(
            id=SourceItem.allocate_deterministic_id(src.id, "s", "x1"),
            data_source_id=src.id, provider="rss", kind="content.feed.item",
            stream_key="s", external_id="x1", name="hello", body="body",
        )
        await item.save()

    result = await mine.purge_items_action()
    assert result.data["removed"] == 1

    assert await SourceItem.get_all({"data_source_id": mine.id}) == []
    assert len(await SourceItem.get_all({"data_source_id": theirs.id})) == 1, (
        "purge crossed source boundaries"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_purged_records_are_rebuilt_with_identical_ids():
    """Why purge is safe: identity is uuid5(source, stream, external_id), so a
    re-ingest converges on the same row rather than duplicating it."""
    src = await _source()
    original = SourceItem.allocate_deterministic_id(src.id, "s", "x1")
    item = SourceItem(
        id=original, data_source_id=src.id, provider="rss", kind="content.feed.item",
        stream_key="s", external_id="x1", name="hello", body="body", read=True,
    )
    await item.save()

    await src.purge_items_action()
    assert await SourceItem.get_one({"id": original}) is None

    rebuilt = SourceItem(
        id=SourceItem.allocate_deterministic_id(src.id, "s", "x1"),
        data_source_id=src.id, provider="rss", kind="content.feed.item",
        stream_key="s", external_id="x1", name="hello", body="body",
    )
    await rebuilt.save()
    assert rebuilt.id == original
    assert rebuilt.read is False, (
        "local state is the real cost of purging — say so rather than pretending "
        "the round trip is lossless"
    )
