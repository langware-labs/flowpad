"""``SchemaRegistry.type_for`` — the one registry-wide path → type classifier
(name + placement + stat in this phase; no walk roots). One case per tier."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def test_a_shared_type_owns_its_main_document_anywhere(tmp_path: Path) -> None:
    doc = tmp_path / "anywhere" / "s" / "SKILL.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("# s\n", encoding="utf-8")
    assert SchemaRegistry.type_for(doc) == "skill"


def test_a_repo_type_owns_its_main_document_only_in_its_family_dir(tmp_path: Path) -> None:
    placed = tmp_path / "agentic-assets" / "mcp" / "crm" / "mcp.json"
    assert SchemaRegistry.type_for(placed) == "mcp"
    # the same NAME outside the family dir is not that type: a workspace
    # ``SPEC.md`` is a markdown document, not a spec
    assert SchemaRegistry.type_for(tmp_path / "workspace" / "SPEC.md") == "markdown"


def test_a_folder_holding_a_placed_main_document_is_that_type(tmp_path: Path) -> None:
    folder = tmp_path / "agentic-assets" / "mcp" / "crm"
    folder.mkdir(parents=True)
    (folder / "mcp.json").write_text("{}", encoding="utf-8")
    assert SchemaRegistry.type_for(folder) == "mcp"


def test_a_shared_main_name_is_disambiguated_by_family(tmp_path: Path) -> None:
    # graph_workflow and journey both name ``graph.json``; placement decides
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "journey" / "j" / "graph.json") == "journey"
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "graph_workflow" / "g" / "graph.json") == "graph_workflow"


def test_a_unique_file_extension_names_its_type(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "flow.js") == "dynamic_workflow"
    assert SchemaRegistry.type_for(tmp_path / "data.csv") == "spreadsheet"


def test_plain_markdown_falls_to_markdown(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "notes.md") == "markdown"


def test_unknown_or_ambiguous_is_none(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "server.py") is None
    # ``.json`` is claimed by several bespoke-walked types; without roots it is
    # ambiguous, and an ambiguous answer is None rather than a guess
    assert SchemaRegistry.type_for(tmp_path / "settings.json") is None
