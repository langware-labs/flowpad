"""A real, indexed project tree with nested context folders.

Builds a project whose assets live in their genuine on-disk locations, links a
chain of context folders under it (one of them a git worktree with a ``file://``
origin), and indexes the whole thing through the PRODUCTION path — so a test
asserting on the asset menu is asserting that the indexer really discovers what
the layout claims.

The inventory is declared once in :data:`ASSET_TREE_LAYOUT`; the expected
per-node counts are derived from it, so an assertion never restates a magic
number that could drift from the files on disk.

**Only four types are placed: skill, agent, markdown, task.** Those are exactly
the types whose walkers are registered on BOTH root types
(``flow_sdk/fs_store/indexer/builtin.py``): a project mount is walked as
``REAL_PROJECT_CWD``, but a context folder is walked as ``CWD_ROOT`` by
``_index_additional_dir``. ``prompt`` (REAL_PROJECT_CWD only) and
``claude_memory`` (``~/.claude/projects/<encoded>/`` only) would silently vanish
from a context folder and are deliberately absent.

No pytest constructs live here — the builder is plain async functions taking a
base directory, so ``scripts/seed_asset_tree.py`` can drive a live instance with
the same layout the tests assert on.
"""

from __future__ import annotations

import subprocess
import uuid
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.builtin.project import Project

# ── The layout, declared once ────────────────────────────────────────────────

# Placement per type. The walker that discovers each one is named so a failing
# discovery assertion points at the code that changed.
#   skill    -> .claude/skills/<name>/SKILL.md        functions/skill.py
#   agent    -> .claude/agents/<name>.md              functions/agent.py
#   markdown -> docs/<name>.md                        functions/markdown.py
#   task     -> agentic-assets/task/<name>/task.md    functions/repo_assets.py
ASSET_TYPES = ("skill", "agent", "markdown", "task")

_TASK_MD = "---\nid: {tid}\ntitle: {name}\nstatus: to_do\ntask_type: Task\nkind: standard\n---\n\n# {name}\n"


@dataclass(frozen=True)
class NodeSpec:
    """One folder in the tree and everything that is true about it."""

    key: str
    rel_path: str
    #: ``mount`` = the project this menu is built for; ``project`` = a context
    #: folder that is itself a Project (so the walk recurses into it);
    #: ``git`` = same, but a git worktree; ``plain`` = a bare directory (leaf).
    kind: str
    #: Whose context folder this is. None for the mount.
    parent_key: str | None = None
    link_scope: str = "private"
    assets: dict[str, int] = field(default_factory=dict)

    @property
    def is_project(self) -> bool:
        return self.kind in ("mount", "project", "git")


ASSET_TREE_LAYOUT: tuple[NodeSpec, ...] = (
    NodeSpec("P", "proj", "mount", assets={"skill": 1, "agent": 1, "markdown": 1, "task": 1}),
    # A git worktree over a file:// origin. Linked SHARED, which only succeeds
    # for a transportable origin — so the link itself asserts that
    # ``Folder.detect_origin`` read the local remote as a GitOrigin.
    NodeSpec("GIT", "git", "git", parent_key="P", link_scope="shared", assets={"skill": 1, "markdown": 1}),
    NodeSpec("A", "a", "project", parent_key="P", assets={"skill": 1, "agent": 1}),
    NodeSpec("B", "b", "project", parent_key="A", assets={"markdown": 1, "task": 1}),
    # Deliberately nested ON DISK inside B: B's path is a strict prefix of this
    # one, so it is the only node that exercises the menu's longest-prefix
    # attribution. `c_agent` must land here, never in B.
    NodeSpec("C", "b/inner", "project", parent_key="B", assets={"agent": 1}),
    NodeSpec("PLAIN", "plain", "plain", parent_key="P", assets={"markdown": 1}),
)


@dataclass
class AssetTree:
    """A built tree: where everything is, and what the menu should report."""

    base: Path
    projects: dict[str, Project]
    layout: tuple[NodeSpec, ...] = ASSET_TREE_LAYOUT

    def spec(self, key: str) -> NodeSpec:
        return next(s for s in self.layout if s.key == key)

    def path(self, key: str) -> Path:
        return self.base / self.spec(key).rel_path

    def node_keys(self) -> tuple[str, ...]:
        return tuple(s.key for s in self.layout)

    def children_of(self, key: str) -> tuple[str, ...]:
        return tuple(s.key for s in self.layout if s.parent_key == key)

    def expected_own(self, key: str) -> dict[str, int]:
        """What lives in THIS folder alone — straight off the spec."""
        return {t: n for t, n in self.spec(key).assets.items() if n}

    def expected_total(self, key: str) -> dict[str, int]:
        """Own plus every descendant's, the post-order rollup the menu does."""
        acc = Counter(self.expected_own(key))
        for child in self.children_of(key):
            acc.update(self.expected_total(child))
        return dict(acc)


