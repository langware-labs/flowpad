"""A push-only source (a webhook is its only delivery) finds nothing on a poll, so its poll proves the delivery path
instead: the same ``DataSource.verify`` as the Verify button, so "not set up" lives in one place — the row's status.
Not set up any more moves it to setup (with why); a provider that did not answer is a transient failure that leaves
the status alone."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.sources.errors import SourceUnavailable
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.protocols import Verdict

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def pushed(request):
    """A registered push-only driver whose ``verify`` answers what the test says (a Verdict, or an exception)."""
    from flow_sdk.ingest.driver_runtime import DRIVERS

    state = SimpleNamespace(answer=Verdict(ready=True), name=f"pushed-{mint_uuid()[:8]}")

    class _Pushed(MessageSource):
        provider = state.name

        async def verify(self) -> Verdict:
            if isinstance(state.answer, Exception):
                raise state.answer
            return state.answer

    DRIVERS.register(DataDriver.for_class(_Pushed, kind="datasource.test.pushed"))
    request.addfinalizer(lambda: DRIVERS.unregister(state.name))
    return state


async def _live(provider: str) -> DataSource:
    source = DataSource(provider=provider, name=f"live {mint_uuid()[:8]}", account_key=mint_uuid())
    await source.save()
    source.status = SourceStatus.ACTIVE.value
    await source.save_runtime()
    return source


async def test_a_set_up_push_only_source_stays_live_after_its_poll(pushed):
    source = await _live(pushed.name)
    await sync_source(source, now=NOW)
    again = await DataSource.get_one({"id": source.id})
    assert again.status == SourceStatus.ACTIVE.value and again.health != SourceHealth.CONFIG_ERROR.value


async def test_a_push_only_source_no_longer_set_up_moves_to_setup_with_why(pushed):
    source = await _live(pushed.name)
    pushed.answer = Verdict(ready=False, detail="Press Connect WhatsApp first.")
    await sync_source(source, now=NOW)
    again = await DataSource.get_one({"id": source.id})
    assert (again.status, again.setup_detail) == (SourceStatus.SETUP.value, "Press Connect WhatsApp first.")


async def test_a_provider_that_did_not_answer_leaves_the_status_and_is_retried(pushed):
    source = await _live(pushed.name)
    pushed.answer = SourceUnavailable("the hub did not answer: Internal server error")
    await sync_source(source, now=NOW)
    again = await DataSource.get_one({"id": source.id})
    assert again.status == SourceStatus.ACTIVE.value and again.health == SourceHealth.TRANSIENT_ERROR.value


async def test_an_answer_after_an_outage_clears_the_outage_even_when_it_is_no(pushed):
    source = await _live(pushed.name)
    pushed.answer = SourceUnavailable("the hub did not answer")
    await sync_source(source, now=NOW)
    pushed.answer = Verdict(ready=False, detail="Press Connect WhatsApp first.")
    await sync_source(source, now=NOW)
    again = await DataSource.get_one({"id": source.id})
    assert again.status == SourceStatus.SETUP.value and again.health == SourceHealth.OK.value and not again.error_detail
