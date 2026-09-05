"""Capture tests for the two asset change-tracking gaps (RCA test-mode).

Drives the REAL autoversion hook (``autoversion_commit_local`` — the function the
``fs.write`` action calls on every save) against a real temporary git repo, then
reads revisions / diffs back with the EXACT git commands the git-ops endpoints
wrap:

    get_file_revisions   →  git log --follow -- <file>        (git_repo.py:323)
    compare_file_revision →  git diff <rev> HEAD -- <file>     (git_repo.py:359)

The HTTP route (tests/api/test_git_ops_file_revisions.py) already proves those
endpoints are thin pass-throughs of these commands, so asserting on the git
history those commands read is equivalent to "what the endpoint returns" — at the
narrowest layer that still reproduces. No behavior is mocked: the only adapter is
the path-resolution storage seam (same minimal stand-in as test_asset_versioning).

Matrix (asset shape × scenario):

                              real change returned     no-op not returned
    single-file (agent)       P1  expected pass        N1  GAP 1  → fails today
    folder, main md (skill)   P2  expected pass
    folder, internal (skill)  P3  GAP 2  → fails today
    folder, main JSON (mcp)                           N2  GAP 3  → fails today

GAP 1 — a save whose body + non-version frontmatter equal HEAD (only the
        auto-managed ``version`` line / benign frontmatter formatting differs)
        still mints a commit → a "revision" with an empty Review diff.
GAP 2 — editing an INTERNAL file of a folder-backed asset (a skill's script,
        which carries no frontmatter) produces no commit at all → the change is
        untracked and unsurfaced.
GAP 3 — a folder-backed asset whose main file is JSON (mcp.json) gets a YAML
        frontmatter ``version:`` header stamped into it, destroying the JSON —
        and the hook commits the wreckage (FLOWPAD-2084).
"""

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.actions.fs.asset_versioning import autoversion_commit_local

AGENT_V1 = """---
id: 6f1d4c2a-0b3e-4a7d-8c9f-1e2d3a4b5c6d
name: researcher
version: 1
---

# researcher

Do research.
"""

SKILL_MD_V1 = """---
id: 9fe9bee3-ce84-58c1-b047-90629fa5dfd3
name: slick
version: 1
---

# slick

Body one.
"""

MCP_JSON_V1 = """{
  "name": "deep-wiki-mcp",
  "transport": "http",
  "command": "",
  "args": [],
  "env": {},
  "url": "https://mcp.deepwiki.com/mcp",
  "entrypoint": ""
}
"""

INNER_SCRIPT_V1 = "print('hello from v1')\n"


class _LocalStorage:
    """Minimal stand-in for LocalStorageDriver's path-resolution seam."""

    def __init__(self, root: Path):
        self._root = root

    def _local_full_path(self, vfs_path: str) -> str:
        return str(self._root / vfs_path.lstrip("/"))


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _log_messages(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "log", "--format=%s"], cwd=repo, capture_output=True, text=True
    )
    return [ln for ln in out.stdout.splitlines() if ln.strip()]


def _head(cwd: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=cwd, capture_output=True, text=True
    ).stdout.strip()


def _endpoint_revisions(workdir: Path, file: str) -> list[str]:
    """Mirror get_file_revisions: ``git log --follow --format=%s -- <file>``."""
    out = subprocess.run(
        ["git", "log", "--follow", "--format=%s", "--", file],
        cwd=workdir, capture_output=True, text=True,
    )
    return [ln for ln in out.stdout.splitlines() if ln.strip()]


def _endpoint_diff(workdir: Path, file: str, rev: str) -> str:
    """Mirror compare_file_revision: ``git diff <rev> HEAD -- <file>``."""
    return subprocess.run(
        ["git", "diff", rev, "HEAD", "--", file],
        cwd=workdir, capture_output=True, text=True,
    ).stdout


@pytest.fixture
def agent_repo(tmp_path) -> Path:
    """Single-file asset: agent.md at the repo root."""
    _git(["init"], tmp_path)
    _git(["config", "user.email", "t@t.test"], tmp_path)
    _git(["config", "user.name", "t"], tmp_path)
    (tmp_path / "agent.md").write_text(AGENT_V1, encoding="utf-8")
    _git(["add", "-A"], tmp_path)
    _git(["commit", "-m", "Flowpad: researcher v1"], tmp_path)
    return tmp_path


