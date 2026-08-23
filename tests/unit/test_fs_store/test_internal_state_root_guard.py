"""Guard: Flowpad's own state dir is never walked.

Sibling of ``test_real_project_cwd_home_guard``. That one covers a root at or
ABOVE ``$HOME``; ``flow_home`` sits BELOW it, so the ancestor check lets it
through.

``<flow_home>/instances/<name>/`` holds per-instance DBs and a ``records/``
shadow tree, so walking it makes the indexer walk its own output — and it
compounds, since every launched instance adds another root that grows with use.

Asserted through ``indexing_decision`` (the gate both root resolvers call)
rather than a private predicate, so the property holds for any future resolver.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.fs_store.indexer import special_folders as sf_mod
from flow_sdk.fs_store.indexer.special_folders import (
    FolderKind,
    IndexDecision,
    classify_special_folder,
    indexing_decision,
)


@pytest.fixture
def flow_home(tmp_path, monkeypatch):
    """A relocated ``flow_home`` — proves no literal ``~/.flow`` is baked in.

    Patched at the settings seam (``special_folders`` reads it lazily per call)
    rather than via env, so it binds deterministically instead of depending on
    whether settings happen to be cached in this process.
    """
    root = tmp_path / "relocated" / "flowhome"
    (root / "instances" / "inst" / "records" / "project").mkdir(parents=True)
    monkeypatch.setattr(
        sf_mod, "get_instance_settings", lambda: SimpleNamespace(flow_home=root), raising=False
    )
    monkeypatch.setattr(
        "flow_sdk.instance_settings.get_instance_settings",
        lambda: SimpleNamespace(flow_home=root),
    )
    sf_mod._special_folders_for_home.cache_clear()
    yield root
    sf_mod._special_folders_for_home.cache_clear()


@pytest.mark.parametrize(
    "rel",
    [
        "",                              # flow_home itself
        "instances",                     # the instances dir
        "instances/inst",                # one instance root
        "instances/inst/records/project",  # deep inside the shadow tree
    ],
)
def test_flow_home_is_never_walked(flow_home, rel):
    target = flow_home / rel if rel else flow_home
    assert indexing_decision(target) is IndexDecision.SKIP


def test_flow_home_is_hardskip_so_it_is_never_even_offered(flow_home):
    """HARDSKIP, not TRISTATE: there is no consent question to ask about our own
    storage, and a foreground (explicit) open must not walk it either."""
    assert classify_special_folder(flow_home).kind is FolderKind.HARDSKIP
    assert indexing_decision(flow_home, foreground=True) is IndexDecision.SKIP


def test_a_sibling_sharing_the_prefix_is_still_walked(flow_home):
    """Segment-safe: ``<flow_home>data`` must not be swallowed by ``<flow_home>``."""
    sibling = Path(str(flow_home) + "data")
    sibling.mkdir(parents=True)
    assert indexing_decision(sibling) is IndexDecision.WALK


def test_an_ordinary_project_is_still_walked(flow_home, tmp_path):
    project = tmp_path / "dev" / "repo"
    project.mkdir(parents=True)
    assert indexing_decision(project) is IndexDecision.WALK


def test_flow_home_is_not_a_valid_project_cwd(flow_home):
    """The mint-time half: a path inside our state dir must never become a
    project cwd in the first place.

    ``is_valid_project_cwd`` gates project discovery and materialization, so
    widening ``is_protected_path`` to ``flow_home`` is what stops these rows
    being created — and, because the filter applies on read, stops the ones
    already in the DB from being listed. The walk-time HARDSKIP above is the
    second line of defense, not the only one.
    """
    from flow_sdk.fs_store.path_utils import is_protected_path, is_valid_project_cwd

    # `include_temp=True` throughout: the fixture lives under the pytest tmp
    # dir, which `is_valid_project_cwd` rejects for an unrelated reason. This
    # test is about flow_home, so the temp axis is held constant.
    instance_dir = flow_home / "instances" / "inst"
    assert is_protected_path(instance_dir) is True
    assert is_valid_project_cwd(instance_dir, include_temp=True) is False

    # A workspace-local `.flow/` is somebody else's directory, not our state —
    # the real corpus has one (`Flowpad workspace/.flow/helpdesk/...`) and it
    # must keep resolving.
    workspace_flow = flow_home.parent / "workspace" / ".flow" / "helpdesk"
    workspace_flow.mkdir(parents=True)
    assert is_valid_project_cwd(workspace_flow, include_temp=True) is True
