"""``refresh-project`` lays a delivered tree over a project IN PLACE.

The update half of ``materialize-project``: the hub clones again and stages the
tree on the node; the node moves its existing checkout to that commit instead of
parking a second copy. Real git on both sides, no network.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.compute_node import _refresh_tree

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _git(cwd: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return out.stdout.strip()


def _repo(tmp_path: Path) -> Path:
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "-q", "-b", "main")
    (upstream / "agent.md").write_text("v1\n")
    (upstream / "old.md").write_text("gone upstream later\n")
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-q", "-m", "v1")
    return upstream


def test_a_checkout_moves_to_the_delivered_commit_and_keeps_what_the_node_wrote(tmp_path):
    upstream = _repo(tmp_path)
    project = tmp_path / "project"
    shutil.copytree(upstream, project)  # what the first delivery left on the node
    (project / "node-output.log").write_text("written on the node\n")

    (upstream / "agent.md").write_text("v2\n")
    (upstream / "old.md").unlink()
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-q", "-m", "v2")
    staging = tmp_path / "staging"
    shutil.copytree(upstream, staging)  # the hub's second clone, staged

    head = _refresh_tree(str(staging), str(project))

    assert head == _git(upstream, "rev-parse", "HEAD")
    assert (project / "agent.md").read_text() == "v2\n"
    assert not (project / "old.md").exists(), "a file deleted upstream is deleted on the node"
    assert (project / "node-output.log").exists(), "untracked node files survive"


def test_a_folder_without_git_gets_the_files_copied_over(tmp_path):
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "agent.md").write_text("new\n")
    project = tmp_path / "project"
    project.mkdir()
    (project / "agent.md").write_text("old\n")
    (project / "keep.txt").write_text("k\n")

    assert _refresh_tree(str(staging), str(project)) == ""
    assert (project / "agent.md").read_text() == "new\n"
    assert (project / "keep.txt").exists()
