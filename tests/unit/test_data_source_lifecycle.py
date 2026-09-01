"""Status is a lifecycle, health is a verdict — and they must not be conflated.

`status` answers "should this be running", `health` answers "is it working".
The state this pair exists for is a Slack source whose bot has not been invited
yet: nobody disabled it, and it would fetch nothing if polled. That is neither
`enabled=False` nor `config_error`, and the old boolean could not say it.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.ingest.driver import IngestDriver, SetupVerdict, register_driver
from flow_sdk.ingest.health import SourceHealth

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _NeedsSetupDriver(IngestDriver):
    provider = "needs-setup-test"
    kind = "datasource.test.setup"
    record_kind = "content.message.chat"
    verdict = SetupVerdict.waiting("invite the bot", ("C1",))

    async def segments(self, source):
        return []

    async def fetch(self, source, cursor):  # pragma: no cover - never reached here
        raise AssertionError("fetch must not run for a source still in setup")

    async def verify(self, source):
        return self.verdict


class _NoSetupDriver(IngestDriver):
    provider = "no-setup-test"
    kind = "datasource.test.plain"
    record_kind = "content.feed.item"

    async def segments(self, source):
        return []

    async def fetch(self, source, cursor):  # pragma: no cover
        raise AssertionError("not used")


@pytest.fixture
def drivers():
    register_driver(_NeedsSetupDriver())
    register_driver(_NoSetupDriver())
    return _NeedsSetupDriver, _NoSetupDriver


async def _source(**kw) -> DataSource:
    base = dict(name="lifecycle", account_key=f"a-{uuid.uuid4().hex[:6]}")
    base.update(kw)
    src = DataSource(**base)
    await src.save()
    return src


async def test_a_driver_with_a_setup_step_starts_in_setup(drivers):
    src = await _source(provider="needs-setup-test")
    assert src.status == SourceStatus.SETUP.value
    assert src.setup_detail, "SETUP with no explanation is a dead end for the user"
    assert src.is_due() is False


async def test_a_driver_with_no_setup_step_is_active_immediately(drivers):
    """A plain RSS feed must not demand a Verify click it has no use for."""
    src = await _source(provider="no-setup-test")
    assert src.status == SourceStatus.ACTIVE.value
    assert src.is_due() is True


async def test_an_unknown_provider_stays_visible_rather_than_parked():
    """ACTIVE on purpose: the poller then reaches `sync_source`, which reports
    `unknown_provider` as a config_error the card can explain. Left in NEW it
    would sit silently forever."""
    src = await _source(provider="no-such-driver")
    assert src.status == SourceStatus.ACTIVE.value


async def test_verify_moves_a_ready_source_to_active(drivers, monkeypatch):
    needs_setup, _ = drivers
    src = await _source(provider="needs-setup-test")
    monkeypatch.setattr(needs_setup, "verdict", SetupVerdict.ok("reading 2 channels"))

    result = await src.verify_action()

    assert result.data["ready"] is True
    assert src.status == SourceStatus.ACTIVE.value
    assert src.setup_detail == "", "a resolved setup must not leave stale instructions"
    assert src.next_poll_at is None, "the user just finished setup and is watching"
    assert src.verified_at is not None


async def test_verify_keeps_an_unready_source_in_setup_and_says_why(drivers, monkeypatch):
    needs_setup, _ = drivers
    src = await _source(provider="needs-setup-test")
    monkeypatch.setattr(
        needs_setup, "verdict", SetupVerdict.waiting("Invite the bot to #eng.", ("C9",))
    )

    result = await src.verify_action()

    assert result.data["ready"] is False
    assert result.data["pending"] == ["C9"]
    assert src.status == SourceStatus.SETUP.value
    assert "#eng" in src.setup_detail
    assert src.is_due() is False, "an unverified source must never be polled"


async def test_a_driver_that_raises_during_verify_does_not_break_the_button(drivers, monkeypatch):
    needs_setup, _ = drivers

    # Patched on the CLASS, so it is bound — it takes self as well as the source.
    async def _boom(self, _source):
        raise RuntimeError("slack exploded")

    monkeypatch.setattr(needs_setup, "verify", _boom)
    src = await _source(provider="needs-setup-test")

    result = await src.verify_action()

    assert result.data["ready"] is False
    assert "slack exploded" in src.setup_detail
    assert src.status == SourceStatus.SETUP.value


async def test_status_and_health_are_independent_axes(drivers):
    """A paused source is not unhealthy, and an unhealthy one is not paused."""
    src = await _source(provider="no-setup-test")
    src.status = SourceStatus.DISABLED.value
    await src.save()

    assert src.health == SourceHealth.NEVER_SYNCED.value, (
        "pausing a source must not be recorded as a health problem"
    )
    assert src.is_due() is False


async def test_legacy_rows_keep_the_pause_their_owner_set():
    """The one migration outcome worse than an error is a source someone
    deliberately paused quietly coming back."""
    assert DataSource.model_validate(
        {"name": "x", "provider": "rss", "enabled": False}
    ).status == SourceStatus.DISABLED.value
    assert DataSource.model_validate(
        {"name": "x", "provider": "rss", "enabled": True}
    ).status == SourceStatus.ACTIVE.value
