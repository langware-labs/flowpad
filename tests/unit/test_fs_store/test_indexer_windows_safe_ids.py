"""Regression (FLOWPAD-1891): the file indexer must never write a record's
shadow home at a filesystem-unsafe path.

Proven root cause this session: the indexer's skip-fresh probe built each
record's shadow home (``<records_root>/<type>/<type>-@<id>/``) from the **raw**
``gen_uuid_fn`` id. For an MCP server that id is ``<source_file>:<json_path>`` —
e.g. the claude.ai cloud connector
``…/.claude.json:/claudeAiMcpEverConnected/claude.ai Google Drive``. A ``:`` is
illegal in a Windows folder name, so writing that shadow home throws
``OSError [WinError 123]`` and aborts the whole index before project assets
(skills) get indexed. macOS allows ``:`` in filenames, so the bug stayed hidden
there — the shadow home was just created as a (wrong) nested path containing a
``:``-bearing component.

This test reproduces the bug through the **real** indexer over a one-record
sample (no mocks, no full filesystem walk): it points ``build_default_indexer``
at a temp HOME holding only the cloud connector and asserts that every shadow
home the indexer actually creates is filesystem-safe — i.e. no path component
anywhere under the mcp_server records subtree contains a ``:`` (the exact char
that crashes the write on Windows), and the record home is a flat
``mcp_server-@<uuid>``.

On/off switch: with the ``normalize_entity_id`` wrap in ``_probe_chunk`` the
shadow home is ``mcp_server-@<uuid>`` (passes); reverting that one line restores
the raw ``…:…`` shadow home (fails — a ``:``-bearing component reappears).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.builtin import build_default_indexer
from flow_sdk.fs_store.record_paths import get_default_records_root
from flow_sdk.fs_store.record_types import RecordType


@pytest.mark.asyncio
async def test_index_cloud_connector_creates_filesystem_safe_shadow_home(tmp_path: Path) -> None:
    # Temp HOME whose ONLY mcp_server record is the poison cloud connector
    # (the exact field-report trigger): its raw natural-key id carries a ``:``.
    home = tmp_path / "home"
    home.mkdir()
    (home / ".claude.json").write_text(
        json.dumps({"claudeAiMcpEverConnected": ["claude.ai Google Drive"]}),
        encoding="utf-8",
    )

    # Clean slate for this type so the only shadow homes after the run are the
    # ones THIS index created from our temp HOME (db rows + on-disk homes).
    mcp_type = str(RecordType.MCP_SERVER)
    driver = get_db_driver()
    await driver.delete_entities_by_type(mcp_type)
    mcp_dir = get_default_records_root() / mcp_type
    if mcp_dir.exists():
        shutil.rmtree(mcp_dir)

    # Real indexer + real two-stage MCP walk, but rooted ONLY at our temp HOME
    # and sampled to the mcp_server type (no full filesystem scan).
    idx = build_default_indexer()
    idx._roots = [FSRef(home, record_type=RecordType.USER_HOME_FOLDER)]
    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.MCP_SERVER], force=True)
    )

    per = result.per_type.get(RecordType.MCP_SERVER)
    assert per is not None, f"no MCP_SERVER in result: {list(result.per_type)}"
    assert per.errors == 0, f"index reported errors: {per}"
    assert per.indexed >= 1, f"cloud connector was not indexed: {per}"

    # The crux: every path the indexer wrote under the mcp_server records subtree
    # must be filesystem-safe. A ``:`` in ANY component is precisely what makes
    # the shadow-home write fail on Windows (``WinError 123``).
    assert mcp_dir.exists(), "indexer created no mcp_server records dir"
    colon_components = [p.name for p in mcp_dir.rglob("*") if ":" in p.name]
    assert not colon_components, f"unsafe shadow-home path component(s): {colon_components}"

    # And the record home is a single flat ``mcp_server-@<uuid>`` (not a nested
    # path-derived tree), with a conforming entity id.
    sep = "-@"
    homes = [d.name for d in mcp_dir.iterdir() if d.is_dir() and sep in d.name]
    assert homes, f"no mcp_server shadow home created under {mcp_dir}"
    for stem in homes:
        uid = stem.split(sep, 1)[1]
        assert is_valid_entity_id(uid), f"shadow-home id is not a conforming UUID: {uid!r}"
