"""Deleting a project removes its git checkout, read-only pack files included.

git writes ``.git/objects/pack/*`` read-only. On Windows a read-only file cannot be
unlinked, so a bare ``shutil.rmtree`` dies with ``WinError 5 Access is denied`` half
way through: the project row goes, the folder stays, and the next "clone from git"
finds the name taken and offers ``<name>-2``.

Real git repo, real ``Project._delete_with_children`` — no mocks. It fails only where
the platform enforces the read-only bit (Windows); see the Windows subset in
``.github/workflows/test.yml``.
"""

from __future__ import annotations

import os
import stat
import subprocess

import pytest

from flow_sdk.builtin.project import Project


def _git(repo, *args) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.delete_readonly_checkout.rules: FAILING? Windows-only. Read this
#       tag's rules before editing; do not swap _rmtree_safe back to shutil.rmtree,
#       and do not expect it to fail on macOS.
# flowpad:endcapsule tag
@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_delete_removes_a_checkout_with_read_only_pack_files(tmp_path) -> None:
    repo = tmp_path / "ai-course-lesson-3"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c")
    _git(repo, "gc", "-q")
    packs = list((repo / ".git" / "objects" / "pack").iterdir())
    assert packs and all(not os.stat(p).st_mode & stat.S_IWRITE for p in packs)

    project = await Project(name=repo.name, fs_storage_mount_path=str(repo)).save()
    await project._delete_with_children(folder="rmtree", delete_chats=False)

    assert not repo.exists(), "project delete left its checkout behind"
