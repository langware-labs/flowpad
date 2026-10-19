"""A non-prod instance writes and finds its user-scope repo assets under its own
``user_asset_root`` — never in prod's ``~/agentic-assets`` — while harness assets
(``~/.claude/skills``) stay in the shared home."""
from __future__ import annotations

import dataclasses

import pytest

from flow_sdk.assets.placement import Scope
from flow_sdk.builtin.asset_placement import resolve_destination
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


@pytest.fixture
def own_root(tmp_path, monkeypatch):
    from flow_sdk.instance_settings import get_instance_settings

    settings = dataclasses.replace(get_instance_settings(), user_home=tmp_path / "home",
                                   user_asset_home=tmp_path / "own")
    monkeypatch.setattr("flow_sdk.instance_settings.get_instance_settings", lambda: settings)
    return settings


def test_user_scope_repo_asset_lands_in_the_instance_root(own_root):
    spec = resolve_destination("spec", Scope.USER, default_worker="claude")
    skill = resolve_destination("skill", Scope.USER, default_worker="claude")

    assert spec == own_root.user_asset_root / "agentic-assets" / "spec"
    assert skill == own_root.user_home / ".claude" / "skills"


def test_the_user_home_walk_finds_the_instance_root(own_root):
    folder = own_root.user_asset_root / "agentic-assets" / "spec" / "mine"
    folder.mkdir(parents=True)
    (folder / "spec.md").write_text("---\ntitle: mine\nspec_type: plan\n---\n\nbody\n")
    own_root.user_home.mkdir()

    refs = repo_assets_fn([FSRef(own_root.user_home, record_type=RecordType.USER_HOME_FOLDER)], IndexerOptions())

    assert [ref._path for ref in refs] == [folder]
