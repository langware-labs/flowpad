"""Unit tests for asset auto-versioning — real git repo + real frontmatter, no behavior mocked.

Drives ``autoversion_commit_local`` (the hook the ``fs`` write action calls) against
a real temporary git repo. The only test adapter is a tiny storage object that maps
a vfs path to the real on-disk path — the path-resolution seam a LocalStorageDriver
provides; the git + frontmatter logic under test runs for real.
"""

import subprocess
from pathlib import Path

import pytest

from flow_sdk.actions.fs.asset_versioning import autoversion_commit_local
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load

SKILL_MD_V1 = """---
id: 9fe9bee3-ce84-58c1-b047-90629fa5dfd3
name: slick
description: A code design lens
---

# slick

Body one.
"""


class _LocalStorage:
    """Minimal stand-in for LocalStorageDriver's path-resolution seam."""

    def __init__(self, root: Path):
        self._root = root

    def _local_full_path(self, vfs_path: str) -> str:
        return str(self._root / vfs_path.lstrip("/"))


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _log_messages(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "log", "--format=%s"], cwd=repo, capture_output=True, text=True
    )
    return [ln for ln in out.stdout.splitlines() if ln.strip()]


def _version_on_disk(md: Path) -> int | None:
    fields = _yaml_load(_extract_frontmatter(md.read_text()) or "") or {}
    return fields.get("version")


@pytest.fixture
def repo(tmp_path) -> Path:
    _git(["init"], tmp_path)
    _git(["config", "user.email", "t@t.test"], tmp_path)
    _git(["config", "user.name", "t"], tmp_path)
    md = tmp_path / "SKILL.md"
    md.write_text(SKILL_MD_V1, encoding="utf-8")
    _git(["add", "-A"], tmp_path)
    _git(["commit", "-m", "init"], tmp_path)
    return tmp_path


async def test_save_bumps_version_and_commits(repo: Path):
    md = repo / "SKILL.md"
    storage = _LocalStorage(repo)

    # Simulate the editor save: new body written to disk (as storage.upload would),
    # then the hook fires.
    edited = SKILL_MD_V1.replace("Body one.", "Body two.")
    md.write_text(edited, encoding="utf-8")
    await autoversion_commit_local(storage, "SKILL.md", edited)

    assert _version_on_disk(md) == 2  # absent → treated as v1, first edit → v2
    msgs = _log_messages(repo)
    assert len(msgs) == 2
    assert "v2" in msgs[0] and "slick" in msgs[0]

    # A second edit bumps again.
    edited2 = md.read_text().replace("Body two.", "Body three.")
    md.write_text(edited2, encoding="utf-8")
    await autoversion_commit_local(storage, "SKILL.md", edited2)
    assert _version_on_disk(md) == 3
    assert len(_log_messages(repo)) == 3


async def test_noop_save_does_not_commit(repo: Path):
    md = repo / "SKILL.md"
    storage = _LocalStorage(repo)
    before = _log_messages(repo)

    # Re-save identical content (no change vs HEAD) → no new revision.
    await autoversion_commit_local(storage, "SKILL.md", md.read_text())

    assert _log_messages(repo) == before
    assert _version_on_disk(md) is None  # version never introduced on a no-op


async def test_non_frontmatter_file_is_ignored(repo: Path):
    plain = repo / "notes.txt"
    plain.write_text("just text, no frontmatter", encoding="utf-8")
    storage = _LocalStorage(repo)
    before = _log_messages(repo)

    await autoversion_commit_local(storage, "notes.txt", "just text, no frontmatter")

    assert _log_messages(repo) == before  # not an asset → skipped
