"""``data_driver/{id}/profile`` — a driver group's setup phase shows each way of connecting as a live card.

``Source.profile()`` answers it (who answers, on what number, whether it is available here); a driver with
none answers ``{}``, and one that cannot answer says why instead of failing the whole picker.
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_driver import DataDriver

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _driver(request, profile=None, **fields) -> DataDriver:
    from flow_sdk.ingest.driver_runtime import DRIVERS
    from flow_sdk.sources.families import RecordSource

    name = f"stub-{mint_uuid()[:8]}"
    body = {"provider": name}
    if profile is not None:
        body["profile"] = classmethod(lambda cls: profile())
    cls = type(f"_Stub_{name}", (RecordSource,), body)
    driver = DataDriver.for_class(cls, kind="datasource.test.stub", **fields)
    DRIVERS.register(driver)
    request.addfinalizer(lambda: DRIVERS.unregister(name))
    return driver


async def test_a_driver_shows_its_live_profile(request):
    async def profile():
        return {"available": True, "name": "Flow", "number": "+1 555 0100"}

    driver = _driver(request, profile, group="WhatsApp", group_order=0)
    answer = await driver.profile_action()
    assert answer.data == {"available": True, "name": "Flow", "number": "+1 555 0100"}
    assert (driver.group, driver.group_order) == ("WhatsApp", 0)


async def test_no_profile_is_an_empty_card_and_a_failing_one_says_why(request):
    assert (await _driver(request).profile_action()).data == {}

    async def broken():
        raise RuntimeError("hub unreachable")

    answer = await _driver(request, broken).profile_action()
    assert answer.data["available"] is False and "hub unreachable" in answer.data["detail"]
