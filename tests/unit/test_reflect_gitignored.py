"""A source's local copy is kept out of git: asked of git, guarded before the first placement.

``flow_sdk/utils/git_ignore.py`` answers; ``ingest.reflect.keep_out_of_git`` acts on it for a source whose
``gitignored`` is on (the default); ``sync_source`` refuses a pass before traversing when it cannot.
"""
from __future__ import annotations

import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_runtime import Pass
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec
from flow_sdk.utils import git_ignore
from tests.unit.test_ingest_sync import _FakeType

NOW = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd, check=True, capture_output=True)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "proj"
    (repo / "ds").mkdir(parents=True)
    _git(repo, "init", "-q")
    return repo


# ── git_ignore ────────────────────────────────────────────────────────────────


def test_a_folder_is_excluded_by_a_line_beside_it_and_git_confirms(tmp_path):
    repo = _repo(tmp_path)
    target = repo / "ds" / "examples"
    target.mkdir()

    assert git_ignore.ignore_status(target) == git_ignore.NOT_IGNORED
    assert git_ignore.ensure_ignored(target) == git_ignore.IGNORED
    assert git_ignore.ensure_ignored(target) == git_ignore.IGNORED
    assert (repo / "ds" / ".gitignore").read_text() == "/examples/\n", "written once, beside the folder"


def test_a_tracked_folder_is_reported_tracked_and_no_line_is_written(tmp_path):
    repo = _repo(tmp_path)
    target = repo / "ds" / "examples"
    target.mkdir()
    (target / "row.json").write_text("{}")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "rows")

    assert git_ignore.ensure_ignored(target) == git_ignore.TRACKED
    assert not (repo / "ds" / ".gitignore").exists()


def test_outside_a_repository_nothing_is_written(tmp_path):
    target = tmp_path / "plain" / "examples"
    target.mkdir(parents=True)

    assert git_ignore.ensure_ignored(target) == git_ignore.NOT_A_REPO
    assert not (tmp_path / "plain" / ".gitignore").exists()
    assert git_ignore.ignored_under(tmp_path / "plain") == set()


def test_ignored_under_names_a_whole_ignored_folder_once_and_the_root_when_it_is_ignored(tmp_path):
    repo = _repo(tmp_path)
    (repo / "ds" / "examples" / "a").mkdir(parents=True)
    (repo / "ds" / "examples" / "a" / "input.json").write_text("{}")
    (repo / "ds" / "dataset.json").write_text("{}")
    (repo / "ds" / ".gitignore").write_text("/examples/\n")

    assert git_ignore.ignored_under(repo / "ds") == {(repo / "ds" / "examples").resolve()}
    assert git_ignore.ignored_under(repo / "ds" / "examples") == {(repo / "ds" / "examples").resolve()}
    assert git_ignore.is_under(repo / "ds" / "examples" / "a" / "input.json", git_ignore.ignored_under(repo / "ds"))


# ── the source field ──────────────────────────────────────────────────────────


def test_the_file_says_only_what_differs_from_the_defaults():
    base = {"data_driver_name": "folder"}
    assert "gitignored" not in DataSourceSpec(**base).model_dump(exclude_defaults=True)
    dumped = DataSourceSpec(**base, gitignored=False, read_only=True).model_dump(exclude_defaults=True)
    assert (dumped["gitignored"], dumped["read_only"]) == (False, True)


# ── the guard in the sync loop ────────────────────────────────────────────────


async def _copy_source(target: Path, **kw) -> DataSource:
    src = DataSource(
        provider="faketest", account_key=f"acct-{uuid.uuid4().hex[:8]}", name=f"fake {uuid.uuid4().hex[:8]}",
        reflect="copy", reflect_into=str(target), **kw,
    )
    await src.save()
    return src


