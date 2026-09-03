"""The sync loop: per-stream isolation, records-before-cursor, and the budget.

Plus the abstraction gate — a grep, deliberately. The cursor's ``state`` dict is
opaque by contract, and the only way that contract survives adding providers is
if a leak is mechanically detectable. A reviewer will not notice
``cursor.state["etag"]`` appearing in sync.py; this test will.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.ingest.driver import IngestDriver, FetchResult, SegmentRef, register_driver
from flow_sdk.ingest.health import SourceError, SourceHealth
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.sync import sync_source

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)

#: Provider-private state keys. None of these may appear outside drivers/.
_PROVIDER_STATE_KEYS = ("etag", "last_modified", "last_update_ptr", "oldest_ts", "boundary_ids")


def test_cursor_state_is_opaque_to_the_subsystem():
    """No provider-private state key may be read outside ``ingest/drivers/``."""
    root = Path(__file__).resolve().parents[2] / "flow_sdk" / "ingest"
    offenders: list[str] = []

    for path in root.rglob("*.py"):
        if "drivers" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        # Strip comments and docstrings-by-line so prose explaining the rule
        # (this file's own subject) does not trip it.
        code = "\n".join(
            line for line in text.splitlines() if not line.lstrip().startswith("#")
        )
        for key in _PROVIDER_STATE_KEYS:
            if re.search(rf"""["']{key}["']""", code):
                offenders.append(f"{path.relative_to(root.parent.parent)} references {key!r}")

    assert not offenders, (
        "provider-private cursor state leaked out of drivers/:\n  "
        + "\n  ".join(offenders)
        + "\n\nThe sync loop must carry `state` without reading it, or the next "
        "provider will need a special case."
    )


class _FakeDriver(IngestDriver):
    """A driver whose behaviour each test dictates per stream."""

    provider = "faketest"
    kind = "datasource.feed.faketest"
    record_kind = "content.feed.item"

    def __init__(self, streams, behaviour):
        self._streams = streams
        self._behaviour = behaviour
        self.calls: list[str] = []

    async def segments(self, source):
        return [SegmentRef(key=k, label=k) for k in self._streams]

    async def fetch(self, source, cursor):
        self.calls.append(cursor.segment_key)
        outcome = self._behaviour[cursor.segment_key]
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
    account = f"acct-{uuid.uuid4().hex[:8]}"
    fields = {"provider": "faketest", "account_key": account, "name": "fake"}
    fields.update(kw)
    src = DataSource(
        **fields,
    )
    await src.save()
    return src


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_one_failing_stream_does_not_stall_its_siblings():
    src = await _source()
    good, bad = "https://good.test/f", "https://bad.test/f"
    driver = _FakeDriver(
        [good, bad],
        {
            good: FetchResult(
                items=[_item(src.id, good, 1)], next_state={"cursor": "1"}, high_water="1"
            ),
            bad: SourceError.transient("server_error", "HTTP 503"),
        },
    )
    register_driver(driver)

    report = await sync_source(src, now=NOW, budget=10)
    assert report.created == 1, "the healthy stream must still ingest"

    good_cursor = await DataSourceCursor.ensure_for(src.id, good)
    bad_cursor = await DataSourceCursor.ensure_for(src.id, bad)

    assert good_cursor.high_water == "1" and good_cursor.health == SourceHealth.OK.value
    assert bad_cursor.high_water is None, (
        "a failed stream advanced its cursor — the window it never read is now lost"
    )
    assert bad_cursor.health == SourceHealth.TRANSIENT_ERROR.value
    assert bad_cursor.consecutive_failures == 1

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.TRANSIENT_ERROR.value, "worst-of rollup"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_rollup_records_the_segment_count():
    """So a list can show it without watching the cursor table.

    Cursors are written once per stream per poll — the highest-churn rows on the
    instance. A UI that subscribes to them live just to render a COUNT repaints
    on every tick for a number that only moves when a stream is added or
    removed. `_roll_up` already holds the cursors and already saves this row, so
    carrying the count costs nothing.
    """
    src = await _source()
    feeds = ["https://a.test/f", "https://b.test/f", "https://c.test/f"]
    register_driver(_FakeDriver(feeds, {f: FetchResult(items=[]) for f in feeds}))

    await sync_source(src, now=NOW, budget=1)

    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.segment_count == 3, (
        "the count must cover every stream the driver declares, not just the "
        f"budgeted slice fetched this run (got {refreshed.segment_count})"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unchanged_result_advances_nothing_and_ingests_nothing():
    src = await _source()
    key = "https://static.test/f"
    driver = _FakeDriver(
        [key], {key: FetchResult(items=[], next_state={"opaque": "kept"}, unchanged=True)}
    )
    register_driver(driver)

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert cursor.health == SourceHealth.OK.value
    assert cursor.state == {"opaque": "kept"}, "driver state must be carried verbatim"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_budget_round_robins_the_longest_waiting_streams():
    src = await _source()
    keys = [f"https://s{i}.test/f" for i in range(4)]
    driver = _FakeDriver(keys, {k: FetchResult(items=[], next_state={}) for k in keys})
    register_driver(driver)

    # Two streams already attempted recently; two never attempted.
    for i, k in enumerate(keys[:2]):
        c = await DataSourceCursor.ensure_for(src.id, k)
        c.last_attempted_at = NOW - timedelta(seconds=10)
        await c.save()

    driver.calls.clear()
    await sync_source(src, now=NOW, budget=2)

    assert set(driver.calls) == set(keys[2:]), (
        f"budget spent on {driver.calls}; never-attempted streams must go first"
    )


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
    driver = _FakeDriver([key], {key: SourceError.transient("server_error", "boom")})
    register_driver(driver)

    await sync_source(src, now=NOW)
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.next_poll_at is not None, "a failed run must still reschedule"
    assert refreshed.is_due(NOW) is False
    assert refreshed.is_due(NOW + timedelta(seconds=121)) is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_parked_segment_does_not_park_the_source(monkeypatch):
    """One `config_error` stream is parked on ITS row; its siblings keep polling.

    `poll_refusal` refuses a `config_error` SOURCE, so rolling one bad channel up
    to the source used to stop every healthy sibling — the opposite of the
    per-stream isolation this module promises.
    """
    src = await _source()
    good, parked = "https://good.test/f", "https://gone.test/f"
    driver = _FakeDriver(
        [good, parked],
        {
            good: FetchResult(items=[], next_state={"n": "1"}, high_water="1"),
            parked: SourceError.config("not_found", "HTTP 404"),
        },
    )
    register_driver(driver)

    await sync_source(src, now=NOW, budget=10)
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.OK.value, (
        f"one parked segment parked the whole source ({refreshed.health})"
    )
    assert refreshed.poll_refusal() == "", "the healthy sibling must keep polling"
    assert refreshed.error_code == "not_found", "the card must still name the parked segment"

    # Second run: the parked stream is not a candidate; only the sibling runs.
    driver.calls.clear()
    await sync_source(refreshed, now=NOW + timedelta(minutes=1), budget=10)
    assert driver.calls == [good], f"a parked stream was re-polled: {driver.calls}"
    parked_cursor = await DataSourceCursor.ensure_for(src.id, parked)
    assert parked_cursor.health == SourceHealth.CONFIG_ERROR.value

    # When NOTHING is left to run, the source itself is parked.
    register_driver(_FakeDriver([parked], {parked: SourceError.config("not_found", "HTTP 404")}))
    only = await _source()
    await sync_source(only, now=NOW, budget=10)
    assert (await DataSource.get_one({"id": only.id})).health == SourceHealth.CONFIG_ERROR.value


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_refs_under_record_mode_are_a_config_error_not_a_silent_drop():
    """A driver that places files has no record destination; `record` used to
    log a warning, drop the files, and advance the cursor past them.

    Refused BEFORE any segment is fetched: `reflect` is a property of the
    source, so learning it from a fetch would cost one round trip per segment
    to discover the same config fact."""
    src = await _source(reflect="record")
    key = "root"
    driver = _FakeDriver([key], {key: FetchResult(refs=["a.md"], next_state={"seen": "1"}, high_water="1")})
    driver.origin_for = lambda _s: None  # a file-placing driver
    register_driver(driver)

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []
    assert driver.calls == [], "the config fact was knowable without fetching"

    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert cursor.state == {} and cursor.high_water is None, "the cursor advanced past dropped files"
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.CONFIG_ERROR.value
    assert refreshed.error_code == "reflect_mode"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_write_failure_is_classified_and_leaves_the_cursor_put(monkeypatch):
    """`ingest_items` raising used to escape `sync_source` entirely: no health,
    no roll-up, and the poller logging it as a bug."""
    import flow_sdk.ingest.sync as sync_mod

    async def _boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(sync_mod, "ingest_items", _boom)
    src = await _source(poll_interval_seconds=120)
    key = "https://w.test/f"
    register_driver(
        _FakeDriver([key], {key: FetchResult(items=[_item(src.id, key, 1)], next_state={"n": "1"}, high_water="1")})
    )

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    cursor = await DataSourceCursor.ensure_for(src.id, key)
    assert cursor.health == SourceHealth.TRANSIENT_ERROR.value
    assert cursor.error_code == "RuntimeError"
    assert cursor.consecutive_failures == 1
    assert cursor.state == {} and cursor.high_water is None, "records were not committed; the cursor must not move"
    refreshed = await DataSource.get_one({"id": src.id})
    assert refreshed.health == SourceHealth.TRANSIENT_ERROR.value, "roll-up must still run"
    assert refreshed.next_poll_at is not None and refreshed.is_due(NOW + timedelta(seconds=121))
