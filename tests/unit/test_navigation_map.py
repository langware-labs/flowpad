"""The navigation map, and "you are here" -- the dataset's ``navigation.*`` kinds, filled from code.

The map is ``VIEW_META`` as ``navigation.place`` rows; ``map.json`` in the SmartNavigator dataset
is its snapshot for people browsing it. "Here" is a tab's ``browser_context`` keeping only the
context its screen provides -- the slots the UI leaves stale on other screens are dropped.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.core import navigator
from flow_sdk.core.navigation import here_from, navigation_map
from flow_sdk.core.navigator_eval import SHIPPED

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

PROJECT = "project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
ASSET = "markdown-0d5e6f7a-8b9c-4d4e-8f5a-6b7c8d9e0f1a"
PROCESS = "agentic_process-7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"


def test_every_screen_is_a_place_and_the_snapshot_is_the_map():
    """``navigation_map()`` validates every row as ``navigation.place``; drift from ``map.json``
    means the dataset shows a map the navigator no longer uses -- rerun scripts/navigation_map.py."""
    live = navigation_map().model_dump(mode="json")
    assert {p["view"] for p in live["places"]} >= {"home", "data-sources", "assets", "credentials"}
    assert json.loads((SHIPPED / "map.json").read_text()) == live


def test_the_navigator_offers_the_maps_places_and_subplaces_only():
    options, _ = navigator.static_options()
    assert "view:credentials/connections" in options and "view:hub/token-plan/me" in options
    assert "view:credentials/api-keys" not in options, "a tab that no longer renders is not a place"


def _ctx(url: str, **slots: str) -> dict:
    return {"CurrentUrl": url, "CurrentProjectTypeId": PROJECT, **slots}


async def test_here_keeps_the_open_entity_only_where_the_screen_provides_one():
    on_asset = await here_from(_ctx(f"/dock/assets/{ASSET}", CurrentActiveEntityTypeId=ASSET))
    assert (on_asset.view, on_asset.entity.typeid, on_asset.project.typeid) == ("assets", ASSET, PROJECT)
    on_events = await here_from(_ctx("/dock/automations?scope=project", CurrentActiveEntityTypeId=ASSET))
    assert (on_events.view, on_events.entity, on_events.project.typeid) == ("automations", None, PROJECT)
    assert on_events.address == "/dock/automations?scope=project", "the query rides along"


async def test_here_keeps_the_session_only_on_a_session_screen():
    on_process = await here_from(_ctx(f"/dock/agentic_process/{PROCESS[len('agentic_process-'):]}", CurrentProcessTypeId=PROCESS))
    assert on_process.process.typeid == PROCESS
    on_home = await here_from(_ctx("/", CurrentProcessTypeId=PROCESS))
    assert (on_home.view, on_home.process) == ("home", None)


async def test_here_falls_back_to_the_pathname_and_names_the_hub_page():
    here = await here_from({"CurrentPathname": "/dock/hub/llm-endpoints"})
    assert (here.view, here.page, here.project) == ("llm-endpoints", "hub", None)