# ── Writers ──────────────────────────────────────────────────────────────────


def _write_asset(root: Path, type_name: str, name: str) -> Path:
    """Write one asset of ``type_name`` where its walker will find it."""
    if type_name == "skill":
        target = root / ".claude" / "skills" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {name} fixture skill\n---\n\n# {name}\n", encoding="utf-8"
        )
        return target
    if type_name == "agent":
        target = root / ".claude" / "agents" / f"{name}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            f"---\nname: {name}\ndescription: {name} fixture agent\n---\n\n{name} system prompt\n", encoding="utf-8"
        )
        return target
    if type_name == "markdown":
        # NOT under .claude/skills|agents or agentic-assets/task — markdown skips
        # any file with a typed-record ancestor, so those would silently vanish.
        target = root / "docs" / f"{name}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {name}\n\nfixture note\n", encoding="utf-8")
        return target
    if type_name == "task":
        # `agentic-assets/task/`, discovered by repo_assets_fn. The `tasks/`
        # layout that task_fn scans is dead code — never registered.
        target = root / "agentic-assets" / "task" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "task.md").write_text(
            _TASK_MD.format(tid=str(uuid.uuid4()), name=name), encoding="utf-8"
        )
        return target
    if type_name == "plan":
        target = root / ".claude" / "plans" / f"{name}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"---\ntitle: {name}\n---\n\n# {name}\n\nfixture plan\n", encoding="utf-8")
        return target
    if type_name == "claude_rules":
        target = root / ".claude" / "rules" / f"{name}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {name}\n\nfixture rule\n", encoding="utf-8")
        return target
    if type_name == "whiteboard":
        # whiteboard_fn requires the WHITE_BOARD.md marker; board.json is the
        # scene the editor loads.
        target = root / ".claude" / "whiteboards" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "WHITE_BOARD.md").write_text(
            f'---\nname: {name}\ndescription: ""\n---\n\n# {name}\n', encoding="utf-8"
        )
        (target / "board.json").write_text(
            '{"kind":"excalidraw","version":1,"data":{"elements":[],"appState":{},"files":{}}}',
            encoding="utf-8",
        )
        return target
    if type_name == "spec":
        # Repo-asset family like task; spec's asset_ref is the inner spec.md.
        target = root / "agentic-assets" / "spec" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "spec.md").write_text(
            f"---\nid: {uuid.uuid4()}\ntitle: {name}\nspec_type: plan\n---\n\n# {name}\n\nfixture spec\n",
            encoding="utf-8",
        )
        return target
    raise ValueError(f"unsupported fixture asset type: {type_name}")


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _make_pushed_worktree(base: Path, worktree: Path) -> Path:
    """A bare ``file://`` remote plus a clean, fully pushed clone of it.

    Fully pushed is the only state a folder share is eligible in — the receiver
    clones the origin, so an unpushed commit is unreachable. Identity is
    configured repo-locally so a machine with no global git identity fails fast
    here instead of hanging on the commit.
    """
    origin = base / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)
    _git(base, "clone", "-q", origin.resolve().as_uri(), str(worktree))
    _git(worktree, "checkout", "-q", "-b", "main")
    _git(worktree, "config", "user.email", "fixture@example.test")
    _git(worktree, "config", "user.name", "Fixture")
    # .flow holds the identity capsules the indexer writes back; keeping them
    # untracked would leave the seeded repo permanently dirty.
    (worktree / ".gitignore").write_text(".flow/\n", encoding="utf-8")
    _git(worktree, "add", "-A")
    _git(worktree, "commit", "-qm", "fixture assets")
    _git(worktree, "push", "-q", "-u", "origin", "main")
    return origin


# ── Build / teardown ─────────────────────────────────────────────────────────


