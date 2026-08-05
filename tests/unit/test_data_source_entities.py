"""DataSource + DataSourceCursor: due-selection, the window floor, health rollup.

These are the pieces the poller depends on being correct before it does any
network I/O at all, so they are tested with an injected clock and no sleeping.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.ingest.health import SourceError, SourceHealth, classify, worst_of

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


def _source(**kw) -> DataSource:
    base = dict(provider="rss", account_key=f"acct-{uuid.uuid4().hex[:8]}", name="Test feed")
    base.update(kw)
    return DataSource(**base)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_two_sources_may_serve_one_account():
    """Ids are uuid4 and `account_key` is descriptive, not a key.

    Whether a second poller on one account is worth its request cost is the
    operator's call — nothing in the entity, the create path or the UI form
    refuses it. Pinned because the previous design derived the id FROM the
    account, which made this impossible by construction.
    """
    account = f"acct-{uuid.uuid4().hex[:8]}"
    first = _source(account_key=account)
    second = _source(account_key=account)
    await first.save()
    await second.save()

    assert first.id != second.id
    both = await DataSource.get_all({"account_key": account})
    assert {s.id for s in both} == {first.id, second.id}


def test_due_selection():
    never_polled = _source()
    assert never_polled.is_due(NOW) is True, "a source that has never run is due"

    later = _source(next_poll_at=NOW + timedelta(seconds=30))
    assert later.is_due(NOW) is False

    ready = _source(next_poll_at=NOW - timedelta(seconds=1))
    assert ready.is_due(NOW) is True

    assert _source(enabled=False).is_due(NOW) is False

    # A config error needs a human; re-polling burns quota to re-learn it.
    broken = _source(health=SourceHealth.CONFIG_ERROR.value)
    assert broken.is_due(NOW) is False
    # ...but a transient one must keep trying at the ordinary cadence.
    flaky = _source(health=SourceHealth.TRANSIENT_ERROR.value)
    assert flaky.is_due(NOW) is True


def test_window_floor_defaults_to_seven_days():
    assert _source().window_floor(NOW) == NOW - timedelta(days=7)
    assert _source(window_days=1).window_floor(NOW) == NOW - timedelta(days=1)


def test_poll_interval_has_a_floor():
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        _source(poll_interval_seconds=5)


def test_health_rollup_is_worst_of():
    assert worst_of([]) is SourceHealth.NEVER_SYNCED
    assert worst_of([SourceHealth.OK, SourceHealth.OK]) is SourceHealth.OK
    assert worst_of([SourceHealth.OK, SourceHealth.TRANSIENT_ERROR]) is SourceHealth.TRANSIENT_ERROR
    # A config error outranks a transient one — it is the state needing a person.
    assert (
        worst_of([SourceHealth.TRANSIENT_ERROR, SourceHealth.CONFIG_ERROR])
        is SourceHealth.CONFIG_ERROR
    )
    assert worst_of([SourceHealth.OK, SourceHealth.NEVER_SYNCED]) is SourceHealth.NEVER_SYNCED


@pytest.mark.parametrize(
    "status,expected,code",
    [
        (401, SourceHealth.CONFIG_ERROR, "unauthorized"),
        (403, SourceHealth.CONFIG_ERROR, "unauthorized"),
        (404, SourceHealth.CONFIG_ERROR, "not_found"),
        (422, SourceHealth.CONFIG_ERROR, "client_error"),
        # Rate limiting is TRANSIENT. Read as permanent it would park the
        # source forever over a temporary throttle — the divergence that
        # existed while three drivers each kept their own copy of this table.
        (429, SourceHealth.TRANSIENT_ERROR, "rate_limited"),
        (500, SourceHealth.TRANSIENT_ERROR, "server_error"),
        (503, SourceHealth.TRANSIENT_ERROR, "server_error"),
    ],
)
def test_status_classification_has_one_table(status, expected, code):
    err = SourceError.for_status(status)
    assert err.health is expected, f"HTTP {status} classified {err.health}, expected {expected}"
    assert err.code == code
    # …and classify() must agree, since it is what sync.py actually calls.
    assert classify(err)[0] is expected


@pytest.mark.parametrize(
    "exc",
    [ConnectionResetError("reset"), TimeoutError("slow"), ValueError("something new")],
)
def test_unclassified_exceptions_are_transient(exc):
    health, _code, _detail = classify(exc)
    assert health is SourceHealth.TRANSIENT_ERROR, (
        "an unrecognised failure must not silently stop a working source"
    )


def test_source_error_carries_its_own_classification():
    health, code, detail = classify(SourceError.config("missing_scope", "needs channels:history"))
    assert health is SourceHealth.CONFIG_ERROR
    assert code == "missing_scope" and "channels:history" in detail


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_cursor_ensure_for_is_get_or_create_and_never_resets_position():
    ds_id = f"ds-{uuid.uuid4().hex[:8]}"

    first = await DataSourceCursor.ensure_for(ds_id, "https://a.test/feed", stream_label="A")
    first.high_water = "2026-07-30T00:00:00Z"
    first.state = {"etag": 'W/"abc"'}
    await first.save()

    again = await DataSourceCursor.ensure_for(ds_id, "https://a.test/feed", stream_label="A")
    assert again.id == first.id
    assert again.high_water == "2026-07-30T00:00:00Z", "re-declaring a stream reset its cursor"
    assert again.state == {"etag": 'W/"abc"'}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_cursors_are_independent_per_stream():
    ds_id = f"ds-{uuid.uuid4().hex[:8]}"
    a = await DataSourceCursor.ensure_for(ds_id, "https://a.test/feed")
    b = await DataSourceCursor.ensure_for(ds_id, "https://b.test/feed")
    assert a.id != b.id, "two streams of one source must not share a cursor row"
