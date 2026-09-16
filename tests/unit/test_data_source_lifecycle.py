"""Status is a lifecycle, health is a verdict — and they must not be conflated.

`status` answers "should this be running", `health` answers "is it working". The state this pair
exists for is a Slack source whose bot has not been invited yet: nobody disabled it, and it would
fetch nothing if polled. That is neither `enabled=False` nor `config_error`, and the old boolean
could not say it.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.ingest.driver_types import DriverType, register_driver
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.sources.base import Source
from flow_sdk.sources.protocols import Verdict

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _NeedsSetup(Source):
    provider = "needs-setup-test"
    verdict = Verdict(ready=False, detail="invite the bot", pending=("C1",))

    async def verify(self) -> Verdict:
        return type(self).verdict


class _NoSetup(Source):
    provider = "no-setup-test"


@pytest.fixture
def sources():
    register_driver(DriverType(_NeedsSetup, kind="datasource.test.setup"))
    register_driver(DriverType(_NoSetup, kind="datasource.test.plain"))
    return _NeedsSetup, _NoSetup


async def _source(**kw) -> DataSource:
    base = dict(name="lifecycle", account_key=f"a-{uuid.uuid4().hex[:6]}")
    base.update(kw)
    src = DataSource(**base)
    await src.save()
    return src


async def test_a_source_with_a_setup_step_starts_in_setup(sources):
    src = await _source(provider="needs-setup-test")
    assert src.status == SourceStatus.SETUP.value
    assert src.setup_detail, "SETUP with no explanation is a dead end for the user"
    assert src.is_due() is False


async def test_a_source_with_no_setup_step_is_active_immediately(sources):
    """A plain RSS feed must not demand a Verify click it has no use for."""
    src = await _source(provider="no-setup-test")
    assert src.status == SourceStatus.ACTIVE.value
    assert src.is_due() is True


async def test_an_unknown_provider_stays_visible_rather_than_parked():
    """ACTIVE on purpose: the poller then reaches `sync_source`, which reports `unknown_provider` as
    a config_error the card can explain. Left in NEW it would sit silently forever."""
    src = await _source(provider="no-such-driver")
    assert src.status == SourceStatus.ACTIVE.value


async def test_verify_moves_a_ready_source_to_active(sources, monkeypatch):
    needs_setup, _ = sources
    src = await _source(provider="needs-setup-test")
    monkeypatch.setattr(needs_setup, "verdict", Verdict(ready=True, detail="reading 2 channels"))

    result = await src.verify_action()

    assert result.data["ready"] is True
    assert src.status == SourceStatus.ACTIVE.value
    assert src.setup_detail == "", "a resolved setup must not leave stale instructions"
    assert src.next_poll_at is None, "the user just finished setup and is watching"
    assert src.verified_at is not None


async def test_verify_keeps_an_unready_source_in_setup_and_says_why(sources, monkeypatch):
    needs_setup, _ = sources
    src = await _source(provider="needs-setup-test")
    monkeypatch.setattr(needs_setup, "verdict", Verdict(ready=False, detail="Invite the bot to #eng.", pending=("C9",)))

    result = await src.verify_action()

    assert result.data["ready"] is False
    assert result.data["pending"] == ["C9"]
    assert src.status == SourceStatus.SETUP.value
    assert "#eng" in src.setup_detail
    assert src.is_due() is False, "an unverified source must never be polled"


async def test_a_source_that_raises_during_verify_does_not_break_the_button(sources, monkeypatch):
    needs_setup, _ = sources

    async def _boom(self):
        raise RuntimeError("slack exploded")

    monkeypatch.setattr(needs_setup, "verify", _boom)
    src = await _source(provider="needs-setup-test")

    result = await src.verify_action()

    assert result.data["ready"] is False
    assert "slack exploded" in src.setup_detail
    assert src.status == SourceStatus.SETUP.value


async def test_status_and_health_are_independent_axes(sources):
    """A paused source is not unhealthy, and an unhealthy one is not paused."""
    src = await _source(provider="no-setup-test")
    src.status = SourceStatus.DISABLED.value
    await src.save()

    assert src.health == SourceHealth.NEVER_SYNCED.value, "pausing a source must not be recorded as a health problem"
    assert src.is_due() is False


async def test_legacy_rows_keep_the_pause_their_owner_set():
    """The one migration outcome worse than an error is a source someone deliberately paused
    quietly coming back."""
    assert DataSource.model_validate({"name": "x", "provider": "rss", "enabled": False}).status == SourceStatus.DISABLED.value
    assert DataSource.model_validate({"name": "x", "provider": "rss", "enabled": True}).status == SourceStatus.ACTIVE.value