async def build_asset_tree(
    base: Path,
    *,
    suffix: str | None = None,
    index: bool = True,
    force: bool = False,
) -> AssetTree:
    """Materialize :data:`ASSET_TREE_LAYOUT` under ``base`` and index it.

    ``base`` is required and never defaulted: indexing writes identity capsules
    (``.flow/``, frontmatter ``id:``) back into the files, so this must only ever
    run somewhere the caller chose. A non-empty ``base`` is refused unless
    ``force``; pass ``index=False`` to lay down bytes without touching the DB.

    Context folders are linked with the real ``add_context_dir`` action, which
    indexes each one as it goes — that is what makes this an integration fixture
    rather than a re-implementation of the walk. Only the project's own mount is
    indexed directly, because nothing links it.
    """
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import IndexerOptions
    from flow_sdk.fs_store.indexer.builtin import get_shared_indexer
    from flow_sdk.fs_store.record_types import RecordType

    if base.exists() and any(base.iterdir()) and not force:
        raise RuntimeError(f"{base} is not empty — pass force=True to build into it anyway")
    base.mkdir(parents=True, exist_ok=True)
    suffix = suffix or uuid.uuid4().hex[:6]

    # 1. Every file on disk first, so each add_context_dir indexes a populated
    #    folder. The git worktree is cloned before its assets are written.
    by_key = {s.key: s for s in ASSET_TREE_LAYOUT}
    for spec in ASSET_TREE_LAYOUT:
        root = base / spec.rel_path
        if spec.kind == "git":
            _make_pushed_worktree(base, root)
        else:
            root.mkdir(parents=True, exist_ok=True)
        for type_name, count in spec.assets.items():
            for i in range(count):
                _write_asset(root, type_name, f"{spec.key.lower()}_{type_name}{'' if count == 1 else i}")
        if spec.kind == "git":
            _git(root, "add", "-A")
            _git(root, "commit", "-qm", "assets")
            _git(root, "push", "-q", "origin", "main")

    if not index:
        return AssetTree(base=base, projects={})

    # 2. Projects bottom-up, linking each child before its parent exists, so
    #    every add_context_dir walks a folder whose own links are already set.
    projects: dict[str, Project] = {}

    async def _make_project(key: str) -> Project:
        root = base / by_key[key].rel_path
        proj = Project(
            id=Project.derive_id_for_path(str(root)),
            name=f"{key.lower()}-{suffix}",
            fs_storage_mount_path=str(root),
        )
        await proj.save()
        projects[key] = proj
        return proj

    for key in ("C", "B", "A", "GIT", "P"):
        if by_key[key].is_project:
            await _make_project(key)

    for spec in ASSET_TREE_LAYOUT:
        if spec.parent_key is None:
            continue
        parent = projects[spec.parent_key]
        # The real action: mints the Folder, links the bucket, and indexes the
        # folder as CWD_ROOT. A shared link is rejected unless the origin is
        # transportable, so the GIT node's link is itself an assertion.
        resp = await parent.add_context_dir(str(base / spec.rel_path), scope=spec.link_scope)
        if getattr(resp, "status_code", 200) >= 400:
            raise RuntimeError(f"add_context_dir({spec.key}, {spec.link_scope}) failed: {resp.message}")

    # 3. The mount is nobody's context folder, so index it directly — as
    #    REAL_PROJECT_CWD, the root type a project mount really gets.
    root_project = projects["P"]
    await get_shared_indexer().index(
        IndexerOptions(
            roots=(
                FSRef(
                    base / by_key["P"].rel_path,
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="project",
                    project_id=root_project.id,
                ),
            ),
            # Narrow the walk: without this the claude-session / hook / mcp
            # walkers all run and the fixture stops fitting its time budget.
            types=[RecordType.SKILL, RecordType.AGENT, RecordType.MARKDOWN, RecordType.TASK],
            include_temp=True,
            force=True,
            verbose=False,
        )
    )

    return AssetTree(base=base, projects=projects)


async def teardown_asset_tree(tree: AssetTree) -> None:
    """Delete the Projects and their Folder links.

    The test DB is session-scoped while tmp paths are per-test, so a surviving
    Project row pointing at a deleted directory would perturb any later test that
    reads projects globally (``Project.index_by_mount``). The indexed asset rows
    are deliberately left: their ``asset_ref`` values are unique tmp paths, so no
    path-scoped query can collide with them.
    """
    from flow_sdk.builtin.folder import Folder

    for proj in tree.projects.values():
        for tid in list(proj.context_of_type("folder", bucket="both")):
            try:
                folder = await Folder.get_by_id(tid.id)
                if folder is not None:
                    await folder.delete()
            except Exception:
                pass
        try:
            await proj.delete()
        except Exception:
            pass
