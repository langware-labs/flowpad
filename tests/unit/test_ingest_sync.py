"""The sync loop: one stream per source, records-before-cursor, and failure as health.

Plus the abstraction gate — a grep, deliberately. The cursor is opaque by contract, and the only way
that contract survives adding providers is if a leak is mechanically detectable. A reviewer will not
notice a provider's cursor key appearing in sync.py; this test will.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, ClassVar

import pytest
from pydantic import PrivateAttr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_runtime import Pass
from flow_sdk.ingest.health import SourceError, SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec
from flow_sdk.sources.base import Source

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)

#: Provider-private cursor keys. None of these may appear in the engine.
_PROVIDER_STATE_KEYS = ("etag", "last_modified", "last_update_ptr", "oldest_ts", "boundary_ids")


def test_cursor_state_is_opaque_to_the_subsystem():
    """No provider-private cursor key may be read in ``ingest/``: a cursor is the source's own string."""
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


class _FakeType(DataDriver):
    """A driver whose traversals each test dictates, one outcome per pass."""

    _abstract: ClassVar[bool] = True  # a test double, not a second registered type
    positions: list = []
    _outcomes: Any = PrivateAttr(None)
    _reflects: bool = PrivateAttr(False)

    def __init__(self, *outcomes, reflects: bool = False):
        super().__init__(name=_FakeSource.provider, kind="datasource.feed.faketest", positions=[])
        self._cls = _FakeSource
        self._outcomes, self._reflects = list(outcomes), reflects

    @property
    def reflects(self) -> bool:
        return self._reflects

    async def traverse(self, row, position=None):
        self.positions.append(position)
        outcome = self._outcomes.pop(0) if len(self._outcomes) > 1 else self._outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _item(data_source_id, n) -> SourceItemSpec:
    return SourceItemSpec(
        data_source_id=data_source_id,
        provider="faketest",
        kind="content.feed.item",
        external_id=f"item-{n}",
        name=f"item {n}",
        body=f"body {n}",
    )


async def _source(**kw) -> DataSource:
    fields = {"provider": "faketest", "account_key": f"acct-{uuid.uuid4().hex[:8]}", "name": f"fake {uuid.uuid4().hex[:8]}"}
    fields.update(kw)
    src = DataSource(**fields)
    await src.save()
    return src


