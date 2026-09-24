"""Keep-alive — a hub sandbox reports "in use" once a minute, and only when it is.

"In use" is a person's input in the UI during the last minute, or an agent turn in
flight. An open tab nobody touches is not; that is the box that should pause.
"""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from flow_sdk.builtin.agentic_process import agentic_process
from flow_sdk.compute import keep_alive
from flow_sdk.instance_settings import runtime

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

NODE_ID = "00000000-0000-4000-8000-0000000000aa"
NODE = f"compute_node-{NODE_ID}"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(keep_alive, "_last_user_activity", None)
    monkeypatch.setattr(agentic_process, "_PROMPT_ADMISSIONS", {})
    monkeypatch.setattr(agentic_process, "_PROMPT_WORKERS", {})
    monkeypatch.setattr(agentic_process, "_PROMPT_LOCKS", {})


@pytest.fixture
def hub(monkeypatch):
    """The node the hub assigned, and a recorder in place of the hub."""
    sent: list = []

    async def _hub_post(entity_type, payload, entity_id=None, action=None, **_):
        sent.append((entity_type, entity_id, action))
        return {}

    monkeypatch.setattr(runtime.app_config, "get_config", lambda key: NODE if key == "compute_node_typeid" else None)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", _hub_post)
    return sent


async def test_an_untouched_machine_sends_nothing(hub):
    assert await keep_alive.send_keep_alive_if_in_use() is False
    assert hub == []


async def test_a_person_acting_in_the_ui_keeps_the_machine_alive(hub):
    keep_alive.note_user_activity()

    assert await keep_alive.send_keep_alive_if_in_use() is True
    assert hub == [("compute_node", NODE_ID, "keep-alive")]


def test_activity_older_than_a_minute_no_longer_counts():
    keep_alive.note_user_activity()
    later = time.monotonic() + keep_alive.KEEP_ALIVE_INTERVAL_S + 1

    assert keep_alive.is_in_use(now=later) is False


async def test_an_agent_turn_in_flight_keeps_the_machine_alive(hub, monkeypatch):
    """An agent working unattended must not be frozen mid-turn because nobody is watching."""
    agentic_process._PROMPT_WORKERS["proc-1"] = object()

    assert await keep_alive.send_keep_alive_if_in_use() is True
    assert hub == [("compute_node", NODE_ID, "keep-alive")]


async def test_a_held_prompt_lock_counts_as_a_turn_in_flight():
    import asyncio

    lock = asyncio.Lock()
    agentic_process._PROMPT_LOCKS["proc-1"] = lock
    assert agentic_process.any_prompt_in_flight() is False
    async with lock:
        assert agentic_process.any_prompt_in_flight() is True


async def test_an_instance_the_hub_never_assigned_never_reports(monkeypatch):
    """A desktop install has no node id, so there is nobody to report to."""
    monkeypatch.setattr(runtime.app_config, "get_config", lambda key: None)
    keep_alive.note_user_activity()

    with patch("flow_sdk.cloud_client.transport.hub_http.hub_post") as hub_post:
        assert await keep_alive.send_keep_alive_if_in_use() is False
    hub_post.assert_not_called()


async def test_the_ui_action_records_the_moment():
    """The UI reports input as the `keep-alive` action on the instance's ComputeNode."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    resp = await ComputeNode(name="box").keep_alive_action()

    assert resp.status == "SUCCESS"
    assert keep_alive.is_in_use() is True


@pytest.mark.parametrize("bad", ["", "compute_node-nope", "user-00000000-0000-4000-8000-0000000000aa"])
def test_only_a_compute_node_typeid_is_accepted(bad, monkeypatch):
    monkeypatch.setattr(runtime.app_config, "set_config", lambda *a: pytest.fail("must not persist"))
    with pytest.raises(ValueError):
        runtime.set_assigned_compute_node(bad)


def test_the_assigned_node_round_trips(monkeypatch):
    stored: dict = {}
    monkeypatch.setattr(runtime.app_config, "set_config", lambda k, v: stored.__setitem__(k, v))
    monkeypatch.setattr(runtime.app_config, "get_config", lambda k: stored.get(k))

    runtime.set_assigned_compute_node(NODE)

    assert runtime.get_assigned_compute_node() == NODE