@pytest.fixture
def skill_repo(tmp_path) -> Path:
    """Folder-backed asset: a skill folder with a main SKILL.md + an internal
    script, under a project git root (mirrors .claude/skills/<name>/)."""
    _git(["init"], tmp_path)
    _git(["config", "user.email", "t@t.test"], tmp_path)
    _git(["config", "user.name", "t"], tmp_path)
    skill = tmp_path / ".claude" / "skills" / "slick"
    (skill / "scripts").mkdir(parents=True)
    (skill / "SKILL.md").write_text(SKILL_MD_V1, encoding="utf-8")
    (skill / "scripts" / "run.py").write_text(INNER_SCRIPT_V1, encoding="utf-8")
    _git(["add", "-A"], tmp_path)
    _git(["commit", "-m", "Flowpad: slick v1"], tmp_path)
    return tmp_path


# ── P1 — single-file asset, real change → endpoint returns it (expected pass) ──
async def test_single_file_real_change_is_returned(agent_repo: Path):
    md = agent_repo / "agent.md"
    storage = _LocalStorage(agent_repo)
    base = _head(agent_repo)

    edited = md.read_text().replace("Do research.", "Do MUCH more research.")
    md.write_text(edited, encoding="utf-8")
    await autoversion_commit_local(storage, "agent.md", edited)

    diff = _endpoint_diff(agent_repo, "agent.md", base)
    assert "Do research." in diff, diff           # the removed line
    assert "Do MUCH more research." in diff, diff  # the added line


# ── N1 — single-file asset, net-unchanged save → must NOT mint a revision (GAP 1) ──
async def test_version_only_save_creates_no_revision(agent_repo: Path):
    """A save whose body + non-version frontmatter equal HEAD (only the
    auto-managed ``version`` line / a benign frontmatter formatting variance the
    editor's serializer can emit differs) must not create a new revision — the
    asset did not change. Today the byte difference slips past
    ``_is_changed_vs_head`` and a version-only commit is minted: the phantom
    revision storm the user saw (every "Compare" shows 'No differences')."""
    md = agent_repo / "agent.md"
    storage = _LocalStorage(agent_repo)

    # A real body edit → a legitimate revision (v2).
    edit1 = md.read_text().replace("Do research.", "Do work.")
    md.write_text(edit1, encoding="utf-8")
    await autoversion_commit_local(storage, "agent.md", edit1)
    after_real_edit = len(_log_messages(agent_repo))

    # Frontend reloads the bumped file (version: 2) and re-saves the SAME asset
    # with a benign frontmatter formatting variance (quoting) — body and every
    # non-version field unchanged vs HEAD.
    reloaded = md.read_text()  # canonical: version: 2, name: researcher, body "Do work."
    variant = reloaded.replace("name: researcher", "name: 'researcher'")
    md.write_text(variant, encoding="utf-8")
    await autoversion_commit_local(storage, "agent.md", variant)

    # Asset content is unchanged → no new revision should exist.
    assert len(_log_messages(agent_repo)) == after_real_edit, (
        "phantom version-only revision was minted for a net-unchanged save:\n"
        + "\n".join(_log_messages(agent_repo))
    )


# ── P2 — folder asset, main markdown change → endpoint returns it (expected pass) ──
async def test_folder_asset_main_md_change_is_returned(skill_repo: Path):
    skill = skill_repo / ".claude" / "skills" / "slick"
    md = skill / "SKILL.md"
    storage = _LocalStorage(skill_repo)
    # The editor runs git from the file's directory with the bare basename.
    base = _head(skill)

    edited = md.read_text().replace("Body one.", "Body two.")
    md.write_text(edited, encoding="utf-8")
    await autoversion_commit_local(storage, ".claude/skills/slick/SKILL.md", edited)

    revs = _endpoint_revisions(skill, "SKILL.md")
    assert len(revs) == 2, revs  # v1 + the new edit
    diff = _endpoint_diff(skill, "SKILL.md", base)
    assert "Body one." in diff and "Body two." in diff, diff


# ── P3 — folder asset, INTERNAL file change → must be tracked (GAP 2) ──
async def test_folder_asset_internal_change_is_tracked(skill_repo: Path):
    """A skill is a folder-backed asset (asset_ref = the folder; the schema flag
    ``folder_backed`` is True). Editing an internal file (a script with no
    frontmatter) is a real change to the asset and must be recorded as a
    revision. Today the autoversion hook returns early for non-frontmatter files,
    so the change produces no commit at all — silent, untracked, undiffable."""
    inner = skill_repo / ".claude" / "skills" / "slick" / "scripts" / "run.py"
    storage = _LocalStorage(skill_repo)
    before = len(_log_messages(skill_repo))

    edited = "print('hello from v2 — changed behavior')\n"
    inner.write_text(edited, encoding="utf-8")
    await autoversion_commit_local(
        storage, ".claude/skills/slick/scripts/run.py", edited
    )

    assert len(_log_messages(skill_repo)) == before + 1, (
        "internal file change to a folder-backed asset produced no revision — "
        "the change is untracked"
    )


