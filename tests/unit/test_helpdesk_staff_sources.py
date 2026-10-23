"""A desk's staff get its help-desk source on login — a ticket reaches staff only through it."""

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk
from flow_sdk.stream_inbox.catchup import ensure_driver_sources


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_each_staffed_desk_gets_one_source_and_a_plain_project_none():
    desk, plain = mint_uuid(), mint_uuid()
    rows = [
        {"id": desk, "name": "Desk", "helpdesk": {"enabled": True, "display_name": "Acme Support"}},
        {"id": plain, "name": "Plain", "helpdesk": None},
    ]
    await DataDriver.get("helpdesk")
    with patch.object(HubProxy, "walk", new=AsyncMock(return_value=HubWalk(rows=rows, complete=True))):
        first = await ensure_driver_sources("test")
        again = await ensure_driver_sources("test")

    assert (first, again) == (1, 0)
    made = await DataSource.find_for_account("helpdesk", "desk_project_id", desk)
    assert made is not None and made.name == "Acme Support"
    assert await DataSource.find_for_account("helpdesk", "desk_project_id", plain) is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_incomplete_hub_answer_makes_nothing():
    await DataDriver.get("helpdesk")
    rows = [{"id": mint_uuid(), "helpdesk": {"enabled": True}}]
    with patch.object(HubProxy, "walk", new=AsyncMock(return_value=HubWalk(rows=rows, complete=False))):
        assert await ensure_driver_sources("test") == 0
