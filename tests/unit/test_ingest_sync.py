"""The sync loop: per-stream isolation, records-before-cursor, and the budget.

Plus the abstraction gate — a grep, deliberately. The cursor is opaque by contract, and the only way
that contract survives adding providers is if a leak is mechanically detectable. A reviewer will not
notice a provider's cursor key appearing in sync.py; this test will.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.ingest.driver_types import DriverType, SegmentPass, register_driver
from flow_sdk.ingest.health import SourceError, SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec
from flow_sdk.sources.base import Source
from flow_sdk.sources.values.segment import SegmentRef

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)

#: Provider-private cursor keys. None of these may appear in the engine.
_PROVIDER_STATE_KEYS = ("etag", "last_modified", "last_update_ptr", "oldest_ts", "boundary_ids")


def test_cursor_state_is_opaque_to_the_subsystem():
    """No provider-private cursor key may be read in ``ingest/``: each source lifts its own legacy
    cursor (``Source.lift_cursor``) in its asset folder."""
    root = Path(__file__).resolve().parents[2] / "flow_sdk" / "ingest"
    offenders: list[str] = []

    for path in root.rglob("*.py"):
        code ="\n".join(line for line in path.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#"))
        for key in _PROVIDER_STATE_KEYS:
            if re.search(rf"""["']{key}["']""", code):
                offenders.append(f"{path.relative_to(root.parent.parent)} references {key!r}")

    assert not offenders, "provider-private cursor state leaked into the engine:\n  " + "\n  ".join(offenders)


class _FakeSource(Source):
    provider = "faketest"


class _FakeType(DriverType):
    """A source type whose traversal each test dictates per stream."""

    def __init__(self, streams, behaviour, stamps: dict[str, str] | None = None, *, reflects: bool = False):
        super().__init__(_FakeSource, kind="datasource.feed.faketest")
        self._streams = streams
        self._behaviour = behaviour
        self._reflects = reflects
        #: Per-stream listing token (``SegmentRef.stamp``); empty = the source cannot say.
        self.stamps: dict[str, str] = stamps or {}
        self.calls: list[str] = []

    @property
    def reflects(self) -> bool:
        return self._reflects

    async def segments(self, row):
        keys = self._streams or list(self.stamps)
        return [SegmentRef(key=k, label=k, stamp=self.stamps.get(k, "")) for k in keys]

    async def traverse(self, row, position):
        self.calls.append(position.segment_key)
        outcome = self._behaviour[position.segment_key]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _item(data_source_id, segment_key, n) -> SourceItemSpec:
    return SourceItemSpec(
        data_source_id=data_source_id,
        provider="faketest",
        kind="content.feed.item",
        segment_key=segment_key,
        external_id=f"{segment_key}-{n}",
        name=f"item {n}",
        body=f"body {n}",
    )


async def _source(**kw) -> DataSource:
    fields = {"provider": "faketest", "account_key": f"acct-{uuid.uuid4().hex[:8]}", "name": "fake"}
    fields.update(kw)
    src = DataSource(**fields)
    await src.save()
    return src


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_one_failing_stream_does_not_stall_its_siblings():
    src = await _source()
    good, bad = "https://good.test/f", "https://bad.test/f"
    register_driver(
        _FakeType(
            [good, bad],
            {
                good: SegmentPass(items=[_item(src.id, good, 1)], cursor="1", high_water="1"),
                bad: SourceError.transient("server_error", "HTTP 503"),
            },
        )
    )

    report = await sync_source(src, now=NOW, budget=10)
    assert report.created == 1, "the healthy stream must still ingest"

    good_cursor = await DataSourceCursor.ensure_for(src.id, good)
    bad_cursor = await DataSourceCursor.ensure_for(src.id, bad)

    assert good_cursor.high_water == "1" and good_cursor.health == SourceHealth.OK.value
    assert bad_cursor.high_water is None, "a failed stream advanced its cursor — the window it never read is now lost"
    assert bad_cursor.health == SourceHealth.TRANSIENT_ERROR.value
    assert bad_cursor.consecutive_failures == 1

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.TRANSIENT_ERROR.value, "worst-of rollup"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_rollup_records_the_segment_count():
    """So a list can show it without watching the cursor table, the highest-churn rows there are."""
    src = await _source()
    feeds = ["https://a.test/f", "https://b.test/f", "https://c.test/f"]
    register_driver(_FakeType(feeds, {f: SegmentPass() for f in feeds}))

    await sync_source(src, now=NOW, budget=1)

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.segment_count == 3, (
        f"the count must cover every declared stream, not just the budgeted slice (got {refreshed.segment_count})"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unchanged_result_advances_nothing_and_ingests_nothing():
    src = await _source()
    key = "https://static.test/f"
    register_driver(_FakeType([key], {key: SegmentPass(cursor="kept", unchanged=True)}))

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert cursor.health == SourceHealth.OK.value
    assert cursor.cursor == "kept", "the source's cursor must be carried verbatim"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_legacy_state_is_handed_to_the_type_once_then_cleared():
    """A row an older build wrote carries its position in ``state``: the traversal is told, and a good
    pass replaces it with the lifted cursor, so the dict is never read twice."""
    src = await _source()
    key = "https://legacy.test/f"
    seen: list = []

    class _Lifting(_FakeType):
        async def traverse(self, row, position):
            seen.append(dict(position.legacy_state))
            return SegmentPass(cursor="lifted")

    register_driver(_Lifting([key], {}))
    row = await DataSourceCursor.ensure_for(src.id, key)
    row.state = {"old": "pointer"}
    await row.save()

    await sync_source(src, now=NOW)
    await sync_source(src, now=NOW + timedelta(minutes=1))

    assert seen == [{"old": "pointer"}, {}], "the legacy state is handed over once"
    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert (cursor.cursor, cursor.state) == ("lifted", {})


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_budget_round_robins_the_longest_waiting_streams():
    src = await _source()
    keys = [f"https://s{i}.test/f" for i in range(4)]
    fake = _FakeType(keys, {k: SegmentPass() for k in keys})
    register_driver(fake)

    # Two streams already attempted recently; two never attempted.
    for k in keys[:2]:
        c = await DataSourceCursor.ensure_for(src.id, k)
        c.last_attempted_at = NOW - timedelta(seconds=10)
        await c.save()

    fake.calls.clear()
    await sync_source(src, now=NOW, budget=2)

    assert set(fake.calls) == set(keys[2:]), f"budget spent on {fake.calls}; never-attempted streams must go first"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unknown_provider_is_a_config_error_not_a_crash():
    src = await _source(provider="nosuchprovider")
    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.CONFIG_ERROR.value
    assert refreshed.error_code == "unknown_provider"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_next_poll_is_scheduled_even_when_a_stream_failed():
    src = await _source(poll_interval_seconds=120)
    key = "https://bad.test/f"
    register_driver(_FakeType([key], {key: SourceError.transient("server_error", "boom")}))

    await sync_source(src, now=NOW)
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.next_poll_at is not None, "a failed run must still reschedule"
    assert refreshed.is_due(NOW) is False
    assert refreshed.is_due(NOW + timedelta(seconds=121)) is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_parked_segment_does_not_park_the_source():
    """One `config_error` stream is parked on ITS row; its siblings keep polling."""
    src = await _source()
    good, parked = "https://good.test/f", "https://gone.test/f"
    fake = _FakeType(
        [good, parked],
        {good: SegmentPass(cursor="1", high_water="1"), parked: SourceError.config("not_found", "HTTP 404")},
    )
    register_driver(fake)

    await sync_source(src, now=NOW, budget=10)
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.OK.value, f"one parked segment parked the whole source ({refreshed.health})"
    assert refreshed.poll_refusal() == "", "the healthy sibling must keep polling"
    assert refreshed.error_code == "not_found", "the card must still name the parked segment"

    # Second run: the parked stream is not a candidate; only the sibling runs.
    fake.calls.clear()
    await sync_source(refreshed, now=NOW + timedelta(minutes=1), budget=10)
    assert fake.calls == [good], f"a parked stream was re-polled: {fake.calls}"
    parked_cursor = await DataSourceCursor.ensure_for(src.id, parked)
    assert parked_cursor.health == SourceHealth.CONFIG_ERROR.value

    # When NOTHING is left to run, the source itself is parked.
    register_driver(_FakeType([parked], {parked: SourceError.config("not_found", "HTTP 404")}))
    only = await _source()
    await sync_source(only, now=NOW, budget=10)
    assert (await DataSource.get_one({"id": only.id})).health == SourceHealth.CONFIG_ERROR.value


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_refs_under_record_mode_are_a_config_error_not_a_silent_drop():
    """A reflecting source has no record destination; refused BEFORE any segment is traversed,
    because `reflect` is a property of the source."""
    src = await _source(reflect="record")
    key = "root"
    fake = _FakeType([key], {key: SegmentPass(refs=["a.md"], manifest={"a.md": ["1", ""]}, high_water="1")}, reflects=True)
    register_driver(fake)

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []
    assert fake.calls == [], "the config fact was knowable without traversing"

    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert cursor.manifest == {} and cursor.high_water is None, "the cursor advanced past dropped files"
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.CONFIG_ERROR.value
    assert refreshed.error_code == "reflect_mode"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_write_failure_is_classified_and_leaves_the_cursor_put(monkeypatch):
    """`ingest_items` raising must not escape `sync_source`: health recorded, cursor unmoved."""
    import flow_sdk.ingest.sync as sync_mod

    async def _boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(sync_mod, "ingest_items", _boom)
    src = await _source(poll_interval_seconds=120)
    key = "https://w.test/f"
    register_driver(_FakeType([key], {key: SegmentPass(items=[_item(src.id, key, 1)], cursor="1", high_water="1")}))

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert cursor.health == SourceHealth.TRANSIENT_ERROR.value
    assert cursor.error_code == "RuntimeError"
    assert cursor.consecutive_failures == 1
    assert cursor.cursor is None and cursor.high_water is None, "records were not committed; the cursor must not move"
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.TRANSIENT_ERROR.value, "roll-up must still run"
    assert refreshed.next_poll_at is not None and refreshed.is_due(NOW + timedelta(seconds=121))


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_stream_whose_listing_token_did_not_move_is_neither_fetched_nor_budgeted():
    """The listing already said nothing changed: no request, and the budget slot goes to a stream
    that DID move."""
    src = await _source()
    idle, moved = "https://idle.test/f", "https://moved.test/f"
    fake = _FakeType([], {k: SegmentPass() for k in (idle, moved)}, stamps={idle: "3:t1", moved: "1:t1"})
    register_driver(fake)

    await sync_source(src, now=NOW, budget=2)
    assert sorted(fake.calls) == sorted([idle, moved]), "first sight: both fetched"
    idle_cursor = await DataSourceCursor.get_one({"data_source_id": src.id, "segment_key": idle})
    assert idle_cursor.segment_stamp == "3:t1", "the token is recorded on a good fetch"

    fake.stamps[moved] = "2:t2"
    fake.calls.clear()
    await sync_source(src, now=NOW + timedelta(seconds=60), budget=1)
    assert fake.calls == [moved], f"only the moved stream is due, got {fake.calls}"

    # A moved stream outranks the never-attempted backlog.
    fresh = "https://fresh.test/f"
    fake.stamps[fresh] = "9:t9"
    fake.stamps[moved] = "3:t3"
    fake._behaviour[fresh] = SegmentPass()
    fake.calls.clear()
    await sync_source(src, now=NOW + timedelta(seconds=120), budget=1)
    assert fake.calls == [moved], f"the moved stream goes before the never-attempted one, got {fake.calls}"

    # With room to spare the backlog only trickles: one never-attempted stream rides along.
    for i in range(3):
        fake.stamps[f"https://old{i}.test/f"] = f"1:o{i}"
        fake._behaviour[f"https://old{i}.test/f"] = SegmentPass()
    fake.stamps[moved] = "4:t4"
    fake.calls.clear()
    await sync_source(src, now=NOW + timedelta(seconds=180), budget=5)
    assert fake.calls[0] == moved and len(fake.calls) == 2, f"news plus one backlog stream, got {fake.calls}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_failed_stream_is_retried_whatever_its_listing_token_says():
    src = await _source()
    key = "https://flaky.test/f"
    fake = _FakeType([], {key: SourceError.transient("network", "boom")}, stamps={key: "1:t1"})
    register_driver(fake)

    await sync_source(src, now=NOW, budget=1)
    fake.calls.clear()
    await sync_source(src, now=NOW + timedelta(seconds=60), budget=1)
    assert fake.calls == [key], "an unchanged token does not excuse a stream that never succeeded"
