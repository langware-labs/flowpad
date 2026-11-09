"""An asset scan survives a folder this user cannot look into.

A real home holds root-owned folders (docker's data root, another user's
mount). The user home is a scan source, so one such child used to raise
PermissionError out of ``collect_asset_scan`` and fail every view built on the
catalog — the project's published view among them (500 on
``/graph/project/<id>/published``).
"""

import os
import sys
from pathlib import Path

import pytest

from flow_sdk.assets.folder import AssetFolder, collect_asset_scan

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or os.geteuid() == 0,
    reason="needs a normal POSIX user: chmod 0 does not lock a folder on Windows, and root reads it anyway",
)


def _skill(root: Path, name: str) -> None:
    folder = root / ".claude" / "skills" / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: test\n---\nbody\n")


@pytest.fixture
def home_with_locked_child(tmp_path: Path):
    _skill(tmp_path, "visible")
    locked = tmp_path / "docker-data"
    locked.mkdir()
    locked.chmod(0)
    try:
        yield tmp_path
    finally:
        locked.chmod(0o755)


@pytest.mark.parametrize("recursive", [False, True], ids=["user-home", "project"])
def test_scan_skips_an_unreadable_child(home_with_locked_child: Path, recursive: bool):
    result = collect_asset_scan([AssetFolder(path=home_with_locked_child, recursive=recursive, types=["skill"])])

    assert [a.name for a in result.assets] == ["visible"]
    # The recursive (project) walk says it could not read the folder; the
    # user-home pass never walks into it, so it has nothing to say.
    unreadable = [i for i in result.issues if i.path.name == "docker-data"]
    assert bool(unreadable) is recursive
