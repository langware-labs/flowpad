"""A bad value in ``agent.json`` costs that field, never the agent -- and never the author's bytes.

The regression (gtm-studio, 2026-10-28): ``requirements`` hand-written as bare names
(``["GA4_PROPERTY_ID", ...]``) failed ``RequirementSpec`` validation, so the whole agent was
rejected by the indexer and the project's post-pull refresh failed ("Couldn't update"). Now a bare
name converts to a variable requirement, a value that still does not validate is left out of the
load (the rest of the agent loads), and a save never removes the value the load could not read.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.assets.serialization import read_asset_data, write_asset_tree
from flow_sdk.builtin.agent import Agent
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

ID = str(uuid.uuid4())


def _folder(tmp_path: Path, **fields) -> Path:
    root = tmp_path / "agentic-assets" / "agent" / "gtm_report_creator"
    root.mkdir(parents=True)
    doc = {"type": "agent", "id": ID, "name": "gtm_report_creator", "description": "Reports.", **fields}
    (root / "agent.json").write_text(json.dumps(doc, indent=2) + "\n")
    (root / "system_prompt.md").write_text("You report.\n")
    return root


def _read(root: Path):
    return read_asset_data(root, SchemaRegistry.get("agent"))


def test_bare_requirement_names_convert_to_variables(tmp_path):
    root = _folder(tmp_path, requirements=["GA4_PROPERTY_ID", "TWENTY_API_KEY"])
    reqs = _read(root).requirements
    assert [(r["kind"], r["name"]) if isinstance(r, dict) else (r.kind, r.name) for r in reqs] == [
        ("variable", "GA4_PROPERTY_ID"), ("variable", "TWENTY_API_KEY"),
    ]


def test_an_invalid_optional_field_loads_the_rest_of_the_agent(tmp_path):
    root = _folder(tmp_path, requirements=[{"kind": "nonsense", "name": "X"}], model="opus")
    rec = _read(root)
    assert rec.description == "Reports."
    assert rec.model == "opus"
    assert not getattr(rec, "requirements", None)


def test_a_save_keeps_the_value_the_load_could_not_read(tmp_path):
    bad = [{"kind": "nonsense", "name": "X"}]
    root = _folder(tmp_path, requirements=bad)
    agent = Agent(id=ID, name="gtm_report_creator", description="Reports harder.", system_prompt="You report.")
    write_asset_tree(agent, SchemaRegistry.get("agent"), root)
    doc = json.loads((root / "agent.json").read_text())
    assert doc["description"] == "Reports harder."
    assert doc["requirements"] == bad