async def _reread(src) -> DataSource:
    return await DataSource.get_one({"id": src.id})


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_good_pass_ingests_then_advances_the_position():
    src = await _source()
    DataDriver.register(_FakeType(Pass(items=[_item(src.id, 1)], cursor="c1", high_water="2026-07-31T11:00:00+00:00")))

    report = await sync_source(src, now=NOW)

    assert report.created == 1
    row = await _reread(src)
    assert (row.cursor, row.health, row.consecutive_failures) == ("c1", SourceHealth.OK.value, 0)
    assert row.high_water is not None and row.last_synced_at is not None


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_next_pass_starts_from_the_stored_cursor_and_manifest():
    src = await _source()
    fake = _FakeType(Pass(cursor="c1", manifest={"a.md": ["1", ""]}), Pass(cursor="c2"))
    DataDriver.register(fake)

    await sync_source(src, now=NOW)
    await sync_source(await _reread(src), now=NOW + timedelta(minutes=1))

    assert [p.cursor for p in fake.positions] == [None, "c1"]
    assert fake.positions[1].manifest == {"a.md": ["1", ""]}
    assert fake.positions[0].window_start == (NOW - timedelta(days=src.window_days)).isoformat()


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_failed_pass_leaves_the_position_and_counts_the_failure():
    src = await _source()
    DataDriver.register(_FakeType(Pass(cursor="c1"), SourceError.transient("server_error", "HTTP 503"), Pass(cursor="c2")))

    await sync_source(src, now=NOW)
    await sync_source(await _reread(src), now=NOW + timedelta(minutes=1))
    row = await _reread(src)
    assert row.cursor == "c1", "a failed pass moved the position — the window it never read is now lost"
    assert (row.health, row.error_code, row.consecutive_failures) == (SourceHealth.TRANSIENT_ERROR.value, "server_error", 1)

    await sync_source(row, now=NOW + timedelta(minutes=2))
    row = await _reread(src)
    assert (row.cursor, row.health, row.consecutive_failures) == ("c2", SourceHealth.OK.value, 0)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unchanged_result_carries_the_cursor_and_ingests_nothing():
    src = await _source()
    DataDriver.register(_FakeType(Pass(cursor="kept", unchanged=True)))

    report = await sync_source(src, now=NOW)

    assert report.outcomes == []
    row = await _reread(src)
    assert (row.cursor, row.health) == ("kept", SourceHealth.OK.value)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_idle_pass_on_a_healthy_source_writes_nothing(monkeypatch):
    src = await _source()
    DataDriver.register(_FakeType(Pass(cursor="kept", unchanged=True)))
    await sync_source(src, now=NOW)
    row = await _reread(src)

    writes = []
    original = DataSource.save_runtime

    async def _counting(self):
        writes.append(self.id)
        await original(self)

    monkeypatch.setattr(DataSource, "save_runtime", _counting)
    await sync_source(row, now=NOW + timedelta(minutes=1))

    assert writes == [], "the steady state is zero writes per tick"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unknown_provider_is_a_config_error_not_a_crash():
    src = await _source(provider="nosuchprovider")
    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    refreshed = await _reread(src)
    assert refreshed.health == SourceHealth.CONFIG_ERROR.value
    assert refreshed.error_code == "unknown_provider"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_next_poll_is_scheduled_even_when_the_pass_failed():
    src = await _source(poll_interval_seconds=120)
    DataDriver.register(_FakeType(SourceError.transient("server_error", "boom")))

    await sync_source(src, now=NOW)
    refreshed = await _reread(src)
    assert refreshed.next_poll_at is not None, "a failed run must still reschedule"
    assert refreshed.is_due(NOW) is False
    assert refreshed.is_due(NOW + timedelta(seconds=121)) is True


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_config_error_parks_the_source():
    src = await _source()
    DataDriver.register(_FakeType(SourceError.config("not_found", "HTTP 404")))

    await sync_source(src, now=NOW)

    refreshed = await _reread(src)
    assert (refreshed.health, refreshed.error_code) == (SourceHealth.CONFIG_ERROR.value, "not_found")
    assert refreshed.poll_refusal() != ""


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_refs_under_record_mode_are_a_config_error_not_a_silent_drop():
    """A reflecting source has no record destination; refused BEFORE traversing, because `reflect` is a
    property of the source."""
    src = await _source(reflect="record")
    fake = _FakeType(Pass(refs=["a.md"], manifest={"a.md": ["1", ""]}, high_water="1"), reflects=True)
    DataDriver.register(fake)

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []
    assert fake.positions == [], "the config fact was knowable without traversing"

    refreshed = await _reread(src)
    assert refreshed.manifest == {} and refreshed.high_water is None, "the position advanced past dropped files"
    assert (refreshed.health, refreshed.error_code) == (SourceHealth.CONFIG_ERROR.value, "reflect_mode")


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_write_failure_is_classified_and_leaves_the_cursor_put(monkeypatch):
    """`ingest_items` raising must not escape `sync_source`: health recorded, cursor unmoved."""
    import flow_sdk.ingest.sync as sync_mod

    async def _boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(sync_mod, "ingest_items", _boom)
    src = await _source(poll_interval_seconds=120)
    DataDriver.register(_FakeType(Pass(items=[_item(src.id, 1)], cursor="1", high_water="1")))

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    refreshed = await _reread(src)
    assert (refreshed.health, refreshed.error_code, refreshed.consecutive_failures) == (SourceHealth.TRANSIENT_ERROR.value, "RuntimeError", 1)
    assert refreshed.cursor is None and refreshed.high_water is None, "records were not committed; the cursor must not move"
    assert refreshed.next_poll_at is not None and refreshed.is_due(NOW + timedelta(seconds=121))