# ── N2 — folder asset whose main file is JSON → must stay valid JSON (GAP 3) ──
@pytest.fixture
def mcp_repo(tmp_path) -> Path:
    """Folder-backed asset whose main file is JSON, not markdown: a flowpad-native
    MCP asset at ``agentic-assets/mcp/<name>/mcp.json`` (mcp's ``main_subdir``)."""
    _git(["init"], tmp_path)
    _git(["config", "user.email", "t@t.test"], tmp_path)
    _git(["config", "user.name", "t"], tmp_path)
    folder = tmp_path / "agentic-assets" / "mcp" / "deep-wiki-mcp"
    folder.mkdir(parents=True)
    (folder / "mcp.json").write_text(MCP_JSON_V1, encoding="utf-8")
    _git(["add", "-A"], tmp_path)
    _git(["commit", "-m", "Flowpad: deep-wiki-mcp v1"], tmp_path)
    return tmp_path


async def test_json_main_file_survives_the_version_stamp(mcp_repo: Path):
    """An MCP asset's main file IS its ``McpSpec`` document — JSON, which cannot
    carry a YAML frontmatter header. Saving it must leave it parseable.

    The regression (FLOWPAD-2084): the folder branch of ``_asset_scope`` resolved
    a stamp target from ``asset_scope.folder_backed_types`` — every folder asset,
    JSON-bodied ones included — while only the single-file branch below it checked
    that the target could hold a header. So a save handed ``mcp.json`` to the
    stamper, which prepended ``---\nversion: N\n---`` and committed it, leaving the
    asset unreadable by ``json.loads`` and by ``McpSpec`` (``extra="forbid"``, and
    there is no ``version`` field). The folder branch now asks the same question
    the single-file branch does, via ``_versionable_main_files``.
    """
    main = mcp_repo / "agentic-assets" / "mcp" / "deep-wiki-mcp" / "mcp.json"
    rel = "agentic-assets/mcp/deep-wiki-mcp/mcp.json"
    storage = _LocalStorage(mcp_repo)

    # The MCP editor serializes the whole document on every commit and writes it
    # through fs.write (McpViewer.tsx: `mainRef.write(JSON.stringify(next))`) —
    # here, a real edit to the url, exactly the change the reported asset carried.
    edited = json.dumps({**json.loads(MCP_JSON_V1), "url": "http://mcp.deepwiki.com/mcp"}, indent=2) + "\n"
    main.write_text(edited, encoding="utf-8")
    await autoversion_commit_local(storage, rel, edited)

    on_disk = main.read_text(encoding="utf-8")
    try:
        json.loads(on_disk)
    except ValueError as exc:
        pytest.fail(f"mcp.json is no longer valid JSON after the save: {exc}\n--- file ---\n{on_disk}")

    # …and the wreckage must not be what got committed.
    committed = subprocess.run(
        ["git", "show", f"HEAD:./{rel}"], cwd=mcp_repo, capture_output=True, text=True
    ).stdout
    try:
        json.loads(committed)
    except ValueError as exc:
        pytest.fail(f"the corrupted mcp.json was committed to git: {exc}\n--- HEAD blob ---\n{committed}")


def test_versioning_never_selects_a_non_frontmatter_type():
    """Registry-level guard on the predicate itself.

    ``test_json_main_file_survives_the_version_stamp`` catches the corruption for
    ONE type through the real hook; this catches the next one the day it is
    registered, without needing a fixture per family. A type is eligible for
    asset-scoped versioning only if its main file can hold the ``version:`` header
    the stamper writes — which is exactly what a ``Frontmatter`` declares.
    """
    from flow_sdk.actions.fs.asset_versioning import _versionable_folder_types
    from flow_sdk.fs_store.identity_carrier import Frontmatter

    selected = _versionable_folder_types()
    assert selected, "registry unavailable — the predicate returned nothing"

    offenders = [
        (t.type_name, t.main_file, type(t.identity_carrier).__name__)
        for t in selected
        if not isinstance(t.identity_carrier, Frontmatter)
    ]
    assert not offenders, (
        "these types would get a YAML `version:` header stamped into a main file "
        f"that cannot carry one: {offenders}"
    )
