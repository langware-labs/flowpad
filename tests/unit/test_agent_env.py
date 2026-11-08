"""The agent's Env (``agent.json`` → ``env``): the schema round-trips through the file, a secret's value never
reaches it, publish syncs the entries to the hub (``PUT agent/<id>/env``), and readiness counts an approved
secret the hub holds no value for as missing at a cloud deployment."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.assets.serialization import write_asset_tree
from flow_sdk.builtin import agent_env
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.readiness import agent_env_items
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.agent_env_spec import AgentEnvEntry
from flow_sdk.schema.data_spec.agent_spec import AgentSpec
from flow_sdk.schema.data_spec.permission_spec import STATUS_DECLARED, STATUS_MISSING

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

ID = str(uuid.uuid4())
ENV = [
    {"name": "WEATHER_KEY", "kind": "secret", "description": "Weather API", "inject": True},
    {"name": "DRAFT_KEY", "kind": "secret", "inject": False},
    {"name": "REGION", "kind": "plain", "inject": True, "value": "eu"},
]


def _agent(**fields) -> Agent:
    return Agent(**{"id": ID, "name": "envy", "description": "Env.", "system_prompt": "Hi.", **fields})


def test_env_round_trips_through_agent_json_without_a_secret_value(tmp_path: Path):
    root = tmp_path / "agentic-assets" / "agent" / "envy"
    root.mkdir(parents=True)
    leaked = [{**ENV[0], "value": "sk-should-not-be-written"}, *ENV[1:]]
    write_asset_tree(_agent(env=leaked), SchemaRegistry.get("agent"), root)

    text = (root / "agent.json").read_text()
    assert "sk-should-not-be-written" not in text
    doc = json.loads(text)
    assert [e["name"] for e in doc["env"]] == ["WEATHER_KEY", "DRAFT_KEY", "REGION"]
    assert doc["env"][2]["value"] == "eu"
    assert "value" not in doc["env"][0] or doc["env"][0]["value"] is None

    spec = AgentSpec.model_validate(doc)
    assert [(e.name, e.kind, e.inject) for e in spec.env] == [
        ("WEATHER_KEY", "secret", True),
        ("DRAFT_KEY", "secret", False),
        ("REGION", "plain", True),
    ]


def test_an_env_name_must_be_a_variable_name():
    with pytest.raises(ValueError):
        AgentEnvEntry(name="1 bad", kind="plain")


def test_hub_payload_carries_plain_values_and_secret_names_only():
    payload = agent_env.hub_payload(agent_env.parse_entries([{**ENV[0], "value": "sk-x"}, *ENV[1:]]))
    assert payload == {
        "entries": [
            {"name": "WEATHER_KEY", "kind": "secret", "description": "Weather API", "inject": True},
            {"name": "DRAFT_KEY", "kind": "secret", "description": "", "inject": False},
            {"name": "REGION", "kind": "plain", "description": "", "inject": True, "value": "eu"},
        ]
    }


def test_a_later_entry_of_the_same_name_wins():
    rows = agent_env.parse_entries([{"name": "A", "kind": "plain", "value": "1"}, {"name": "A", "kind": "plain", "value": "2"}])
    assert [(e.name, e.value) for e in rows] == [("A", "2")]


async def test_sync_sends_put_env_for_an_agent_on_the_hub(monkeypatch):
    calls: list[tuple] = []

    async def fake_try_call(method, entity_type, entity_id=None, action=None, *rest, **kwargs):
        calls.append((method, entity_type, entity_id, action, kwargs.get("payload")))
        return {"entries": [], "system": [], "placements": []}

    monkeypatch.setattr(HubProxy, "try_call", fake_try_call)
    assert await agent_env.sync_env_to_hub(_agent(env=ENV, remote=False)) is None
    assert calls == [], "an agent that is not on the hub sends nothing"

    await agent_env.sync_env_to_hub(_agent(env=ENV, remote=True))
    method, entity_type, entity_id, action, payload = calls[0]
    assert (method, entity_type, entity_id, action) == ("PUT", "agent", ID, "env")
    assert payload == agent_env.hub_payload(agent_env.parse_entries(ENV))


async def test_publish_of_an_already_published_agent_still_syncs_its_env(monkeypatch):
    from flow_sdk.builtin import agent_places

    calls: list[str] = []

    async def fake_try_call(method, entity_type, entity_id=None, action=None, *rest, **kwargs):
        calls.append(f"{method} {action}")
        return {}

    monkeypatch.setattr(HubProxy, "try_call", fake_try_call)
    monkeypatch.setattr(agent_places, "hub_origin", lambda agent: "https://hub/repo.git")
    assert await _agent(env=ENV, remote=True).ensure_on_hub(actor="user-1") is False
    assert calls == ["PUT env"]


def test_local_view_without_the_hub_has_nothing_written_but_a_set_plain_value():
    view = agent_env.local_view(agent_env.parse_entries(ENV))
    assert [(r["name"], r["written"]) for r in view["entries"]] == [
        ("WEATHER_KEY", False),
        ("DRAFT_KEY", False),
        ("REGION", True),
    ]
    assert view["system"] == [] and view["placements"] == []


def test_merge_view_takes_written_from_the_hub_and_entries_from_the_file():
    hub = {
        "entries": [{"name": "WEATHER_KEY", "kind": "secret", "inject": True, "written": True}],
        "system": [{"name": "ANTHROPIC_BASE_URL", "provided_by": "llm_endpoint", "description": ""}],
        "placements": [{"target": "deployment-1", "kind": "deployment", "placed": ["WEATHER_KEY"], "at": "now"}],
    }
    view = agent_env.merge_view(agent_env.parse_entries(ENV), hub)
    assert {r["name"]: r["written"] for r in view["entries"]} == {"WEATHER_KEY": True, "DRAFT_KEY": False, "REGION": True}
    assert view["system"][0]["provided_by"] == "llm_endpoint"
    assert view["placements"][0]["placed"] == ["WEATHER_KEY"]


class _Deployment:
    """A cloud placement whose hub answers ``environment`` with these rows."""

    def __init__(self, rows):
        self._rows = rows

    async def environment_rows(self):
        return {"rows": self._rows}


async def test_readiness_counts_an_approved_secret_with_no_value_as_missing():
    agent = _agent(env=ENV)
    rows = [{"name": "REGION", "kind": "plain", "source": "agent", "written": True}]
    items = await agent_env_items(agent, _Deployment(rows))
    assert [(i.requirement.name, i.status, i.missing) for i in items] == [("WEATHER_KEY", STATUS_MISSING, ["WEATHER_KEY"])]
    assert items[0].blocks, "an approved secret with no value blocks a cloud deploy"


async def test_readiness_is_satisfied_by_the_agent_value_or_a_deployment_override():
    agent = _agent(env=ENV)
    for source in ("agent", "deployment"):
        items = await agent_env_items(agent, _Deployment([{"name": "WEATHER_KEY", "source": source, "written": True}]))
        assert [(i.requirement.name, i.status) for i in items] == [("WEATHER_KEY", STATUS_DECLARED)]


async def test_readiness_ignores_unapproved_and_already_answered_entries():
    agent = _agent(env=ENV)
    assert await agent_env_items(agent, _Deployment([]), skip={"WEATHER_KEY"}) == []
    assert await agent_env_items(_agent(env=[ENV[1]]), _Deployment([])) == []
