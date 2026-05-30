"""API tests for parent_path + vault_root filters on /search.

Seed markdown records under a temp tree, sync to DB, then assert the
/search endpoint filters by parent_path (exact) and vault_root (descendants).
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def _isolate_record_state():
    """Clear DB rows + FTS for record types these tests seed, before AND after
    each test. Without this, a sibling test in the api suite can leak markdown
    / asset / claude_project rows that pollute the search results (the
    conftest autouse fixtures only reset caches, not the shared session DB).
    """
    from flow_sdk.db import get_db_driver
    driver = get_db_driver()
    for t in ("markdown", "asset", "claude_project"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass
    yield
    for t in ("markdown", "asset", "claude_project"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass


async def _seed_md(tmp: Path, scan_roots: list[Path]) -> None:
    """Create + sync markdown records for each .md in `tmp` (recursively).

    Scan roots are patched so vault_root attribution is deterministic.
    """
    from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown
    from flow_sdk.fs_store.fs_ref import FSRef as _FSRef

    with patch(
        "flow_sdk.fs_store.operations.markdown_dirs.doc_search_dirs",
        return_value=scan_roots,
    ):
        for md in sorted(tmp.rglob("*.md")):
            rec = extract_markdown(_FSRef(md))[0]
            await rec.sync_to_db()


def _write(path: Path, title: str = "doc") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\ntitle: {title}\n---\n\n# {title}\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Contract tests (endpoint accepts params, no crash)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_accepts_parent_path_param(bootstrapped_client):
    resp = await bootstrapped_client.get(
        "/api/v1/search?record_type=markdown&parent_path=/does/not/exist&limit=5"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["results"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_search_accepts_vault_root_param(bootstrapped_client):
    resp = await bootstrapped_client.get(
        "/api/v1/search?record_type=markdown&vault_root=/does/not/exist&limit=5"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["results"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_search_without_filter_unchanged(bootstrapped_client):
    """Absent filter → response shape is identical to pre-change behavior."""
    resp = await bootstrapped_client.get("/api/v1/search?record_type=markdown&limit=5")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "results" in data
    assert "total" in data
    for r in data["results"]:
        assert r["record_type"] == "markdown"


# ---------------------------------------------------------------------------
# Semantic tests (seed records, verify filter narrows)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parent_path_returns_direct_children_only(bootstrapped_client, tmp_path):
    vault = tmp_path / "vault"
    _write(vault / "alpha" / "a1.md", title="a1")
    _write(vault / "alpha" / "a2.md", title="a2")
    _write(vault / "alpha" / "sub" / "deep.md", title="deep")
    _write(vault / "beta" / "b1.md", title="b1")
    await _seed_md(tmp_path, [vault])

    alpha = str((vault / "alpha").resolve())
    resp = await bootstrapped_client.get(
        f"/api/v1/search?record_type=markdown&parent_path={alpha}&limit=50"
    )
    assert resp.status_code == 200
    names = {r["name"] for r in resp.json()["data"]["results"]}
    # a1 + a2 are direct children; deep is in sub/ so NOT included; b1 is elsewhere.
    assert "a1" in names
    assert "a2" in names
    assert "deep" not in names
    assert "b1" not in names


@pytest.mark.asyncio
async def test_parent_path_empty_folder_returns_empty(bootstrapped_client, tmp_path):
    vault = tmp_path / "vault_empty"
    vault.mkdir()
    await _seed_md(tmp_path, [vault])
    nonexistent = str(vault / "no-such-folder")
    resp = await bootstrapped_client.get(
        f"/api/v1/search?record_type=markdown&parent_path={nonexistent}&limit=50"
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["results"] == []
    assert resp.json()["data"]["total"] == 0


@pytest.mark.asyncio
async def test_vault_root_returns_all_descendants(bootstrapped_client, tmp_path):
    vault = tmp_path / "vroot"
    _write(vault / "top.md", title="top-vroot")
    _write(vault / "a" / "mid.md", title="mid-vroot")
    _write(vault / "a" / "b" / "deep.md", title="deep-vroot")
    other = tmp_path / "other"
    _write(other / "x.md", title="x-other")
    await _seed_md(tmp_path, [vault, other])

    vroot_abs = str(vault.resolve())
    resp = await bootstrapped_client.get(
        f"/api/v1/search?record_type=markdown&vault_root={vroot_abs}&limit=50"
    )
    assert resp.status_code == 200
    names = {r["name"] for r in resp.json()["data"]["results"]}
    assert "top-vroot" in names
    assert "mid-vroot" in names
    assert "deep-vroot" in names
    assert "x-other" not in names


@pytest.mark.asyncio
async def test_parent_path_and_vault_root_combined(bootstrapped_client, tmp_path):
    vault = tmp_path / "andvault"
    _write(vault / "a" / "f1.md", title="and-f1")
    _write(vault / "a" / "f2.md", title="and-f2")
    other_vault = tmp_path / "othervault"
    # Simulate same-named folder under a different vault; parent_path equality
    # is strict absolute-path equality so it shouldn't match.
    _write(other_vault / "a" / "f3.md", title="and-f3")
    await _seed_md(tmp_path, [vault, other_vault])

    a_abs = str((vault / "a").resolve())
    v_abs = str(vault.resolve())
    resp = await bootstrapped_client.get(
        f"/api/v1/search?record_type=markdown&parent_path={a_abs}&vault_root={v_abs}&limit=50"
    )
    names = {r["name"] for r in resp.json()["data"]["results"]}
    assert names == {"and-f1", "and-f2"}


@pytest.mark.asyncio
async def test_parent_path_exposed_in_result(bootstrapped_client, tmp_path):
    vault = tmp_path / "exposevault"
    _write(vault / "sub" / "expo.md", title="expo")
    await _seed_md(tmp_path, [vault])

    parent = str((vault / "sub").resolve())
    resp = await bootstrapped_client.get(
        f"/api/v1/search?record_type=markdown&parent_path={parent}&limit=5"
    )
    results = resp.json()["data"]["results"]
    match = next((r for r in results if r["name"] == "expo"), None)
    assert match is not None
    assert match["parent_path"] == parent
    assert match["vault_root"] == str(vault.resolve())


@pytest.mark.asyncio
async def test_parent_path_with_unicode(bootstrapped_client, tmp_path):
    vault = tmp_path / "uvault"
    _write(vault / "дока" / "u1.md", title="u1-u")
    await _seed_md(tmp_path, [vault])

    parent = str((vault / "дока").resolve())
    resp = await bootstrapped_client.get(
        "/api/v1/search",
        params={"record_type": "markdown", "parent_path": parent, "limit": 10},
    )
    names = {r["name"] for r in resp.json()["data"]["results"]}
    assert "u1-u" in names


@pytest.mark.asyncio
async def test_parent_path_pagination(bootstrapped_client, tmp_path):
    """offset/limit still work when parent_path is set."""
    vault = tmp_path / "pagvault"
    folder = vault / "many"
    for i in range(15):
        _write(folder / f"file{i:02d}.md", title=f"pag-{i:02d}")
    await _seed_md(tmp_path, [vault])

    parent = str(folder.resolve())
    url = f"/api/v1/search?record_type=markdown&parent_path={parent}&limit=5"
    resp_first = await bootstrapped_client.get(url + "&offset=0")
    resp_next = await bootstrapped_client.get(url + "&offset=5")
    first = {r["name"] for r in resp_first.json()["data"]["results"]}
    nxt = {r["name"] for r in resp_next.json()["data"]["results"]}
    # Pages are disjoint
    assert len(first) == 5
    assert len(nxt) == 5
    assert first.isdisjoint(nxt)
    # Total reflects the full count (not just the page size)
    assert resp_first.json()["data"]["total"] == 15


# ---------------------------------------------------------------------------
# /assets/types vault enumeration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assets_types_includes_markdown_vaults(bootstrapped_client):
    """The markdown entry should carry a vaults[] array of (typeid, relPath, label, absPath)."""
    resp = await bootstrapped_client.get("/api/v1/assets/types")
    assert resp.status_code == 200
    types = resp.json()["data"]["types"]
    markdown = next((t for t in types if t["type_name"] == "markdown"), None)
    assert markdown is not None
    assert "vaults" in markdown
    assert isinstance(markdown["vaults"], list)
    for v in markdown["vaults"]:
        assert set(v.keys()) >= {"typeid", "relPath", "label", "absPath"}
        assert v["typeid"].startswith("compute_node-")


@pytest.mark.asyncio
async def test_assets_types_non_markdown_has_no_vaults(bootstrapped_client):
    """Other asset types don't get vaults[] populated (v1 is markdown-only)."""
    resp = await bootstrapped_client.get("/api/v1/assets/types")
    types = resp.json()["data"]["types"]
    for t in types:
        if t["type_name"] != "markdown":
            assert "vaults" not in t
