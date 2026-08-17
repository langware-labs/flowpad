"""Unit tests for the Assets *menu* served by ``project/{id}/get-assets``.

The menu is the navigator's structure — per-type groups with counts — for the
project and, recursively, for each of its context folders. A context folder that
is itself a Project has its OWN context folders, so the walk is DFS; these tests
pin three levels of that plus the guards.

The operation is READ-ONLY. ``test_read_only_mints_nothing`` is the one that
matters most: nothing here may create a Project or a Folder, and no indexer walk
may run.

Fixture style mirrors ``tests/unit/test_project_get_assets.py`` — real Project
rows and real entity rows with ``asset_ref`` set, no mocks. Entities are written
directly rather than discovered by a walk because counting is a pure DB read
(``Entity.assets_by_path``); the indexer is not part of what's under test.

That is also what makes this file the right home for the GUARDS — cycles,
``max_depth``, ``recursive=False``, the wire shape, the one-``Project.get_all``
budget — each of which needs a tree it can shape freely and cheaply.
``tests/unit/test_project_asset_menu_indexed.py`` is the realism counterpart:
real files in their real folders, indexed for real, proving the placements and
the REAL_PROJECT_CWD/CWD_ROOT split this file cannot see.

Layout::
  <tmp>/P      Project, ctx=[C1, plain]   .claude/skills/p_skill/     skill
  <tmp>/C1     Project, ctx=[C2]          .claude/skills/c1_skill/    skill
  <tmp>/C2     Project, ctx=[C3]          docs/c2.md                  markdown
  <tmp>/C3     Project, no ctx            .claude/agents/c3.md        agent
  <tmp>/plain  NOT a Project              notes/plain.md              markdown
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AssetSource
from flow_sdk.builtin.asset_menu import BrowsingOptions
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.builtin.subagent import SubAgent
from flow_sdk.fs_store.path_utils import canonical_posix_path

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval


# ── Fixture ───────────────────────────────────────────────────────────────────


async def _make_project(root: Path, name: str, context_dirs: list[Path] | None = None) -> Project:
    """A real Project at ``root``. ``context_dirs`` go in as raw ``include_dirs``,
    which ``save()`` converts into real Folder context links via
    ``_migrate_legacy_context_dirs`` — the production path, not a shortcut."""
    root.mkdir(parents=True, exist_ok=True)
    proj = Project(
        id=str(uuid.uuid4()),
        name=name,
        fs_storage_mount_path=str(root),
        include_dirs=[str(d) for d in (context_dirs or [])],
    )
    await proj.save()
    return proj


@pytest.fixture
async def nested(tmp_path: Path, monkeypatch):
    suffix = uuid.uuid4().hex[:6]
    user_home = tmp_path / "user_home"
    user_home.mkdir(parents=True, exist_ok=True)

    from flow_sdk.instance_settings import reset_instance_settings

    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(user_home))
    reset_instance_settings()

    dirs = {k: tmp_path / k for k in ("P", "C1", "C2", "C3", "plain")}
    assets = {
        "p_skill": dirs["P"] / ".claude" / "skills" / "p_skill",
        "c1_skill": dirs["C1"] / ".claude" / "skills" / "c1_skill",
        "c2_doc": dirs["C2"] / "docs" / "c2.md",
        "c3_agent": dirs["C3"] / ".claude" / "agents" / "c3.md",
        "plain_doc": dirs["plain"] / "notes" / "plain.md",
    }
    for p in assets.values():
        if p.suffix == ".md":
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("# stub\n")
        else:
            p.mkdir(parents=True, exist_ok=True)

    # Bottom-up: each level links the one below it.
    c3 = await _make_project(dirs["C3"], f"c3_{suffix}")
    c2 = await _make_project(dirs["C2"], f"c2_{suffix}", [dirs["C3"]])
    c1 = await _make_project(dirs["C1"], f"c1_{suffix}", [dirs["C2"]])
    p = await _make_project(dirs["P"], f"p_{suffix}", [dirs["C1"], dirs["plain"]])

    async def _save(e):
        await e.save()
        return e

    ents = {
        "p_skill": await _save(Skill(
            id=str(uuid.uuid4()), name=f"p_skill_{suffix}",
            asset_ref=canonical_posix_path(assets["p_skill"]),
        )),
        "c1_skill": await _save(Skill(
            id=str(uuid.uuid4()), name=f"c1_skill_{suffix}",
            asset_ref=canonical_posix_path(assets["c1_skill"]),
        )),
        "c2_doc": await _save(Docs(
            id=str(uuid.uuid4()), name=f"c2_doc_{suffix}",
            asset_ref=canonical_posix_path(assets["c2_doc"]),
        )),
        "c3_agent": await _save(SubAgent(
            id=str(uuid.uuid4()), name=f"c3_agent_{suffix}",
            asset_ref=canonical_posix_path(assets["c3_agent"]),
        )),
        "plain_doc": await _save(Docs(
            id=str(uuid.uuid4()), name=f"plain_doc_{suffix}",
            asset_ref=canonical_posix_path(assets["plain_doc"]),
        )),
    }

    yield {"p": p, "c1": c1, "c2": c2, "c3": c3, "dirs": dirs, "ents": ents}

    for e in [p, c1, c2, c3, *ents.values()]:
        try:
            await e.delete()
        except Exception:
            pass
    reset_instance_settings()


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _menu(project: Project, **opts) -> dict:
    resp = await project.get_assets_action(browsing=BrowsingOptions(menu=True, **opts))
    return resp.data["menu"]


def _walk(node: dict):
    yield node
    for child in node.get("children") or []:
        yield from _walk(child)


def _by_path(root: dict) -> dict[str, dict]:
    return {n["path"]: n for n in _walk(root)}


def _count(node: dict, type_name: str) -> int:
    return next((g["count"] for g in node["groups"] if g["type_name"] == type_name), 0)


def _own(node: dict, type_name: str) -> int:
    return next((g["own_count"] for g in node["groups"] if g["type_name"] == type_name), 0)


def _total(node: dict) -> int:
    return sum(g["count"] for g in node["groups"])


# ── Cases ─────────────────────────────────────────────────────────────────────


async def test_default_response_unchanged(nested):
    """No ``browsing`` ⇒ byte-identical to what the action returned before."""
    resp = await nested["p"].get_assets_action()
    assert set(resp.data.keys()) == {"assets", "truncated"}


async def test_menu_absent_unless_requested(nested):
    resp = await nested["p"].get_assets_action(browsing=BrowsingOptions(menu=False))
    assert "menu" not in resp.data


async def test_assets_false_skips_the_flat_scan(nested):
    """A menu-only caller shouldn't pay for the descriptor scan it discards."""
    resp = await nested["p"].get_assets_action(browsing=BrowsingOptions(menu=True, assets=False))
    assert resp.data["assets"] == []
    assert resp.data["menu"]["root"]["groups"], "the menu itself must still be built"
    # Default keeps the flat list — every existing caller is unchanged.
    full = await nested["p"].get_assets_action(browsing=BrowsingOptions(menu=True))
    assert full.data["assets"]


