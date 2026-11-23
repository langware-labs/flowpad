"""``ensure_node_strict``: the backend's "this machine's hub node", which never creates on a lookup it could not make.

The hub is a small scripted object handed in at the function's own seam (``hub=``).
"""

from __future__ import annotations

import pytest

from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.core.compute.hub_node import default_node_name, ensure_node_strict

MACHINE_ID = "b1ed31d45bb9" + "0" * 20
NODE_ID = "8c353ca8-8d88-40f9-8958-020255a952ef"


class ScriptedHub:
    """Answers the node list it was given (or raises it), creates a node on POST, and records every call."""

    def __init__(self, nodes):
        self.nodes = nodes
        self.calls: list[tuple] = []

    async def call(self, method, entity_type, entity_id=None, action=None, sub_path=None, *, payload=None):
        self.calls.append((method, str(getattr(entity_type, "value", entity_type)), entity_id, action, sub_path))
        if method == "GET":
            if isinstance(self.nodes, Exception):
                raise self.nodes
            return self.nodes
        if entity_id is None:
            return {"id": NODE_ID, "node_provider_id": None, **payload}
        return "ok"


def machine_node(machine_id: str, node_id: str, *, set_up: bool = True) -> dict:
    return {
        "id": node_id,
        "name": "@studio",
        "node_provider": "user_machine",
        "node_provider_id": node_id if set_up else None,
        "node_config": {"machine_id": machine_id},
    }


async def test_a_failed_lookup_raises_and_creates_nothing():
    hub = ScriptedHub(HubError(0, "connection refused"))
    with pytest.raises(HubError):
        await ensure_node_strict(MACHINE_ID, 9007, hub=hub)
    assert [call[0] for call in hub.calls] == ["GET"]


async def test_an_answer_that_is_not_a_list_creates_nothing():
    hub = ScriptedHub({"unexpected": True})
    with pytest.raises(RuntimeError):
        await ensure_node_strict(MACHINE_ID, 9007, hub=hub)
    assert [call[0] for call in hub.calls] == ["GET"]


async def test_the_node_matched_by_machine_id_is_reused():
    mine = machine_node(MACHINE_ID, NODE_ID)
    hub = ScriptedHub([machine_node("another-machine", "0d1b6c1e-5a52-4b0c-9a6e-3f1c2d4e5f60"), mine])
    assert await ensure_node_strict(MACHINE_ID, 9007, hub=hub) == mine
    assert [call[0] for call in hub.calls] == ["GET"]


async def test_a_node_is_created_and_set_up_when_none_is_this_machines():
    hub = ScriptedHub([machine_node("another-machine", "0d1b6c1e-5a52-4b0c-9a6e-3f1c2d4e5f60")])
    node = await ensure_node_strict(MACHINE_ID, 9007, hub=hub)
    assert node["id"] == NODE_ID and node["name"] == default_node_name()
    assert node["node_provider"] == "user_machine" and node["node_config"]["machine_id"] == MACHINE_ID
    assert hub.calls == [
        ("GET", "compute_node", None, None, None),
        ("POST", "compute_node", None, None, None),
        ("POST", "compute_node", NODE_ID, "ops", "setup"),
    ]


async def test_an_account_with_no_node_yet_gets_one():
    """The hub client answers ``{}`` for an empty list: that is "no node", not a failed lookup."""
    made = []

    class Hub:
        async def call(self, method, entity_type, entity_id=None, action=None, sub_path=None, *, payload=None):
            if method == "GET":
                return {}
            if method == "POST" and action is None:
                made.append(payload)
                return {"id": "n1", "node_provider": "user_machine", "node_provider_id": "n1", "node_config": payload["node_config"]}
            return {}

    node = await ensure_node_strict("m-1", 9007, hub=Hub())
    assert len(made) == 1
    assert node["id"] == "n1"
