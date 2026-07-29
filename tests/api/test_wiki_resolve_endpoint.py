"""HTTP coverage for ``GET /api/v1/wiki/resolve``.

Drives the real FastAPI app via the shared `bootstrapped_client` fixture.
Entities are written to disk + indexed + sync_to_db so the resolve query
hits the real EntitySchema/uname index. No mocks.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.functions.markdown import (
    extract_markdown,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.fs_ref import FSRef as _FSRef


class MarkdownRecord:
    @staticmethod
    def from_file(p):
        ref = _FSRef(p)
        return extract_markdown(ref, SchemaRegistry.get("markdown").mint_id(ref))[0]

    @staticmethod
    def from_fsref(ref):
        # async-compat: the real indexer awaits this; the test will too.
        async def _aw():
            return extract_markdown(ref, SchemaRegistry.get("markdown").mint_id(ref))
        return _aw()

    @staticmethod
    def asset_hash_for_ref(ref):
        from flow_sdk.fs_store.fs_record import FSRecord as _FSR
        return _FSR.asset_hash_for_ref(ref)

    @staticmethod
    def genId(ref):
        return SchemaRegistry.get("markdown").mint_id(ref)
  # alias for tests; uses extract_markdown for parsing
from flow_sdk.fs_store.indexer.functions.whiteboard import extract_whiteboard
from flow_sdk.fs_store.fs_record import FSRecord
class WhiteboardRecord:
    @staticmethod
    def from_fsref(ref):
        from flow_sdk.fs_store.indexer.functions.whiteboard import extract_whiteboard
        async def _aw():
            return extract_whiteboard(ref, SchemaRegistry.get("whiteboard").mint_id(ref))
        return _aw()
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions, build_default_indexer
from flow_sdk.fs_store.record_types import RecordType


pytestmark = pytest.mark.asyncio


def _write_markdown(root: Path, name: str) -> None:
    """Drop a markdown file under ``root/<name>.md`` with frontmatter."""
    (root / f"{name}.md").write_text(
        f"---\ntitle: {name}\n---\n\n# {name}\n\nBody.\n",
        encoding="utf-8",
    )


def _write_whiteboard(root: Path, name: str) -> None:
    """Drop a whiteboard folder under ``root/.claude/whiteboards/<name>/``
    with WHITE_BOARD.md + board.json — the layout ``whiteboard_fn`` expects."""
    folder = root / ".claude" / "whiteboards" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "WHITE_BOARD.md").write_text(
        f"---\nname: {name}\ndescription: \"\"\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    (folder / "board.json").write_text(
        '{"kind":"excalidraw","version":1,"data":{"elements":[],"appState":{},"files":{}}}',
        encoding="utf-8",
    )


async def _index_and_sync(root: Path) -> None:
    """Run the production indexer over ``root`` and sync every emitted record."""
    custom_root = FSRef(root, record_type=RecordType.CWD_ROOT, scope="project")
    indexer = build_default_indexer()
    refs = await indexer.scan(IndexerOptions(verbose=False, roots=(custom_root,), gitignore=False))
    for r in refs:
        if r.record_type == RecordType.MARKDOWN:
            for rec in await MarkdownRecord.from_fsref(r):
                await rec.sync_to_db()
        elif r.record_type == RecordType.WHITEBOARD:
            for rec in await WhiteboardRecord.from_fsref(r):
                await rec.sync_to_db()


async def test_resolve_markdown_hit(bootstrapped_client, tmp_path: Path) -> None:
    """A markdown record named 'foo' resolves to {type:'markdown', ...}."""
    _write_markdown(tmp_path, "alpha-md")
    await _index_and_sync(tmp_path)

    resp = await bootstrapped_client.get("/api/v1/wiki/resolve?name=alpha-md")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["kind"] == "resolved"
    assert body["data"]["target_typeid"].startswith("markdown-")
    assert "asset_ref" not in body["data"]


async def test_resolve_whiteboard_hit(bootstrapped_client, tmp_path: Path) -> None:
    """A whiteboard folder named 'bar' resolves to {type:'whiteboard', ...}."""
    _write_whiteboard(tmp_path, "beta-wb")
    await _index_and_sync(tmp_path)

    resp = await bootstrapped_client.get("/api/v1/wiki/resolve?name=beta-wb")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data"]["kind"] == "resolved"
    assert body["data"]["target_typeid"].startswith("whiteboard-")


async def test_resolve_collision_is_ambiguous(bootstrapped_client, tmp_path: Path) -> None:
    """Same name in two types is never resolved by preference or ordering."""
    same = "gamma-shared"
    _write_markdown(tmp_path, same)
    _write_whiteboard(tmp_path, same)
    await _index_and_sync(tmp_path)

    resp_default = await bootstrapped_client.get(f"/api/v1/wiki/resolve?name={same}")
    assert resp_default.status_code == 200, resp_default.text
    assert resp_default.json()["data"] == {"kind": "ambiguous"}

    resp_pref = await bootstrapped_client.get(
        f"/api/v1/wiki/resolve?name={same}&prefer_type=whiteboard"
    )
    assert resp_pref.status_code == 200, resp_pref.text
    assert resp_pref.json()["data"] == {"kind": "ambiguous"}


async def test_resolve_miss_returns_missing_result(bootstrapped_client) -> None:
    """A name with no candidates returns semantic missing (200, not 404)."""
    resp = await bootstrapped_client.get("/api/v1/wiki/resolve?name=nonexistent-xyz-9999")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == {"kind": "missing"}
