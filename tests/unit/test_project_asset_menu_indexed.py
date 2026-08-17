"""The asset menu over a REALLY indexed tree.

The realism counterpart to ``tests/unit/test_project_asset_menu.py``, which
writes entity rows directly with a chosen ``asset_ref``. That file can pin the
menu's guards (cycles, ``max_depth``, ``recursive=False``, wire shape, the
one-``Project.get_all`` budget) precisely because it has no indexer in it — and
for the same reason it structurally cannot prove the two things this file exists
for:

* assets placed in their genuine on-disk folders are actually **discovered**;
* a context folder, which is walked as ``CWD_ROOT`` by ``_index_additional_dir``,
  finds the same types as a project mount, which is walked as
  ``REAL_PROJECT_CWD``. Only skill / agent / markdown / task register on both —
  the fixture places exactly those.

Every expectation comes from ``ASSET_TREE_LAYOUT``, so the assertions cannot
drift from the files on disk. No mocks: real Projects, real files, the real
indexer, and the real ``add_context_dir`` action doing the linking.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# Register every walker + TypeInfo. Pytest does not run the server startup path.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.builtin.agentic_process.agentic_process import AssetSource
from flow_sdk.builtin.asset_menu import BrowsingOptions
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from tests.fixtures.asset_tree import ASSET_TYPES, build_asset_tree, teardown_asset_tree

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval


@pytest.fixture
async def tree(tmp_path: Path, monkeypatch):
    from flow_sdk.instance_settings import reset_instance_settings

    # FLOW_INSTANCE is load-bearing: without it `.env.local`'s FLOW_INSTANCE=oss
    # wins the resolver and FLOWPAD_TEST_SANDBOX is silently ignored — the path
    # where a test writes into the developer's real instance.
    user_home = tmp_path / "user_home"
    user_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(user_home))
    # Pin the in-process scan. get_shared_indexer() is in-process today, but the
    # auto-index default is SUBPROCESS; a future flip would put this fixture in a
    # fork-per-folder regime that cannot fit the 30s cap.
    monkeypatch.setenv("FLOWPAD_INDEX_SCAN_MODE", "thread")
    reset_instance_settings()

    # NOT tmp_path itself: the autouse `isolated_records_root` puts the records
    # store at tmp_path/records, and rooting the walk there indexes the shadow store.
    built = await build_asset_tree(tmp_path / "tree")
    yield built
    await teardown_asset_tree(built)
    reset_instance_settings()


# ── Helpers (mirrors of the ones in test_project_asset_menu.py) ──────────────


async def _menu(tree, **opts) -> dict:
    resp = await tree.projects["P"].get_assets_action(browsing=BrowsingOptions(menu=True, **opts))
    return resp.data["menu"]


def _walk(node: dict):
    yield node
    for child in node.get("children") or []:
        yield from _walk(child)


def _by_path(root: dict) -> dict[str, dict]:
    return {n["path"]: n for n in _walk(root)}


def _node(tree, root: dict, key: str) -> dict:
    return _by_path(root)[canonical_posix_path(tree.path(key))]


def _count(node: dict, type_name: str) -> int:
    return next((g["count"] for g in node["groups"] if g["type_name"] == type_name), 0)


def _own(node: dict, type_name: str) -> int:
    return next((g["own_count"] for g in node["groups"] if g["type_name"] == type_name), 0)


def _total(node: dict) -> int:
    return sum(g["count"] for g in node["groups"])


# ── Cases ────────────────────────────────────────────────────────────────────


async def test_indexer_discovered_every_declared_asset(tree):
    """Anti-vacuity gate. If a walker stops finding a placement, this says WHICH
    node and WHICH type — the other tests would only report a wrong number."""
    from flow_sdk.core.entity.entity_model import Entity, PathQueryOptions

    for key in tree.node_keys():
        expected = tree.expected_own(key)
        if not expected:
            continue
        entities = await Entity.assets_by_path(
            PathQueryOptions(search_dirs=[str(tree.path(key))], types=list(ASSET_TYPES), limit=500)
        )
        found: dict[str, int] = {}
        for ent in entities:
            t = ent.type or ent.get_type()
            found[t] = found.get(t, 0) + 1
        for type_name, n in expected.items():
            assert found.get(type_name, 0) >= n, (
                f"{key}: expected >= {n} {type_name} under {tree.path(key)}, found {found.get(type_name, 0)}"
            )


async def test_own_counts_match_the_declared_inventory(tree):
    root = (await _menu(tree))["root"]
    for key in tree.node_keys():
        node = _node(tree, root, key)
        expected = tree.expected_own(key)
        for type_name in ASSET_TYPES:
            assert _own(node, type_name) == expected.get(type_name, 0), (
                f"{key}/{type_name}: own_count disagrees with the fixture inventory"
            )
        # Nothing undeclared crept in (a stray .md, a README, a git artifact).
        undeclared = {g["type_name"] for g in node["groups"] if g["own_count"] and g["type_name"] not in expected}
        assert not undeclared, f"{key}: undeclared types counted: {undeclared}"


async def test_counts_accumulate_up_the_tree(tree):
    root = (await _menu(tree))["root"]

    # The universal invariant, at every node and every type.
    for node in _walk(root):
        for group in node["groups"]:
            children_total = sum(_count(c, group["type_name"]) for c in node["children"])
            assert group["count"] == group["own_count"] + children_total, (
                f"{node['name']}/{group['type_name']} broke the accumulation invariant"
            )

    # …and each node's accumulated total is what the declared layout implies.
    for key in tree.node_keys():
        node = _node(tree, root, key)
        expected = tree.expected_total(key)
        for type_name in ASSET_TYPES:
            assert _count(node, type_name) == expected.get(type_name, 0), (
                f"{key}/{type_name}: accumulated count disagrees with the rolled-up inventory"
            )


async def test_root_totals(tree):
    """Literal tripwire, independent of the fixture's own rollup helper — so a
    bug in expected_total() cannot hide a bug in the menu's roll_up()."""
    root = (await _menu(tree))["root"]
    assert {g["type_name"]: g["count"] for g in root["groups"]} == {
        "skill": 3,
        "subagent": 3,
        "markdown": 4,
        "task": 2,
    }
    assert _total(root) == 12


