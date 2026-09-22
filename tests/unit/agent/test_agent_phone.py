"""An agent's phone number lives in ``agent.json`` as its two parts and stays out of the launch bundle."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from flow_sdk.assets.serialization import read_asset_data, render_entity_json
from flow_sdk.builtin.agent import Agent
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.agent_spec import AgentSpec
from flow_sdk.schema.type_info import register_all

pytestmark = pytest.mark.timeout(10)  # do not increase without approval

REPO = Path(__file__).resolve().parents[3]


def test_the_whatsapp_test_agent_declares_its_israeli_number():
    register_all()
    record = read_asset_data(REPO / "agentic-assets/agent/whatsapp-e2e", SchemaRegistry.get("agent"))
    phone = Agent.model_validate({"name": "whatsapp-e2e", "phone": record.phone}).phone
    assert (phone.digits, phone.e164) == ("972557709288", "+972557709288")


def test_a_local_number_is_stored_canonical(tmp_path):
    register_all()
    folder = tmp_path / "agent" / "caller"
    folder.mkdir(parents=True)
    (folder / "agent.json").write_text(json.dumps({
        "type": "agent", "id": "0b7b4a7e-3c1d-4d2e-9f6a-1b2c3d4e5f60", "name": "caller",
        "phone": {"country_code": "+972", "number": "055-770-9288"},
    }))
    (folder / "system_prompt.md").write_text("hi\n")
    info = SchemaRegistry.get("agent")
    record = read_asset_data(folder, info)
    agent = Agent.model_validate({"id": record.id, "name": "caller", "phone": record.phone})
    rendered = json.loads(render_entity_json(agent, info))
    assert rendered["phone"] == {"country_code": "972", "number": "557709288"}


def test_a_malformed_number_is_refused():
    with pytest.raises(ValidationError):
        AgentSpec.model_validate({"phone": {"country_code": "972", "number": "not a phone"}})