async def _reread(src) -> DataSource:
    return await DataSource.get_one({"id": src.id})


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_copy_source_keeps_its_target_out_of_git_before_placing(tmp_path):
    repo = _repo(tmp_path)
    src = await _copy_source(repo / "ds" / "examples")
    DataDriver.register(_FakeType(Pass(cursor="c1"), is_object=True))

    await sync_source(src, now=NOW)

    assert (repo / "ds" / ".gitignore").read_text() == "/examples/\n"
    assert (await _reread(src)).health == SourceHealth.OK.value


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_tracked_target_refuses_the_pass_before_traversing(tmp_path):
    repo = _repo(tmp_path)
    target = repo / "ds" / "examples"
    target.mkdir()
    (target / "row.json").write_text("{}")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "rows")
    src = await _copy_source(target)
    fake = _FakeType(Pass(cursor="c1"), is_object=True)
    DataDriver.register(fake)

    await sync_source(src, now=NOW)

    assert fake.positions == [], "nothing is fetched while the target would be committed"
    row = await _reread(src)
    assert (row.health, row.error_code, row.cursor) == (SourceHealth.CONFIG_ERROR.value, "reflect_target_tracked", None)
    assert "git rm -r --cached" in row.error_detail


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_source_that_opts_out_leaves_gitignore_alone(tmp_path):
    repo = _repo(tmp_path)
    src = await _copy_source(repo / "ds" / "examples", gitignored=False)
    DataDriver.register(_FakeType(Pass(cursor="c1"), is_object=True))

    await sync_source(src, now=NOW)

    assert not (repo / "ds" / ".gitignore").exists()
    assert (await _reread(src)).health == SourceHealth.OK.value


# ── where a relative target lands ─────────────────────────────────────────────


def test_a_relative_target_is_under_the_scope_holding_the_source_and_never_the_cwd(tmp_path):
    from flow_sdk.ingest.reflect import target_root as _target_root

    own = tmp_path / "proj" / "agentic-assets" / "data_source" / "research-drive"
    own.mkdir(parents=True)
    held = DataSource(provider="gdrive", name="r", reflect="copy", reflect_into="agentic-assets/dataset/x/examples", asset_ref=str(own))
    loose = DataSource(provider="gdrive", name="r2", reflect="copy", reflect_into="agentic-assets/dataset/x/examples")
    escaping = DataSource(provider="gdrive", name="r3", reflect="copy", reflect_into="../elsewhere", asset_ref=str(own))

    assert _target_root(held) == tmp_path / "proj" / "agentic-assets" / "dataset" / "x" / "examples"
    assert _target_root(loose) is None, "no scope: refused, not resolved against the working directory"
    assert _target_root(escaping) is None
    assert _target_root(DataSource(provider="gdrive", name="r4", reflect="copy", reflect_into=str(tmp_path / "abs"))) == tmp_path / "abs"


async def test_a_switch_turned_back_off_leaves_the_file_too(tmp_path):
    """Read only on, then off: the file must lose the key, or the next read turns the source read-only again
    (found live on the source dialog)."""
    from flow_sdk.ingest.testing import make_data_source

    src = make_data_source("folder", config={"root": str(tmp_path / "r")}, read_only=True)
    await src.save()
    main = Path(src.asset_ref) / "data_source.json"
    assert '"read_only": true' in main.read_text()

    src.read_only = False
    await src.save()
    assert '"read_only"' not in main.read_text()
    assert (await DataSource.get_one({"id": src.id})).read_only is False


def test_a_file_source_shows_the_folder_it_places_into_else_its_own_tree(tmp_path):
    """What the source page browses: a copy source's local copy, a folder source read in place, nothing
    for a record source."""
    from flow_sdk.ingest.testing import make_data_source

    own = tmp_path / "proj" / "agentic-assets" / "data_source" / "r"
    own.mkdir(parents=True)
    copy = make_data_source("gdrive", reflect="copy", reflect_into="agentic-assets/dataset/x/examples", asset_ref=str(own))
    in_place = make_data_source("folder", reflect="none", config={"root": str(tmp_path / "tree")})
    record = make_data_source("rss")

    assert copy.files_root == str(tmp_path / "proj" / "agentic-assets" / "dataset" / "x" / "examples")
    assert in_place.files_root == str((tmp_path / "tree").resolve())
    assert record.files_root is None
    assert "files_root" not in copy._hub_body(), "this machine's path never leaves it"
