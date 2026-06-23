"""HTTP coverage for ``GET /api/v1/assets/markdown-files?root=`` — the
gitignore-aware project walk that feeds the Markdown asset menu's folder tree.

Drives the real FastAPI app. Regression: a project-ROOT ``.md`` (``streams_sdk.md``)
must come back from the endpoint, not just files under ``docs/``. Also asserts
gitignore + denylist pruning happens over the wire. No mocks.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio


def _touch(p: Path, text: str = "x") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


async def _files(client, root: Path) -> list[str]:
    resp = await client.get("/api/v1/assets/markdown-files", params={"root": str(root)})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["files"]


async def test_root_and_docs_md_returned(client, tmp_path: Path) -> None:
    _touch(tmp_path / "streams_sdk.md")            # the regression: project-root file
    _touch(tmp_path / "docs" / "STREAMS-ANALYSIS.md")
    _touch(tmp_path / "notes.txt")                 # non-md excluded
    files = await _files(client, tmp_path)
    assert files == ["docs/STREAMS-ANALYSIS.md", "streams_sdk.md"]


async def test_gitignore_and_denylist_pruned_over_http(client, tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "private/\n")
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "private" / "secret.md")             # gitignored dir
    _touch(tmp_path / "node_modules" / "pkg" / "readme.md")  # denylist
    files = await _files(client, tmp_path)
    assert files == ["keep.md"]


async def test_missing_root_returns_empty(client, tmp_path: Path) -> None:
    assert (await _files(client, tmp_path / "nope")) == []


async def test_markdown_vaults_are_project_rooted(client) -> None:
    """``/assets/types`` markdown vaults expose an absPath and root project
    vaults at the project ROOT (not its ``docs/`` subfolder), so the menu walk
    covers the whole project."""
    resp = await client.get("/api/v1/assets/types")
    assert resp.status_code == 200, resp.text
    types = resp.json()["data"]["types"]
    md = next(t for t in types if t["type_name"] == "markdown")
    vaults = md.get("vaults", [])
    # Every vault carries an absolute root path (the walk target).
    assert all(v.get("absPath") for v in vaults)
    # No project vault is scoped to a bare ``docs/`` subdir anymore.
    assert all(
        not v["absPath"].rstrip("/").endswith("/docs")
        for v in vaults
        if v["scope"] == "project"
    )