async def test_deepest_node_wins_for_nested_context_project(tree):
    """C lives on disk INSIDE B, so B's path is a strict prefix of C's. The
    agent there must be attributed to C alone, and only accumulate into B."""
    root = (await _menu(tree))["root"]
    b, c = _node(tree, root, "B"), _node(tree, root, "C")
    assert _own(c, "subagent") == 1
    assert _own(b, "subagent") == 0
    assert _count(b, "subagent") == 1


async def test_three_level_nesting_and_depths(tree):
    root = (await _menu(tree))["root"]
    by_path = _by_path(root)
    assert root["path"] == canonical_posix_path(tree.path("P"))
    assert root["depth"] == 0
    assert root["source"] == AssetSource.PROJECT_DIR.value

    for key, depth in (("GIT", 1), ("A", 1), ("PLAIN", 1), ("B", 2), ("C", 3)):
        node = by_path[canonical_posix_path(tree.path(key))]
        assert node["depth"] == depth, f"{key} at wrong depth"
        assert node["source"] == AssetSource.CONTEXT_DIR.value
        assert node["is_project"] is tree.spec(key).is_project


async def test_git_context_folder_is_shared_and_reports_its_origin(tree):
    """The shared link only succeeds for a transportable origin, so building the
    fixture already proved detect_origin read the file:// remote as git. Here we
    pin what the menu and the project report about it — plus the control."""
    root = (await _menu(tree))["root"]
    git_node = _node(tree, root, "GIT")
    assert git_node["origin_kind"] == "git"
    assert git_node["folder_typeid"], "the linked Folder's typeid should ride along for the UI"

    git_path = canonical_posix_path(tree.path("GIT"))
    info = next(i for i in tree.projects["P"].context_dir_infos if i["path"] == git_path)
    assert info["origin_kind"] == "git"

    origin = await Folder.detect_origin(git_path)
    assert origin.kind == "git"
    assert origin.transportable is True

    # Control: a plain directory cannot be shared, so the check above is not
    # passing for some reason unrelated to the origin.
    plain_origin = await Folder.detect_origin(canonical_posix_path(tree.path("PLAIN")))
    assert plain_origin.transportable is False
    resp = await tree.projects["P"].add_context_dir(str(tree.path("PLAIN")), scope="shared")
    assert resp.status_code >= 400
    assert "git-backed" in resp.message


async def test_plain_folder_is_a_leaf_with_counts(tree):
    root = (await _menu(tree))["root"]
    plain = _node(tree, root, "PLAIN")
    assert plain["is_project"] is False
    assert plain["project_id"] is None
    assert plain["never_indexed"] is None
    assert plain["children"] == []
    assert _count(plain, "markdown") == 1


async def test_menu_is_read_only_after_a_real_index(tree):
    """Strongest form of the read-only guarantee: there is real indexed data
    here, which is exactly what a find-or-create could latch onto."""
    projects_before = len(await Project.get_all())
    folders_before = len(await Folder.get_all())

    await _menu(tree)

    assert len(await Project.get_all()) == projects_before
    assert len(await Folder.get_all()) == folders_before
    assert await Project.find_by_cwd(str(tree.path("PLAIN"))) is None
