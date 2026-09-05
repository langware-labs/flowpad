"""The mint seam REFUSES a path the type does not claim — it never answers
with a phantom id and never reads or writes a carrier there."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import UnclaimedPath
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def _ref(path: Path, type_name: str, **kw) -> FSRef:
    return FSRef(path, record_type=RecordType(type_name), **kw)


def test_markdown_on_py_raises_and_leaves_bytes(tmp_path: Path) -> None:
    py = tmp_path / "server.py"
    py.write_text("x = 1\n", encoding="utf-8")

    with pytest.raises(UnclaimedPath):
        SchemaRegistry.get("markdown").mint_entity_id(_ref(py, "markdown"))

    assert py.read_text(encoding="utf-8") == "x = 1\n"


def test_markdown_on_skill_md_raises_because_skill_owns_the_name(tmp_path: Path) -> None:
    skill = tmp_path / "skills" / "s"
    skill.mkdir(parents=True)
    doc = skill / "SKILL.md"
    doc.write_text("---\nname: s\n---\n# s\n", encoding="utf-8")

    assert SchemaRegistry.type_for(doc) == "skill"
    with pytest.raises(UnclaimedPath):
        SchemaRegistry.get("markdown").mint_entity_id(_ref(doc, "markdown"))

    assert doc.read_text(encoding="utf-8").startswith("---\nname: s\n---")


def test_skill_folder_and_its_main_file_mint_the_same_id(tmp_path: Path) -> None:
    skill = tmp_path / "skills" / "s"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: s\n---\n# s\n", encoding="utf-8")
    info = SchemaRegistry.get("skill")

    via_folder = info.mint_entity_id(_ref(skill, "skill"))
    via_main = info.mint_entity_id(_ref(skill / "SKILL.md", "skill"))

    assert via_folder == via_main
    assert uuid.UUID(via_folder).version == 4


def test_a_derived_type_is_not_refused_for_its_own_bespoke_shape(tmp_path: Path) -> None:
    """A derived identity is never written, so its bespoke walker keeps its
    own notion of shape: the refusal is a WRITER's concern."""
    toml = tmp_path / ".codex" / "config.toml"
    toml.parent.mkdir()
    toml.write_text("[mcp_servers.x]\ncommand = 'x'\n", encoding="utf-8")
    info = SchemaRegistry.get("mcp_server")
    assert not info.identity_carrier.writable

    first = info.mint_entity_id(_ref(toml, "mcp_server"))
    assert first == info.mint_entity_id(_ref(toml, "mcp_server"))
    assert toml.read_text(encoding="utf-8").startswith("[mcp_servers.x]")


def test_read_only_ref_is_refused_too_when_unclaimed(tmp_path: Path) -> None:
    """``read_only`` means "don't stamp"; it does not make a ``.py`` a document."""
    py = tmp_path / "a.py"
    py.write_text("pass\n", encoding="utf-8")

    with pytest.raises(UnclaimedPath):
        SchemaRegistry.get("markdown").mint_entity_id(_ref(py, "markdown", read_only=True))
