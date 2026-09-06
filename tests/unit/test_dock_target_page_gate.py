"""A hub-only view asked for on the desk page must error, not answer with Home.

`/dock/organization` parses fine, but only `renderHubBody` has a case for it, so the
desk content panel falls through to `default: <HomeLanding/>`: the request succeeds
and the user gets a different screen. Same class as the screen-vocabulary bug this
sits beside — a valid address that silently opens something else.
"""

import pytest

from flow_sdk.core.display_target import InvalidDisplayTarget, dock_target


@pytest.mark.asyncio
async def test_a_hub_only_view_is_rejected_on_the_desk_page():
    with pytest.raises(InvalidDisplayTarget) as excinfo:
        await dock_target("organization")
    assert "hub/organization" in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_desk_view_is_rejected_on_the_hub_page():
    with pytest.raises(InvalidDisplayTarget) as excinfo:
        await dock_target("hub/events")
    # `desk` is never emitted, so the advice must be the BARE form — `desk/events`
    # would be re-parsed with `desk` as the viewType.
    assert "Address it as 'events'." in str(excinfo.value)


@pytest.mark.asyncio
async def test_the_suggested_address_actually_resolves():
    """An error that names a fix is only useful if the fix works."""
    assert (await dock_target("hub/organization"))["page"] == "hub"
    assert (await dock_target("events"))["view_type"] == "events"


@pytest.mark.asyncio
@pytest.mark.parametrize("address", ["credentials", "hub/credentials", "assets", "hub/assets"])
async def test_views_that_render_on_both_pages_are_accepted_either_way(address):
    assert (await dock_target(address))["view_type"] in {"credentials", "assets"}