async def test_three_level_nesting_dfs(nested):
    menu = await _menu(nested["p"])
    root = menu["root"]
    assert root["path"] == canonical_posix_path(nested["dirs"]["P"])
    assert root["source"] == AssetSource.PROJECT_DIR.value
    assert root["depth"] == 0

    by_path = _by_path(root)
    chain = ["C1", "C2", "C3"]
    for depth, key in enumerate(chain, start=1):
        node = by_path[canonical_posix_path(nested["dirs"][key])]
        assert node["depth"] == depth, f"{key} at wrong depth"
        assert node["source"] == AssetSource.CONTEXT_DIR.value
        assert node["is_project"] is True

    # …and the chain is genuinely nested, not flattened onto the root.
    c1 = next(c for c in root["children"] if c["name"].startswith("c1_"))
    c2 = c1["children"][0]
    assert c2["children"][0]["name"].startswith("c3_")


async def test_counts_accumulate_up_the_tree(nested):
    menu = await _menu(nested["p"])
    root = menu["root"]
    by_path = _by_path(root)
    c1 = by_path[canonical_posix_path(nested["dirs"]["C1"])]
    c3 = by_path[canonical_posix_path(nested["dirs"]["C3"])]

    # The invariant, everywhere: count == own + sum(children counts).
    for node in _walk(root):
        for group in node["groups"]:
            children_total = sum(_count(c, group["type_name"]) for c in node["children"])
            assert group["count"] == group["own_count"] + children_total, (
                f"{node['name']}/{group['type_name']} broke the accumulation invariant"
            )

    assert _own(root, "skill") == 1          # P's own
    assert _count(root, "skill") == 2        # + C1's
    assert _count(root, "markdown") == 2     # C2's + plain's
    assert _count(root, "subagent") == 1        # C3's, three levels down
    assert _total(root) == 5
    assert _count(c3, "subagent") == _own(c3, "subagent") == 1
    assert _total(c1) == 3                   # c1_skill + c2 doc + c3 agent


