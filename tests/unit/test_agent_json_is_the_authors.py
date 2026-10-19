"""``agent.json`` is the author's: a save writes only the keys whose value it changes.

The regression: publishing a hand-written agent made the hub echo the row back (``hub_bridge`` →
``upsert_from_hub_child`` → ``save``), and the owned re-render printed every entity default
(``skills: []``, ``intro: ""``, ``enabled: true`` …) into the file — so an agent published a second ago
read "1 change not published". A key the file does not have loads as the entity's default, so a default
is not a change; a record-only save (publish state, status) and an echo that agrees with the file write
nothing at all.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.assets.serialization import write_asset_tree
from flow_sdk.builtin.agent import Agent
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

ID = str(uuid.uuid4())
HAND_WRITTEN = '{\n  "type": "agent",\n  "id": "%s",\n  "name": "flow-check",\n  "description": "Checks.",\n  "worker_type": "claude",\n  "x_note": "kept"\n}\n' % ID


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    root = tmp_path / "agentic-assets" / "agent" / "flow-check"
    root.mkdir(parents=True)
    (root / "agent.json").write_text(HAND_WRITTEN)
    (root / "system_prompt.md").write_text("You check things.\n")
    return root


def _agent(**fields) -> Agent:
    return Agent(**{"id": ID, "name": "flow-check", "description": "Checks.", "worker_type": "claude",
                    "system_prompt": "You check things.", **fields})


def _save(agent: Agent, root: Path) -> None:
    write_asset_tree(agent, SchemaRegistry.get("agent"), root)


def test_a_save_that_changes_nothing_in_the_file_leaves_its_bytes(folder):
    """The hub's echo of a just-published agent: the same definition, every default filled in."""
    _save(_agent(remote=True), folder)
    assert (folder / "agent.json").read_text() == HAND_WRITTEN
    assert (folder / "system_prompt.md").read_text() == "You check things.\n"


def test_a_definition_edit_writes_that_key_only(folder):
    _save(_agent(description="Checks harder.", model="opus"), folder)
    doc = json.loads((folder / "agent.json").read_text())
    assert doc == {**json.loads(HAND_WRITTEN), "description": "Checks harder.", "model": "opus"}
    assert list(doc)[:6] == ["type", "id", "name", "description", "worker_type", "x_note"], "the author's order"


def test_unsetting_a_field_removes_it_and_the_body_follows_its_edit(folder):
    _save(_agent(worker_type=None, system_prompt="You check everything."), folder)
    assert "worker_type" not in json.loads((folder / "agent.json").read_text())
    assert (folder / "system_prompt.md").read_text() == "You check everything.\n"


def test_a_new_agent_is_still_written_whole(tmp_path):
    root = tmp_path / "agentic-assets" / "agent" / "fresh"
    root.mkdir(parents=True)
    _save(_agent(name="fresh"), root)
    doc = json.loads((root / "agent.json").read_text())
    assert (doc["id"], doc["name"], doc["description"]) == (ID, "fresh", "Checks.")
