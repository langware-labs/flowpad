"""The runnable snippets in ``docs/snippets/scan-and-index.md``, run as written."""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.diskio import select
from flow_sdk.diskio.rust.scan import scan_binary_path
from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / "docs").mkdir(parents=True)
    (root / "docs" / "guide.md").write_text("---\ntitle: Guide\n---\n# The guide\n\nSee [[Setup]] and [notes](./notes.md).\n")
    (root / "tools" / "lint").mkdir(parents=True)
    (root / "tools" / "lint" / "SKILL.md").write_text("---\nname: lint\n---\nLint things.\n")
    (root / "node_modules" / "dep").mkdir(parents=True)
    (root / "node_modules" / "dep" / "readme.md").write_text("vendored")
    return root.resolve()


async def _section(heading: str, ns: dict) -> dict:
    return await run_fence(fence_under(doc("scan-and-index.md"), heading), ns,
                           filename=f"scan-and-index.md § {heading}")


async def test_snippet_1_walk(project):
    ns = await _section("1.", {"ROOT": str(project)})
    assert str(project / "docs") in ns["folders"]
    assert ns["markdown"] == [str(project / "docs" / "guide.md"), str(project / "tools" / "lint" / "SKILL.md")]
    assert not any("node_modules" in folder for folder in ns["folders"])


@pytest.mark.parametrize("backend", ["python", "rust"])
async def test_snippet_2_scan_is_the_same_on_both_backends(project, backend, monkeypatch):
    if backend == "rust" and scan_binary_path() is None:
        pytest.skip("no flowpad-diskio-scan binary on this machine")
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, backend)
    ns = await _section("2.", {"ROOT": str(project)})
    assert ns["skills"] == [str(project / "tools" / "lint")]
    assert str(project / "tools" / "lint") in ns["directories"]
    assert not any("node_modules" in d for d in ns["directories"])


async def test_snippet_3_read_documents(project):
    guide = project / "docs" / "guide.md"
    ns = await _section("3.", {"GUIDE": str(guide), "MISSING": str(project / "nope.md")})
    assert ns["title"] == "Guide" and ns["revision"].startswith("sha256:")
    assert ns["unreadable"] == "unreadable"


async def test_snippet_4_title_and_links(project):
    ns = await _section("4.", {"BODY": "# The guide\n\nSee [[Setup]] and [notes](./notes.md).\n"})
    assert ns["heading"] == "The guide"
    assert ns["links"] == ["Setup", "./notes.md"]


async def test_snippet_5_which_backend(monkeypatch):
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "python")
    ns = await _section("5.", {})
    assert (ns["asked_for"], ns["answering"]) == ("python", "PyScanner")
