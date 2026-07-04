"""llm_index scan scope under the shared gitignore-aware walk.

Pins the consolidation contract: ``scan_tree``/``LLMIndexer`` walk with full
FSIndexer semantics — ``.gitignore`` honored, dot-dirs walked, ``.claude/``
force-included (minus worktrees), flowpad state dirs and ``_WALK_IGNORED``
always skipped — and staleness/hashing reacts to the walked set.

Real filesystem trees in ``tmp_path`` — no mocks. Fast.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.llm_index import LLMIndexer
from flow_sdk.llm_index.core import scan_tree


def _touch(p: Path, text: str = "# Doc\n\nbody\n") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _folder_rels(idx: LLMIndexer) -> set[str]:
    return {item.rel_path for item in idx.indexes()}


def _file_rels(idx: LLMIndexer) -> set[str]:
    return {doc.rel_path for doc in idx.docs()}


def test_gitignored_subtree_excluded_from_scan(tmp_path: Path):
    _touch(tmp_path / ".gitignore", "drafts/\n")
    _touch(tmp_path / "intro.md")
    _touch(tmp_path / "drafts" / "wip.md")
    idx = LLMIndexer(tmp_path)
    assert _folder_rels(idx) == {""}
    assert _file_rels(idx) == {"intro.md"}


def test_gitignored_single_file_changes_own_hash(tmp_path: Path):
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / "secret.md")
    before = scan_tree(tmp_path)
    _touch(tmp_path / ".gitignore", "secret.md\n")
    after = scan_tree(tmp_path)
    assert [f.path.name for f in before.files] == ["keep.md", "secret.md"]
    assert [f.path.name for f in after.files] == ["keep.md"]
    assert before.own_hash != after.own_hash
    assert before.inputs_hash != after.inputs_hash


def test_nested_gitignore_scoped_to_its_folder(tmp_path: Path):
    _touch(tmp_path / "a" / ".gitignore", "local.md\n")
    _touch(tmp_path / "a" / "local.md")
    _touch(tmp_path / "b" / "local.md")
    assert _file_rels(LLMIndexer(tmp_path)) == {"b/local.md"}


def test_claude_force_included_worktrees_excluded(tmp_path: Path):
    _touch(tmp_path / ".gitignore", ".claude/\n")
    _touch(tmp_path / ".claude" / "skills" / "thing" / "SKILL.md")
    _touch(tmp_path / ".claude" / "worktrees" / "agent" / "copy.md")
    files = _file_rels(LLMIndexer(tmp_path))
    assert ".claude/skills/thing/SKILL.md" in files
    assert not any(f.startswith(".claude/worktrees") for f in files)


def test_dot_dirs_are_scanned(tmp_path: Path):
    _touch(tmp_path / ".github" / "notes.md")
    idx = LLMIndexer(tmp_path)
    assert ".github" in _folder_rels(idx)
    assert ".github/notes.md" in _file_rels(idx)


def test_state_dirs_never_scanned_even_with_content(tmp_path: Path):
    _touch(tmp_path / "intro.md")
    _touch(tmp_path / ".llm_index" / "summaries" / "abc.summary.md")
    _touch(tmp_path / ".flowpad" / "x.md")
    _touch(tmp_path / ".markdown_index" / "y.md")
    _touch(tmp_path / "node_modules" / "pkg" / "readme.md")
    idx = LLMIndexer(tmp_path)
    assert _folder_rels(idx) == {""}
    assert _file_rels(idx) == {"intro.md"}


def test_gitignore_false_keeps_denylist(tmp_path: Path):
    _touch(tmp_path / ".gitignore", "drafts/\n")
    _touch(tmp_path / "drafts" / "wip.md")
    _touch(tmp_path / "node_modules" / "pkg" / "readme.md")
    idx = LLMIndexer(tmp_path, gitignore=False)
    files = _file_rels(idx)
    assert "drafts/wip.md" in files            # .gitignore NOT honored
    assert not any(f.startswith("node_modules") for f in files)


def _load_plan_module():
    """Import the markdown_index skill planner from its dotted-dir path."""
    import importlib.util

    plan_path = (
        Path(__file__).parents[1]
        / "flow_sdk" / "system_projects" / "flowpad_assistant"
        / ".claude" / "skills" / "markdown_index" / "plan.py"
    )
    spec = importlib.util.spec_from_file_location("markdown_index_plan", plan_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_plan_py_parity_with_llm_indexer(tmp_path: Path):
    """The skill planner and LLMIndexer must agree on the stale-set — same
    walk, same hashes. One fresh file (pre-seeded summary) + one stale."""
    import hashlib

    vault = tmp_path / "vault"
    _touch(vault / "fresh.md", "# Fresh\n\nsummarised already\n")
    _touch(vault / "stale.md", "# Stale\n\nno summary yet\n")
    _touch(vault / "auth" / "tokens.md", "# Tokens\n\nrotation\n")
    _touch(vault / ".gitignore", "drafts/\n")
    _touch(vault / "drafts" / "wip.md")   # gitignored — both must skip it
    sums = tmp_path / "sums"
    sums.mkdir()
    fresh_hash = hashlib.sha256((vault / "fresh.md").read_bytes()).hexdigest()
    (sums / f"{fresh_hash}.summary.md").write_text("Already summarised.\n")

    plan = _load_plan_module().build_plan(vault, summaries_dir=sums)
    idx = LLMIndexer(vault, summaries_dir=sums)

    assert [f["path"] for f in plan["stale_files"]] == [
        str(d.path) for d in idx.stale_docs()
    ]
    assert [f["content_hash"] for f in plan["stale_files"]] == [
        d.content_hash for d in idx.stale_docs()
    ]
    assert not any("drafts" in f["path"] for f in plan["stale_files"])

    stale_items = list(idx.stale_indexes())
    folders = plan["stale_folders_post_order"]
    assert [f["path"] for f in folders] == [str(i.path) for i in stale_items]
    assert [f["inputs_hash"] for f in folders] == [i.inputs_hash for i in stale_items]
    assert plan["total_folders"] == 2 and plan["total_files"] == 3


def test_ignore_everything_leaves_bare_root(tmp_path: Path):
    _touch(tmp_path / ".gitignore", "*\n")
    _touch(tmp_path / "a.md")
    _touch(tmp_path / "sub" / "b.md")
    root = scan_tree(tmp_path)
    assert root.files == [] and root.subfolders == []
    assert root.is_stale  # no index.md on disk yet — still a valid (empty) node
