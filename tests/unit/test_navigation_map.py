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
from flow_sdk.core.navigation import DATASET

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

PROJECT = "project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
ASSET = "markdown-0d5e6f7a-8b9c-4d4e-8f5a-6b7c8d9e0f1a"
PROCESS = "agentic_process-7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"


@pytest.mark.skipif(not DATASET.is_dir(), reason=f"SmartNavigator dataset not at {DATASET}")
def test_every_screen_is_a_place_and_the_snapshot_is_the_map():
    """``navigation_map()`` validates every row as ``navigation.place``; drift from ``map.json``
    means the dataset shows a map the navigator no longer uses -- rerun scripts/navigation_map.py."""
    live = navigation_map().model_dump(mode="json")
    assert {p["view"] for p in live["places"]} >= {"home", "data-sources", "assets", "credentials"}
    assert json.loads((DATASET / "map.json").read_text()) == live


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
    on_process = await here_from(
        _ctx(f"/dock/agentic_process/{PROCESS[len('agentic_process-') :]}", CurrentProcessTypeId=PROCESS)
    )
    assert on_process.process.typeid == PROCESS
    on_home = await here_from(_ctx("/", CurrentProcessTypeId=PROCESS))
    assert (on_home.view, on_home.process) == ("home", None)


async def test_here_falls_back_to_the_pathname_and_names_the_hub_page():
    here = await here_from({"CurrentPathname": "/dock/hub/llm-endpoints"})
    assert (here.view, here.page, here.project) == ("llm-endpoints", "hub", None)


async def test_here_names_the_project_by_its_own_id_when_the_tab_sends_an_alias(tmp_path):
    # A tab on some screens sends ``project-@local``; an address built from that alias opens
    # nothing (``project/@local/collaboration_room/...``), and the recent session is looked up
    # under the project's real id.
    from flow_sdk.builtin.project import Project

    project = await Project(name=str(tmp_path / "aliased"), uname="local").save()
    here = await here_from({"CurrentUrl": "/dock/stream_inbox", "CurrentProjectTypeId": "project-@local"}, navigator=True)
    assert here.project.typeid == f"project-{project.id}"


async def test_a_list_of_a_type_is_a_place_not_an_open_entity():
    # The tab's active entity outlives the screen that set it; on a type's list it names nothing.
    on_list = await here_from(_ctx("/dock/assets/list/task", CurrentActiveEntityTypeId=ASSET))
    assert (on_list.view, on_list.pointer, on_list.entity) == ("assets", "list/task", None)


async def test_the_address_names_what_is_open_whatever_the_tab_last_set():
    # ``?trigger=<id>`` is that trigger, even when the tab's active-entity slot still holds an asset
    # from the screen before; the trigger's log is then an opening.
    trigger = "trigger-4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b"
    here = await here_from(_ctx(f"/dock/automations?trigger={trigger.partition('-')[2]}", CurrentActiveEntityTypeId=ASSET))
    assert here.entity.typeid == trigger
    options = navigator.options_for(here, [])
    assert f"view:lens/trigger/log/{trigger.partition('-')[2]}" in options


async def test_a_transcript_is_its_session_and_opens_the_sessions_todo_list_and_plan():
    import uuid

    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.flowpad_types.enums import WorkerType

    session = str(uuid.uuid4())
    process = await AgenticProcess(
        id=str(uuid.uuid4()), session_id=session, worker_type=WorkerType.CLAUDE_CODE, plan_path="/tmp/plans/split-auth.md"
    ).save()
    here = await here_from(_ctx(f"/dock/lens/claude/transcript/{session}"), navigator=True)
    assert here.process.typeid == f"agentic_process-{process.id}"
    options = navigator.options_for(here, [])
    assert f"view:agentic_process/{process.id}" in options or f"entity:agentic_process-{process.id}" in options
    assert f"view:lens/claude/tasks/{session}" in options and "view:plan/vfs/tmp/plans/split-auth.md" in options


async def test_a_data_source_page_offers_its_tabs_and_its_drivers_page():
    from flow_sdk.builtin.data_source import DataSource

    source = DataSource(name="Hacker News RSS", provider="rss")
    here = await here_from(_ctx(f"/dock/data-sources/{source.id}"))
    assert here.entity.typeid == f"data_source-{source.id}"
    # Its driver comes from the row (``_ref``); this source is not saved, so it is set as the row would.
    options = navigator.options_for(here.model_copy(update={"entity": here.entity.model_copy(update={"provider": "rss"})}), [])
    for pointer in (f"{source.id}/messages", f"{source.id}/settings", "drivers/rss"):
        assert f"view:data-sources/{pointer}" in options


async def test_a_screens_filter_is_offered_on_top_of_the_current_one():
    trigger = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b"
    here = await here_from(_ctx(f"/dock/automations/runs?trigger={trigger}&viewMode=standard"))
    options = navigator.options_for(here, [])
    assert f"view:automations/runs?status=failed&trigger={trigger}" in options
    assert not any("viewMode" in k for k in options), "how the tab is shown is not a filter"
    assert not any("trigger=" in k for k in navigator.options_for(await here_from(_ctx("/dock/automations/runs")), [])), "nothing to carry, nothing added"
    on_its_page = navigator.options_for(await here_from(_ctx(f"/dock/automations?trigger={trigger}")), [])
    assert not any("creating=" in k and "trigger=" in k for k in on_its_page), "a mode of the screen is no filter of it"
