"""FLOWPAD-2083: discovering a path a type does not own must not EDIT that path.

A bundled MCP server's ``server.py`` was found with YAML frontmatter prepended::

    ---
    id: aec9b4d5-b2c9-41b1-8c03-fcec087c24c8
    ---

    \"\"\"MCP server for CRM-mcp.

``compile()`` → ``SyntaxError: invalid decimal literal``. The id was never
persisted anywhere (zero rows across every instance DB and record store), which
is the signature of a carrier write that happens EAGERLY, before anything
commits.

The route the frontend takes is ``POST /fs-records/<type>/discover?path=…`` →
:func:`discover_record_by_path` → ``TypeInfo.mint_entity_id``. That seam has no
guard that the target can hold frontmatter: it trusts the ``record_type`` the
caller named, and for a file-layout frontmatter type ``carrier_path_for``
returns the path verbatim, so ``FrontmatterCarrier.write_if_absent`` prepends a
YAML header to whatever those bytes are.

Why the existing guards don't save it:

* The owner lookup misses legitimately — it is type-scoped and exact-path, and
  the row that exists is type ``mcp`` on the FOLDER. A miss is not "we can't
  tell", it is "mint one and write it to disk".
* VIBE-002 already fixed this shape ONCE, for ``.html``, by guarding the
  EXTRACTOR (``test_html_not_indexed_as_markdown``). But
  ``discover_record_by_path`` mints BEFORE it calls ``from_disk_fn``, so the
  extractor guard runs after the bytes are already gone. Discovery correctly
  returns ``None`` here — and the file is corrupt anyway.

Entry point is the real one: these call ``discover_record_by_path``, not the
seam underneath it, because the seam is reached through that chain in the
product. Real filesystem, no mocks. The owner lookup is a GENUINE miss (verified
via ``strict=True``, which raises only when a probe errored), matching the
production scenario rather than a lookup that failed for want of a database.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.faas.fs_records_actions import discover_record_by_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all

#: Verbatim shape of the asset that was damaged: an MCP server whose folder has
#: no ``mcp.json``, so no type's ``layout_of`` claims either the file or the folder.
_SERVER_PY = 'from fastmcp import FastMCP\n\nmcp = FastMCP("crm-mcp")\n'


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def _crm_mcp_server(tmp_path: Path) -> Path:
    """The reported asset, reproduced: ``agentic-assets/mcp/crm-mcp/server.py``
    with no ``mcp.json`` beside it."""
    folder = tmp_path / "agentic-assets" / "mcp" / "crm-mcp"
    folder.mkdir(parents=True)
    server = folder / "server.py"
    server.write_text(_SERVER_PY, encoding="utf-8")
    return server


async def test_discovering_a_py_as_markdown_does_not_corrupt_it(tmp_path: Path) -> None:
    """The reported symptom, through the route the frontend actually calls."""
    server = _crm_mcp_server(tmp_path)

    await discover_record_by_path("markdown", str(server))

    after = server.read_text(encoding="utf-8")
    try:
        compile(after, "server.py", "exec")
    except SyntaxError as exc:  # pragma: no cover - the failure being captured
        pytest.fail(f"discover corrupted the source ({exc.msg}, line {exc.lineno}):\n{after}")
    assert after == _SERVER_PY, f"discover rewrote a source it does not own:\n{after}"


async def test_discovering_a_py_as_mcp_does_not_stamp_it(tmp_path: Path) -> None:
    """The silent sibling: the ``mcp`` type carries a FolderJsonCarrier, and an
    inner file is its own ``storage_root_for`` (``layout_of(path).root or path``
    — ``names_main`` is False for ``server.py``), so the capsule lands INSIDE the
    script as ``# flowpad:capsule identity`` comments. Valid Python, so nothing
    raises and nobody notices — the same missing guard, without the SyntaxError.

    Same entry point as the test above by design; this varies the TYPE (and so
    the carrier), not the call path. It is not independent coverage of the
    frontmatter case.
    """
    server = _crm_mcp_server(tmp_path)

    await discover_record_by_path("mcp", str(server))

    after = server.read_text(encoding="utf-8")
    assert "flowpad:capsule identity" not in after, f"discover stamped a capsule into a script:\n{after}"
    assert after == _SERVER_PY, f"discover rewrote a source it does not own:\n{after}"


def test_an_inner_file_resolves_to_the_asset_that_contains_it(tmp_path: Path) -> None:
    """The carrier points at where the id LIVES, not at the file it was asked
    about. Given a VALID ``mcp`` folder, an inner script resolves to the folder's
    own carrier — the same containment ``get_by_asset_ref(resolve_containing=True)``
    applies, but as a pure path question rather than a DB fan-out."""
    info = SchemaRegistry.get("mcp")
    folder = tmp_path / "agentic-assets" / "mcp" / "crm-mcp"
    folder.mkdir(parents=True)
    (folder / "mcp.json").write_text('{"name": "crm-mcp"}\n', encoding="utf-8")
    (folder / "server.py").write_text(_SERVER_PY, encoding="utf-8")

    assert info.carrier_path_for(folder / "server.py") == info.carrier_path_for(folder)


def test_a_save_target_that_does_not_exist_yet_still_carries(tmp_path: Path) -> None:
    """The guard rules out an EXISTING regular file, never a missing path.
    ``_commit_identity`` mints against an asset_ref whose bytes may not be on
    disk yet; a check that demanded existence would break every create flow."""
    info = SchemaRegistry.get("mcp")
    fresh = tmp_path / "not-created-yet"

    assert info.carrier_path_for(fresh) is not None


async def test_discovering_a_real_markdown_doc_still_stamps_it(tmp_path: Path) -> None:
    """The guard must fence the unclaimed path, not disable identity. A ``.md``
    IS claimed by ``markdown.layout_of``, so it still gets its frontmatter id."""
    doc = tmp_path / "notes.md"
    doc.write_text("# My notes\n\nplain user markdown.\n", encoding="utf-8")

    await discover_record_by_path("markdown", str(doc))

    assert SchemaRegistry.get("markdown").read_id(str(doc)), (
        f"a real markdown doc was left unidentified:\n{doc.read_text(encoding='utf-8')}"
    )
