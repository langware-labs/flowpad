"""Discovering a path a type does not own must not EDIT that path: the
resolver answers ``NotAnAsset`` for an unclaimed (type, path) pair before any
carrier is read or written, so a ``server.py`` labelled ``markdown`` never
grows a frontmatter header. Entry point is the real ``resolve_asset`` →
``index_one``; real filesystem, no mocks.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import UnclaimedPath
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all
from tests.fixtures.identity import index_path, resolve_id

_SERVER_PY = 'from fastmcp import FastMCP\n\nmcp = FastMCP("crm-mcp")\n'
_README_MD = "# CRM MCP\n\nplain readme text.\n"


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def _crm_mcp_server(tmp_path: Path) -> Path:
    folder = tmp_path / "agentic-assets" / "mcp" / "crm-mcp"
    folder.mkdir(parents=True)
    server = folder / "server.py"
    server.write_text(_SERVER_PY, encoding="utf-8")
    return server


async def test_discovering_a_py_as_markdown_does_not_corrupt_it(tmp_path: Path) -> None:
    server = _crm_mcp_server(tmp_path)

    assert await index_path("markdown", str(server)) is None

    after = server.read_text(encoding="utf-8")
    compile(after, "server.py", "exec")
    assert after == _SERVER_PY


async def test_discovering_a_py_as_mcp_does_not_stamp_it(tmp_path: Path) -> None:
    server = _crm_mcp_server(tmp_path)

    assert await index_path("mcp", str(server)) is None

    after = server.read_text(encoding="utf-8")
    assert "flowpad:capsule identity" not in after
    assert after == _SERVER_PY


async def test_a_readme_inside_a_valid_mcp_folder_is_not_stamped(tmp_path: Path) -> None:
    """``mcp``'s document is ``mcp.json``; a sibling ``.md`` is not its shape."""
    folder = tmp_path / "agentic-assets" / "mcp" / "crm-mcp"
    folder.mkdir(parents=True)
    (folder / "mcp.json").write_text('{"name": "crm-mcp"}\n', encoding="utf-8")
    readme = folder / "README.md"
    readme.write_text(_README_MD, encoding="utf-8")

    await index_path("mcp", str(readme))

    assert readme.read_text(encoding="utf-8") == _README_MD


async def test_a_reference_doc_inside_a_skill_is_not_stamped_as_the_skill(tmp_path: Path) -> None:
    skill = tmp_path / "agentic-assets" / "skills" / "my-skill"
    (skill / "reference").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: my-skill\n---\n# my skill\n", encoding="utf-8")
    notes = skill / "reference" / "notes.md"
    notes.write_text(_README_MD, encoding="utf-8")

    await index_path("skill", str(notes))

    assert notes.read_text(encoding="utf-8") == _README_MD


def test_the_seam_refuses_an_unclaimed_existing_path(tmp_path: Path) -> None:
    """Defense in depth for the other point callers: the seam raises, it does
    not answer. No phantom id, no bytes touched."""
    server = _crm_mcp_server(tmp_path)
    info = SchemaRegistry.get("markdown")

    with pytest.raises(UnclaimedPath):
        resolve_id(info, FSRef(server, record_type=RecordType("markdown")))

    assert server.read_text(encoding="utf-8") == _SERVER_PY


def test_a_save_target_that_does_not_exist_yet_still_carries(tmp_path: Path) -> None:
    """The refusal is about an EXISTING unclaimed path, never a missing one:
    serializers mint against an asset_ref whose bytes land moments later."""
    info = SchemaRegistry.get("markdown")
    fresh = tmp_path / "not-created-yet.md"

    minted = resolve_id(info, FSRef(fresh, record_type=RecordType("markdown")))

    assert minted
    assert info.read_id(FSRef(fresh, record_type=RecordType("markdown"))) == minted


async def test_discovering_a_real_markdown_doc_still_stamps_it(tmp_path: Path) -> None:
    doc = tmp_path / "notes.md"
    doc.write_text("# My notes\n\nplain user markdown.\n", encoding="utf-8")

    await index_path("markdown", str(doc))

    assert SchemaRegistry.get("markdown").read_id(str(doc))
