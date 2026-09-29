"""A Node.js a version manager installed is found even when no shell put it on PATH.

nvm/fnm/volta only reach PATH through the person's dotfiles, and that can fail
even in a terminal — nvm whose `default` alias names an uninstalled version
activates nothing. `with_node_fallback` reads the installs off the disk instead,
and every place Flowpad runs a command (wizard checks, terminals, workers) uses it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from flow_sdk.core.capabilities.env_probe import node_manager_bins, with_node_fallback

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="version-manager dirs are read on unix only")


def _node(bin_dir: Path) -> Path:
    bin_dir.mkdir(parents=True)
    exe = bin_dir / "node"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    return bin_dir


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    for var in ("NVM_DIR", "FNM_DIR", "VOLTA_HOME"):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


def test_newest_nvm_version_is_added_when_node_is_missing(home):
    _node(home / ".nvm/versions/node/v22.23.2/bin")
    newest = _node(home / ".nvm/versions/node/v24.13.1/bin")

    assert with_node_fallback("/usr/bin") == os.pathsep.join(["/usr/bin", str(newest)])


def test_node_already_on_path_is_left_in_charge(home, tmp_path):
    _node(home / ".nvm/versions/node/v24.13.1/bin")
    system = _node(tmp_path / "system/bin")

    assert with_node_fallback(str(system)) == str(system)


def test_volta_shim_wins_over_versioned_installs(home):
    _node(home / ".nvm/versions/node/v24.13.1/bin")
    volta = _node(home / ".volta/bin")

    assert node_manager_bins()[0] == str(volta)


def test_fnm_installs_are_found(home):
    fnm = _node(home / ".local/share/fnm/node-versions/v20.1.0/installation/bin")

    assert node_manager_bins() == [str(fnm)]


def test_no_version_manager_leaves_path_alone(home):
    assert with_node_fallback("/usr/bin") == "/usr/bin"


def test_fallback_is_idempotent(home):
    _node(home / ".nvm/versions/node/v24.13.1/bin")
    once = with_node_fallback("/usr/bin")

    assert with_node_fallback(once) == once
