"""HELPDESK is a repo asset discovered by indexing a cloned portal.

The properties worth pinning are the ones whose failure is silent:

1. **The checkout stays clean.** Identity backends normally commit the id they
   mint back into the source — markdown appends a ``flowpad:capsule`` comment.
   In a git-backed portal that dirties every indexed file and the next
   ``git pull`` fails "local changes would be overwritten". Nothing surfaces the
   breakage until a user tries to update their guides.
2. **The id is stable and derived.** The same portal is cloned by every project
   that consults the desk; if the id moved per machine or per scan, skip-fresh
   would thrash and the adoption record would dangle.
3. **The manifest is read THROUGH.** A denormalized copy would go stale the
   moment a pull changed the desk.

# do not increase timeout without approval
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.fs_store.indexer.functions.helpdesk import helpdesk_stable_key, read_manifest
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

MANIFEST = {
    "display_name": "Acme Support",
    "desk_project_id": "4f9f1fd1-39b6-5465-9c20-cb4c59b08318",
    "welcome_message": "How can we help?",
}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, timeout=20
    ).stdout.strip()


def _make_portal(root: Path, *, name: str = "acme", remote: str = "https://github.com/acme/support.git") -> Path:
    desk = root / "agentic-assets" / "helpdesk" / name
    desk.mkdir(parents=True)
    (desk / "helpdesk.json").write_text(json.dumps(MANIFEST), encoding="utf-8")
    (root / "guide.md").write_text("# Getting started\n", encoding="utf-8")
    _git(root, "init", "-q")
    _git(root, "add", "-A")
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
        cwd=root, capture_output=True, timeout=20,
    )
    _git(root, "remote", "add", "origin", remote)
    return desk


# ── registration ────────────────────────────────────────────────────────────


def test_helpdesk_enrolls_as_a_repo_family_without_indexer_edits() -> None:
    """``asset_class="repo"`` IS the registration — ``repo_assets_fn`` already
    walks every root, so no entry in the indexer's table is needed."""
    info = SchemaRegistry.get("helpdesk")
    assert info is not None
    assert info.asset_class == "repo"
    assert info.family == "helpdesk"
    assert info.main_layout == "folder"
    assert info.main_file == "helpdesk.json"
    assert "helpdesk" in SchemaRegistry.get_repo_types()


# ── identity ────────────────────────────────────────────────────────────────


def test_stable_key_is_derived_from_repo_coordinates(tmp_path: Path) -> None:
    """Two clones of one portal at different paths must key identically —
    otherwise every machine mints its own id for the same desk."""
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    desk_a = _make_portal(a)
    desk_b = _make_portal(b)
    assert helpdesk_stable_key(desk_a) == helpdesk_stable_key(desk_b)
    assert "acme/support" in helpdesk_stable_key(desk_a)


def test_stable_key_never_returns_none_outside_a_repo(tmp_path: Path) -> None:
    """``mint_uuid(None)`` is a RANDOM v4 — a null key would mint a fresh id on
    every scan and defeat skip-fresh. Falls back to the path instead."""
    plain = tmp_path / "agentic-assets" / "helpdesk" / "local"
    plain.mkdir(parents=True)
    (plain / "helpdesk.json").write_text(json.dumps(MANIFEST), encoding="utf-8")
    key = helpdesk_stable_key(plain)
    assert key
    assert key.startswith("helpdesk:path:")


# ── the manifest is read through ────────────────────────────────────────────


def test_manifest_reads_through_to_disk(tmp_path: Path) -> None:
    """A pull that changes the desk must take effect with no re-index, so the
    entity must not hold a denormalized copy."""
    desk = _make_portal(tmp_path)
    hd = Helpdesk(asset_ref=str(desk))
    assert hd.desk_project_id == MANIFEST["desk_project_id"]
    assert hd.display_name == "Acme Support"

    (desk / "helpdesk.json").write_text(
        json.dumps({**MANIFEST, "desk_project_id": "moved", "display_name": "Renamed"}),
        encoding="utf-8",
    )
    assert hd.desk_project_id == "moved"
    assert hd.display_name == "Renamed"


def test_missing_or_malformed_manifest_is_inert(tmp_path: Path) -> None:
    """A desk that cannot be parsed must report nothing rather than raise —
    it is read on the ticket path."""
    empty = tmp_path / "nope"
    empty.mkdir()
    assert read_manifest(empty) == {}
    (empty / "helpdesk.json").write_text("{not json", encoding="utf-8")
    assert read_manifest(empty) == {}
    assert Helpdesk(asset_ref=str(empty)).desk_project_id is None
    assert Helpdesk(asset_ref="").desk_project_id is None


# ── the regression that matters ─────────────────────────────────────────────


def _tracked_changes(repo: Path) -> list[str]:
    """Porcelain lines for TRACKED files only.

    Untracked entries are ignored on purpose: the test harness points
    ``FS_RECORD_PATH`` at ``tmp_path/records`` (``tests/conftest.py:276``), so
    the shadow store lands inside the fixture repo. In a real install it lives
    under ``~/.flow`` and never touches a checkout. What must not happen is a
    write to a file the repo TRACKS — that is what breaks ``git pull``.
    """
    return [ln for ln in _git(repo, "status", "--porcelain").splitlines() if not ln.startswith("??")]


@pytest.mark.asyncio
async def test_indexing_a_portal_read_only_leaves_the_checkout_clean(tmp_path: Path) -> None:
    """THE regression test.

    A non-read-only scan appends an identity capsule to every markdown file it
    indexes. In a cloned portal that dirties the working tree and breaks the
    next ``git pull`` — silently, until a user tries to update their guides.
    """
    desk = _make_portal(tmp_path)
    guide_before = (tmp_path / "guide.md").read_text(encoding="utf-8")
    assert _tracked_changes(tmp_path) == [], "fixture should start clean"

    await _index_additional_dir(str(tmp_path), read_only=True)

    assert _tracked_changes(tmp_path) == [], (
        "indexing a portal must not write into the checkout"
    )
    # Byte-identical: no id stamped into the manifest, no capsule appended to
    # the guide — the two files the identity backends would otherwise claim.
    assert json.loads((desk / "helpdesk.json").read_text(encoding="utf-8")) == MANIFEST
    assert (tmp_path / "guide.md").read_text(encoding="utf-8") == guide_before


@pytest.mark.asyncio
async def test_a_writable_scan_is_what_dirties_the_checkout(tmp_path: Path) -> None:
    """Pins WHY ``read_only`` is needed rather than just that it works.

    Without it the markdown identity backend commits a capsule into the guide.
    If this ever stops being true the read-only plumbing is dead weight and
    should be reconsidered — but until then, dropping it silently breaks pulls.
    """
    _make_portal(tmp_path)
    await _index_additional_dir(str(tmp_path), read_only=False)
    assert _tracked_changes(tmp_path) != [], (
        "expected a writable scan to modify tracked files; if this fails the "
        "read_only guard may no longer be necessary"
    )
