"""The operator controls: poll_now, reset_cursors, purge_items, replay, create.

These exist because the engine has no reset concept at all and ingestion had no
way to re-fetch. Several of the tests here are really about traps rather than
plumbing: that ``config_error`` is a permanent latch without ``poll_now``; that
``reset_cursors`` on its own is a deliberate no-op against existing records
because the natural key still resolves them and the digest gate is doing its
job; that a bounded ``replay`` must not delete undated rows; and that deleting a
source has to take its cursors and records with it, since nothing cascades.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_source import DataSource, SourceStatus, parse_since
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.health import SourceHealth

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


async def _source(**kw) -> DataSource:
    base = dict(provider="rss", account_key=f"acct-{uuid.uuid4().hex[:8]}", name="Feed")
    base.update(kw)
    src = DataSource(**base)
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
    for name in ("poll_now", "reset_cursors", "purge_items", "replay"):
        assert f"data_source.{name}" in registered, f"{name} is not routable"

    # There is deliberately NO `create` override: the generic handler already
    # sanitizes fields, stamps the owner and expands permissions, and a bespoke
    # one silently drops any field it forgets to copy.
    assert "data_source.create" not in registered

    for name in ("poll_now_action", "reset_cursors_action", "purge_items_action",
                 "replay_action"):
        params = set(inspect.signature(getattr(DataSource, name)).parameters) - {"self", "cls"}
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
    src = await _source(status=SourceStatus.DISABLED.value)
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
            data_source_id=src.id, provider="rss", kind="content.feed.item",
            segment_key="s", external_id="x1", name="hello", body="body",
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
async def test_purged_records_are_rebuilt_and_local_state_is_the_cost():
    """Why purge is safe: identity is the natural key ``(source, stream,
    external_id)``, resolved by ``find_existing``, so a re-ingest converges on
    one row rather than duplicating it.

    The rebuilt row is a NEW entity with a new uuid4 — equivalent, not identical.
    Anything holding a SourceItem id across a purge is holding a dangling
    reference, which is exactly why the action's docstring says so.
    """
    src = await _source()
    item = SourceItem(
        data_source_id=src.id, provider="rss", kind="content.feed.item",
        segment_key="s", external_id="x1", name="hello", body="body", read=True,
    )
    await item.save()
    original = item.id

    await src.purge_items_action()
    assert await SourceItem.get_one({"id": original}) is None
    assert await SourceItem.find_existing(src.id, "s", "x1") is None

    rebuilt = SourceItem(
        data_source_id=src.id, provider="rss", kind="content.feed.item",
        segment_key="s", external_id="x1", name="hello", body="body",
    )
    await rebuilt.save()

    found = await SourceItem.find_existing(src.id, "s", "x1")
    assert found is not None and found.id == rebuilt.id, (
        "the natural key must resolve the rebuilt row — that lookup IS the "
        "idempotency guarantee now that ids are random"
    )
    assert rebuilt.id != original, "a rebuilt record is a new entity, not the old id"
    assert rebuilt.read is False, (
        "local state is the real cost of purging — say so rather than pretending "
        "the round trip is lossless"
    )


async def _item(src, *, external_id: str, occurred_at: str | None) -> SourceItem:
    row = SourceItem(
        data_source_id=src.id, provider="rss", kind="content.feed.item",
        segment_key="s", external_id=external_id, name=external_id, body="body",
        occurred_at=occurred_at,
    )
    await row.save()
    return row


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_replay_without_a_date_drops_everything_and_makes_the_source_due():
    src = await _source(next_poll_at=NOW + timedelta(hours=1))
    await _item(src, external_id="a", occurred_at="2026-07-30T10:00:00+00:00")
    await _item(src, external_id="b", occurred_at=None)
    await DataSourceCursor.ensure_for(src.id, "s")

    result = await src.replay()

    assert result["removed"] == 2, "an unbounded replay drops every record"
    assert result["streams"] == 1
    assert await SourceItem.get_all({"data_source_id": src.id}) == []
    cursor = await DataSourceCursor.get_one({"data_source_id": src.id})
    assert cursor is not None, "cursor rows are kept — deleting them would flip the next run to BACKFILL"
    assert cursor.high_water is None and cursor.state == {}
    assert src.is_due(NOW) is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_replay_since_a_date_keeps_older_and_undated_records():
    """The window is the point of the verb, and undated rows are not in it.

    `occurred_at` is the ordering key; a row without one cannot be shown to fall
    inside the requested range, so deleting it would silently discard data the
    operator never asked about.
    """
    src = await _source()
    await _item(src, external_id="old", occurred_at="2026-07-01T10:00:00+00:00")
    await _item(src, external_id="new", occurred_at="2026-07-30T10:00:00+00:00")
    await _item(src, external_id="undated", occurred_at=None)

    result = await src.replay(since=datetime(2026, 7, 20, tzinfo=timezone.utc))

    assert result["removed"] == 1
    kept = {r.external_id for r in await SourceItem.get_all({"data_source_id": src.id})}
    assert kept == {"old", "undated"}, f"bounded replay removed the wrong rows: kept {kept}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_replay_since_widens_the_window_but_never_shrinks_it():
    """A replay older than the window would otherwise return nothing: the driver
    filters on the window floor, so the request has to reach that far back."""
    src = await _source(window_days=7)
    long_ago = datetime.now(timezone.utc) - timedelta(days=40)

    result = await src.replay(since=long_ago)
    assert result["window_widened"] is True
    assert src.window_days >= 40

    recent = datetime.now(timezone.utc) - timedelta(days=2)
    result = await src.replay(since=recent)
    assert result["window_widened"] is False
    assert src.window_days >= 40, (
        "a narrow replay must not shrink the window — that would quietly reduce "
        "what every FUTURE poll sees, which is a different decision"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_replay_un_latches_a_parked_source():
    src = await _source(health=SourceHealth.CONFIG_ERROR.value, error_code="unauthorized")
    assert src.is_due(NOW) is False

    await src.replay()

    assert src.health != SourceHealth.CONFIG_ERROR.value
    assert src.is_due(NOW) is True, (
        "a parked source would accept the replay and then never poll to act on it"
    )


def test_replay_rejects_a_date_it_cannot_parse():
    """Loudly, because the fallback would be catastrophic: reading an
    unparseable date as "no date" turns a bounded replay into a full one and
    deletes every record the operator meant to keep."""
    parsed, problem = parse_since("last tuesday")
    assert parsed is None and problem and "ISO-8601" in problem

    assert parse_since("") == (None, None), "no date is not an error — it means replay everything"

    naive, problem = parse_since("2026-07-20T00:00:00")
    assert problem is None and naive is not None and naive.tzinfo is not None, (
        "a naive date must be read as UTC, like every other timestamp here"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_delete_by_id_cascades_too_because_http_never_builds_the_instance():
    """THE path a UI delete takes, and the one an instance override misses.

    `handle_delete_by_id` calls the CLASSMETHOD `delete_by_id` and never
    constructs the entity — so hooking only `destroy()` leaves the records and
    cursors orphaned over the wire while every direct-call test still passes.
    This was caught in the browser, not by a unit test; hence this one.
    """
    src = await _source()
    await _item(src, external_id="a", occurred_at=None)
    await DataSourceCursor.ensure_for(src.id, "s")

    await DataSource.delete_by_id(src.id)

    assert await DataSource.get_one({"id": src.id}) is None
    assert await SourceItem.get_all({"data_source_id": src.id}) == []
    assert await DataSourceCursor.get_all({"data_source_id": src.id}) == []


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_destroy_takes_the_cursors_and_records_with_it():
    """Nothing cascades on its own — both are separate rows keyed by
    data_source_id, so deleting only the source leaves orphans pointing at an id
    that no longer resolves."""
    src = await _source()
    other = await _source()
    await _item(src, external_id="a", occurred_at=None)
    await DataSourceCursor.ensure_for(src.id, "s")
    await _item(other, external_id="a", occurred_at=None)
    await DataSourceCursor.ensure_for(other.id, "s")

    await src.destroy()

    assert await DataSource.get_one({"id": src.id}) is None
    assert await SourceItem.get_all({"data_source_id": src.id}) == []
    assert await DataSourceCursor.get_all({"data_source_id": src.id}) == []

    assert len(await SourceItem.get_all({"data_source_id": other.id})) == 1, "delete crossed sources"
    assert len(await DataSourceCursor.get_all({"data_source_id": other.id})) == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_channel_is_stamped_at_create_not_first_poll():
    """The projection races the first fetch: items recorded by the worker
    mid-fetch project BEFORE sync's post-fetch save lands, and a source whose
    channel is still empty bakes origin.kind="agent" into every message
    (observed live, inbox-7 2026-09-01). Stamping at create closes the race."""
    import flow_sdk.ingest.drivers  # noqa: F401,PLC0415 — registers the drivers

    src = await _source(provider="agent", config={"connector": "slack", "segments": ["C1"]})
    assert src.channel == "slack", "channel must be present before any poll"