async def test_non_project_context_folder_is_leaf_with_counts(nested):
    menu = await _menu(nested["p"])
    plain = _by_path(menu["root"])[canonical_posix_path(nested["dirs"]["plain"])]
    assert plain["is_project"] is False
    assert plain["project_id"] is None
    assert plain["never_indexed"] is None    # not a project ⇒ no index state
    assert plain["children"] == []           # nothing to recurse into
    assert _count(plain, "markdown") == 1    # but its assets still count


async def test_recursive_false_stops_at_direct_children(nested):
    menu = await _menu(nested["p"], recursive=False)
    root = menu["root"]
    assert root["children"] == []
    assert _count(root, "subagent") == 0        # C3 is three levels away
    assert _count(root, "skill") == 1        # only P's own


async def test_max_depth_caps_the_walk(nested):
    menu = await _menu(nested["p"], max_depth=2)
    by_path = _by_path(menu["root"])
    assert canonical_posix_path(nested["dirs"]["C2"]) in by_path
    assert canonical_posix_path(nested["dirs"]["C3"]) not in by_path
    c2 = by_path[canonical_posix_path(nested["dirs"]["C2"])]
    # No phantom descendants folded into a node whose children were cut.
    assert _count(c2, "markdown") == _own(c2, "markdown") == 1
    assert _count(c2, "subagent") == 0


async def test_cycle_terminates(nested):
    """C3 links back to P. The walk must finish and visit each path once."""
    c3 = nested["c3"]
    # ``include_dirs`` is computed — the writable seam is the legacy stash,
    # which ``save()`` converts into real Folder context links.
    c3.legacy_include_dirs_ = [str(nested["dirs"]["P"])]
    await c3.save()
    assert canonical_posix_path(nested["dirs"]["P"]) in c3.include_dirs

    menu = await _menu(nested["p"])
    paths = [n["path"] for n in _walk(menu["root"])]
    assert len(paths) == len(set(paths)), "a path was visited twice"
    root_path = canonical_posix_path(nested["dirs"]["P"])
    assert paths.count(root_path) == 1
    c3_node = _by_path(menu["root"])[canonical_posix_path(nested["dirs"]["C3"])]
    assert c3_node["children"] == []  # the back-edge to P was dropped


async def test_read_only_mints_nothing(nested):
    """The hard constraint: no Project, no Folder, no write."""
    projects_before = len(await Project.get_all())
    folders_before = len(await Folder.get_all())

    await _menu(nested["p"])

    assert len(await Project.get_all()) == projects_before
    assert len(await Folder.get_all()) == folders_before
    # The non-project context folder was NOT promoted to a Project.
    assert await Project.find_by_cwd(str(nested["dirs"]["plain"])) is None


async def test_never_indexed_is_per_node(nested):
    """A missing sentinel on ONE project must not be reported for the others —
    the whole reason this is a per-node flag and not a single scope answer."""
    record = await nested["c2"].get_record()
    record.clear_hash()

    by_path = _by_path((await _menu(nested["p"]))["root"])
    assert by_path[canonical_posix_path(nested["dirs"]["C2"])]["never_indexed"] is True
    for key in ("P", "C1", "C3"):
        assert by_path[canonical_posix_path(nested["dirs"][key])]["never_indexed"] is False


async def test_one_project_read_for_the_whole_walk(nested, monkeypatch):
    """A DFS that resolved each context dir with ``find_by_cwd`` would do one
    full project read PER path. Counting the real calls is the only way that
    regression stays visible."""
    calls = {"n": 0}
    real = Project.get_all.__func__

    async def counting(cls, *args, **kwargs):
        calls["n"] += 1
        return await real(cls, *args, **kwargs)

    monkeypatch.setattr(Project, "get_all", classmethod(counting))
    await _menu(nested["p"])
    assert calls["n"] == 1, f"expected one Project.get_all for a 4-level walk, got {calls['n']}"


async def test_node_and_group_row_shape(nested):
    """The wire shape is counts + structure only. A group carries NO per-type
    registry metadata (icon / label / view-mode tier): the client holds the type
    registry synchronously from bootstrap, so re-sending it per response would
    be a second, staler copy."""
    menu = await _menu(nested["p"])
    for node in _walk(menu["root"]):
        assert set(node.keys()) == {
            "path", "name", "source", "depth", "project_id", "is_project",
            "folder_typeid", "origin_kind", "never_indexed", "groups", "children",
        }
        for group in node["groups"]:
            assert set(group.keys()) == {"type_name", "own_count", "count"}


async def test_types_param_narrows_the_menu(nested):
    resp = await nested["p"].get_assets_action(
        types="skill", browsing=BrowsingOptions(menu=True)
    )
    for node in _walk(resp.data["menu"]["root"]):
        assert {g["type_name"] for g in node["groups"]} <= {"skill"}
