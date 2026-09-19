"""The ``folder`` data source: the contract over a watched tree, pruned as it walks, verified
in a person's words, and diffed so a same-size edit is a change and a rename is not a removal."""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.testing import position
from flow_sdk.sources.testing import Subject, checks_for

WatchedFolderSource = asset_module("folder").WatchedFolderSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SEEDED = ("a.txt", "b.txt", "sub/c.txt")


@pytest.fixture
def root(tmp_path):
    root = tmp_path / "watched"
    (root / "sub").mkdir(parents=True)
    for key, body in zip(SEEDED, (b"alpha", b"bravo bravo", b"c")):
        (root / key).write_bytes(body)
    return root


def _row(**config):
    return SimpleNamespace(id="ds-folder", provider="folder", account_key="", config=config)


def _view(prior=None):
    return position(prior)


@pytest.mark.parametrize("check", checks_for(WatchedFolderSource), ids=str)
async def test_conformance(check, root):
    probe = WatchedFolderSource.at(str(root))
    await check.run(Subject(source=lambda: WatchedFolderSource.at(str(root)), seeded=tuple(probe.origin(k) for k in SEEDED)))


async def test_hidden_entries_and_dependency_trees_are_never_listed(root):
    (root / ".hidden.txt").write_bytes(b"x")
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_bytes(b"x")
    (root / "node_modules" / "pkg").mkdir(parents=True)
    (root / "node_modules" / "pkg" / "index.js").write_bytes(b"x")
    async with WatchedFolderSource.at(str(root)) as source:
        assert [item.origin.key async for item in source.iterate()] == list(SEEDED)


async def test_setup_is_verified_in_the_words_a_person_acts_on(tmp_path):
    driver = DataDriver.loaded("folder")
    (tmp_path / "file").write_text("x")
    assert (await driver.verify(_row())).detail == "Set the folder to watch."
    assert (await driver.verify(_row(root=str(tmp_path / "nope")))).detail.endswith("does not exist yet.")
    assert (await driver.verify(_row(root=str(tmp_path / "file")))).detail.endswith("is a file, not a folder.")
    assert (await driver.verify(_row(root=str(tmp_path)))).ready


async def test_a_same_size_edit_is_a_change_and_a_rename_is_not_a_removal(root):
    driver, row, real = DataDriver.loaded("folder"), _row(root=str(root)), os.path.realpath(root)
    first = await driver.traverse(row, _view())

    target = root / "a.txt"
    before = target.stat()
    target.write_bytes(b"ALPHA")
    os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns + 5_000_000_000))
    edited = await driver.traverse(row, _view(first))
    assert edited.refs == [os.path.join(real, "a.txt")]

    os.rename(root / "b.txt", root / "sub" / "b2.txt")
    moved = await driver.traverse(row, _view(edited))
    assert moved.tombstones == [] and moved.refs == [os.path.join(real, "sub", "b2.txt")]
