"""``resolve_tab_project`` — the ONE rule order a tab's project is decided by.

One row per scenario, real entities (session SQLite fixture), run through the
function itself and through ``target_project_id`` (``for_target=True``). The
frontend's ``resolveTabProject`` (ts_sdk/src/entities/tab.ts) mirrors this order.
Lens tabs are covered by test_lens_tab_project.py (needs on-disk recovery).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.tab import Tab, ensure_tab, reconcile_tab_project, resolve_tab_project
from flow_sdk.fs_store.path_utils import canonical_posix_path

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _ptr(view_type: str, pointer: str = "", **extra: object) -> str:
    return json.dumps({"viewType": view_type, "pointer": pointer, **extra})


def _vfs(path: Path) -> str:
    return f"vfs/compute_node-@local/{canonical_posix_path(str(path)).lstrip('/')}"


@dataclass
class World:
    a: Project  # owns doc_a; mount tmp/a
    b: Project  # a second project (caller / consumer)
    inner: Project  # nested mount tmp/a/inner
    doc_a: Docs
    a_dir: Path
    inner_dir: Path


@pytest.fixture
async def world(tmp_path: Path) -> World:
    a_dir, b_dir = tmp_path / "a", tmp_path / "b"
    inner_dir = a_dir / "inner"
    inner_dir.mkdir(parents=True)
    b_dir.mkdir()
    tag = uuid.uuid4().hex[:8]
    # Projects refuse to nest unless the outer one is hidden (a system project —
    # the shape a nested mount takes in practice, e.g. the workspace root).
    a = Project(name=f"a-{tag}", fs_storage_mount_path=str(a_dir), system=True)
    b = Project(name=f"b-{tag}", fs_storage_mount_path=str(b_dir))
    inner = Project(name=f"inner-{tag}", fs_storage_mount_path=str(inner_dir))
    for p in (a, b, inner):
        await p.save()
    doc_a = Docs(title=f"doc a {tag}", project_id=a.id)
    await doc_a.save()
    return World(a=a, b=b, inner=inner, doc_a=doc_a, a_dir=a_dir, inner_dir=inner_dir)


# (name, build(world) -> (pointer, target_type, target_id, hint), expected, expected_for_target)
# ``expected*`` are attribute names on World ("a", "b", "inner"), "hint", or None.
SCENARIOS = [
    (
        "typeid asset plain open → asset's project",
        lambda w: (_ptr("assets", f"editor/markdown/typeid/markdown-{w.doc_a.id}"), "markdown", w.doc_a.id, None),
        "a", "a",
    ),
    (
        "vfs asset open → asset's project",
        lambda w: (_ptr("assets", f"editor/markdown/{_vfs(w.a_dir / 'x.md')}"), "markdown", w.doc_a.id, w.b.id),
        "a", "a",
    ),
    (
        "unminted file in nested mount → deepest project",
        lambda w: (_ptr("assets", f"editor/code/{_vfs(w.inner_dir / 'deep' / 'f.py')}"), None, None, None),
        "inner", "inner",
    ),
    (
        "raw editor file path → enclosing project",
        lambda w: (_ptr("editor", canonical_posix_path(str(w.a_dir / "notes.txt"))), None, None, None),
        "a", "a",
    ),
    (
        "flow show: rebased asset of another project → presenting project, guest",
        lambda w: (_ptr("project", f"{w.b.id}/editor/markdown/typeid/markdown-{w.doc_a.id}"), "markdown", w.doc_a.id, None),
        "b", "a",
    ),
    (
        "flow show: raw unminted file of another project → presenting project, guest",
        lambda w: (_ptr("project", f"{w.b.id}/editor/code/{_vfs(w.a_dir / 'new.py')}"), None, None, None),
        "b", "a",
    ),
    (
        "assets list scoped to a project → that project",
        lambda w: (_ptr("assets", "", tabHash=f"assets|project:{w.a.id}"), None, None, w.b.id),
        "a", None,
    ),
    (
        "assets list scope all → Global, even with a stale target",
        lambda w: (_ptr("assets", "", tabHash="assets|all"), "markdown", w.doc_a.id, w.b.id),
        None, "a",
    ),
    (
        "hosted child assets|all|@host → Global (host suffix stripped)",
        lambda w: (_ptr("assets", "", tabHash="assets|all|@agentic_process-x"), "markdown", w.doc_a.id, None),
        None, "a",
    ),
    (
        "hosted child assets|project:B|@host → B, not the target's",
        lambda w: (_ptr("assets", "", tabHash=f"assets|project:{w.b.id}|@agentic_process-x"), "markdown", w.doc_a.id, None),
        "b", "a",
    ),
    (
        "project home (Project target) → that project",
        lambda w: (_ptr("project", w.a.id), "project", w.a.id, w.b.id),
        "a", "a",
    ),
    (
        "project landing pointer, no target → that project",
        lambda w: (_ptr("project", w.a.id), None, None, None),
        "a", None,
    ),
    (
        "dependency home → consumer project",
        lambda w: (
            _ptr("assets", f"editor/markdown/typeid/markdown-{w.doc_a.id}",
                 options={"providerProject": w.a.id, "consumerProject": w.b.id},
                 tabHash=f"dependency-home|{w.a.id}|{w.b.id}"),
            "markdown", w.doc_a.id, None,
        ),
        "b", "a",
    ),
    (
        "deleted project in pointer → falls through to the target",
        lambda w: (_ptr("project", f"{uuid.uuid4()}/editor/markdown/typeid/markdown-{w.doc_a.id}"), "markdown", w.doc_a.id, None),
        "a", "a",
    ),
    (
        "web page (target-less) → the client's active project",
        lambda w: (_ptr("web_app", "https://example.com"), None, None, w.b.id),
        "hint", None,
    ),
    (
        "existing projectless target ignores the client hint → Global",
        lambda w: ("__projectless_doc__", "markdown", "__projectless_doc__", w.b.id),
        None, None,
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "build", "expected", "expected_for_target"), SCENARIOS, ids=[s[0] for s in SCENARIOS])
async def test_rule_order(world: World, name, build, expected, expected_for_target) -> None:
    pointer, target_type, target_id, hint = build(world)
    if target_id == "__projectless_doc__":
        loose = Docs(title=f"loose {uuid.uuid4().hex[:8]}")
        await loose.save()
        target_id = loose.id
        pointer = _ptr("assets", f"editor/markdown/typeid/markdown-{loose.id}")

    def want(key):
        return hint if key == "hint" else (getattr(world, key).id if key else None)

    got = await resolve_tab_project(pointer, target_type, target_id, hint=hint)
    got_target = await resolve_tab_project(pointer, target_type, target_id, for_target=True)
    assert (got, got_target) == (want(expected), want(expected_for_target)), name


@pytest.mark.asyncio
async def test_a_process_tab_follows_its_project_then_its_workdir(world: World) -> None:
    stamped = AgenticProcess(project_id=world.a.id, pty_mode=False)
    by_dir = AgenticProcess(workdir=str(world.inner_dir), pty_mode=False)
    for p in (stamped, by_dir):
        await p.save()
    for proc, expected in ((stamped, world.a.id), (by_dir, world.inner.id)):
        sub = f"agentic_process-{proc.id}"
        pointer = _ptr("shell", sub, tabHash=f"shell|{sub}")
        assert await resolve_tab_project(pointer, "agentic_process", proc.id, hint=world.b.id) == expected


@pytest.mark.asyncio
async def test_ensure_tab_stamps_the_rule_not_the_client(world: World) -> None:
    pointer = _ptr("assets", f"editor/markdown/typeid/markdown-{world.doc_a.id}")
    tab = await ensure_tab(pointer, target_type="markdown", target_id=world.doc_a.id, project_id=world.b.id)
    assert tab.project_id == world.a.id


@pytest.mark.asyncio
async def test_reconcile_leaves_a_scope_keyed_row_on_its_scope(world: World) -> None:
    """C2: a target re-stamp moves a plain tab, never a scope-keyed browser row."""
    scoped = await ensure_tab(
        _ptr("assets", "", tabHash=f"assets|project:{world.b.id}"),
        target_type="markdown", target_id=world.doc_a.id,
    )
    plain = await ensure_tab(
        _ptr("assets", f"editor/markdown/typeid/markdown-{world.doc_a.id}"),
        target_type="markdown", target_id=world.doc_a.id,
    )
    assert (scoped.project_id, plain.project_id) == (world.b.id, world.a.id)

    world.doc_a.project_id = world.inner.id
    await world.doc_a.save()  # Entity.save → reconcile_tab_project
    await reconcile_tab_project("markdown", world.doc_a.id, world.inner.id)

    assert (await Tab.get_by_id(scoped.id)).project_id == world.b.id
    assert (await Tab.get_by_id(plain.id)).project_id == world.inner.id
