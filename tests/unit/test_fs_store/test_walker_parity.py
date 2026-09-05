"""The generic ``layout_walker`` reproduces every bespoke walker it replaced.

One fixture tree per converted type, shaped like the old walkers' own tests;
each case runs the declared walk over the same root nodes and compares the
``(record_type, resolved path)`` set against the snapshot the retired
hand-written function produced on that tree (recorded while both were alive).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import layout_walker, walker_for
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.type_info.claude_rules_type_info import CLAUDE_RULES
from flow_sdk.schema.type_info.command_type_info import COMMAND
from flow_sdk.schema.type_info.dynamic_workflow_type_info import DYNAMIC_WORKFLOW
from flow_sdk.schema.type_info.markdown_type_info import MARKDOWN
from flow_sdk.schema.type_info.plan_type_info import PLAN
from flow_sdk.schema.type_info.secret_origin_type_info import SECRET_ORIGIN
from flow_sdk.schema.type_info.skill_type_info import SKILL
from flow_sdk.schema.type_info.subagent_type_info import SUBAGENT
from flow_sdk.schema.type_info.todo_file_type_info import TODO_FILE

pytestmark = pytest.mark.timeout(5)

OPTS = IndexerOptions(verbose=False)


def _touch(path: Path, text: str = "x\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _emitted(fn, nodes: list[FSRef]) -> set[tuple[str, str]]:
    return {(str(r.record_type), str(r._path.resolve())) for r in fn(nodes, OPTS)}


def _expect(record_type: RecordType, paths: list[Path]) -> set[tuple[str, str]]:
    return {(str(record_type), str(p.resolve())) for p in paths}


def _flat_md_tree(root: Path, family: str) -> list[Path]:
    """``<root>/.claude/<family>/{a,b}.md`` plus the noise the old walkers ignored."""
    hits = [_touch(root / ".claude" / family / "a.md"), _touch(root / ".claude" / family / "b.md")]
    _touch(root / ".claude" / family / "notes.txt")
    (root / ".claude" / family / "nested").mkdir()
    _touch(root / ".claude" / family / "nested" / "deep.md")  # not a direct child
    _touch(root / ".claude" / "other" / "c.md")
    return hits


@pytest.mark.parametrize(
    "info, family, roots",
    [
        (CLAUDE_RULES, "rules", ("user_home_folder", "real_project_cwd", "cwd_root")),
        (COMMAND, "commands", ("user_home_folder", "real_project_cwd", "cwd_root")),
        (PLAN, "plans", ("user_home_folder",)),
    ],
)
def test_flat_claude_md_walks(tmp_path: Path, info, family, roots) -> None:
    hits = _flat_md_tree(tmp_path, family)
    for root in roots:
        node = FSRef(tmp_path, record_type=RecordType(root))
        assert _emitted(layout_walker(info), [node]) == _expect(RecordType(info.type_name), hits)
    # A root the walk does not hang on yields nothing.
    assert _emitted(layout_walker(info), [FSRef(tmp_path, record_type=RecordType.PROJECT)]) == set()


def test_todo_walk(tmp_path: Path) -> None:
    hits = [_touch(tmp_path / ".claude" / "todos" / "s1-agent-a1.json", "[]"), _touch(tmp_path / ".claude" / "todos" / "s2.json", "[]")]
    _touch(tmp_path / ".claude" / "todos" / "README.md")
    node = FSRef(tmp_path, record_type=RecordType.USER_HOME_FOLDER)
    assert _emitted(layout_walker(TODO_FILE), [node]) == _expect(RecordType.TODO_FILE, hits)


def test_subagent_walk_covers_every_harness_prefix(tmp_path: Path) -> None:
    hits = [
        _touch(tmp_path / ".claude" / "agents" / "reviewer.md"),
        _touch(tmp_path / ".agents" / "agents" / "coder.md"),
        _touch(tmp_path / ".github" / "agents" / "ci.md"),
    ]
    _touch(tmp_path / ".claude" / "agents" / "._reviewer.md")  # AppleDouble sidecar
    _touch(tmp_path / ".claude" / "agents" / "spec.yaml")
    for root in ("user_home_folder", "real_project_cwd", "cwd_root", "system_root"):
        node = FSRef(tmp_path, record_type=RecordType(root))
        assert _emitted(layout_walker(SUBAGENT), [node]) == _expect(RecordType.SUBAGENT, hits)


def _skill(root: Path, *parts: str) -> Path:
    folder = root.joinpath(*parts)
    _touch(folder / "SKILL.md", "---\nname: s\n---\n# s\n")
    return folder


def test_skill_harness_walk(tmp_path: Path) -> None:
    hits = [_skill(tmp_path, ".claude", "skills", "alpha"), _skill(tmp_path, ".agents", "skills", "beta")]
    (tmp_path / ".claude" / "skills" / "empty").mkdir()
    _touch(tmp_path / ".claude" / "skills" / "README.md")
    for root in ("user_home_folder", "real_project_cwd", "cwd_root", "system_root"):
        node = FSRef(tmp_path, record_type=RecordType(root))
        assert _emitted(layout_walker(SKILL), [node]) == _expect(RecordType.SKILL, hits)


def test_skill_folder_walk_emits_the_folder_itself_but_not_harness_mounts(tmp_path: Path) -> None:
    """The FOLDER-root walk asks each scaffold node whether IT is a skill —
    including the project root — and leaves ``.claude/skills/<x>`` to the
    harness walk so a skill is emitted once."""
    anywhere = _skill(tmp_path, "tools", "my-skill")
    nested = _skill(tmp_path, ".claude", "skills", "outer", "inner")
    root_skill = tmp_path  # the project itself is a skill repo
    _touch(root_skill / "SKILL.md", "# root\n")
    owned = _skill(tmp_path, ".claude", "skills", "outer")
    plain = tmp_path / "src"
    plain.mkdir()
    nodes = [FSRef(p, record_type=RecordType.FOLDER) for p in (tmp_path, plain, anywhere, owned, nested)]
    assert _emitted(layout_walker(SKILL), nodes) == _expect(RecordType.SKILL, [anywhere, nested, root_skill])


def test_markdown_docs_walk_is_recursive_and_skips_appledouble(tmp_path: Path) -> None:
    hits = [_touch(tmp_path / "docs" / "a.md"), _touch(tmp_path / "docs" / "sub" / "deep" / "b.md")]
    _touch(tmp_path / "docs" / "._a.md")
    _touch(tmp_path / "docs" / "c.txt")
    _touch(tmp_path / "notes" / "d.md")
    node = FSRef(tmp_path, record_type=RecordType.USER_HOME_FOLDER)
    assert _emitted(layout_walker(MARKDOWN), [node]) == _expect(RecordType.MARKDOWN, hits)


def test_secret_origin_walk_under_any_folder(tmp_path: Path) -> None:
    hits = [_touch(tmp_path / "assets" / "sodot" / "api.json", "{}"), _touch(tmp_path / "assets" / "sodot" / "db.json", "{}")]
    _touch(tmp_path / "assets" / "sodot" / "._api.json", "{}")
    _touch(tmp_path / "assets" / "sodot" / "readme.md")
    _touch(tmp_path / "assets" / "other.json", "{}")
    folders = [tmp_path, tmp_path / "assets", tmp_path / "assets" / "sodot"]
    nodes = [FSRef(p, record_type=RecordType.FOLDER) for p in folders]
    assert _emitted(layout_walker(SECRET_ORIGIN), nodes) == _expect(RecordType.SECRET_ORIGIN, hits)


def test_dynamic_workflow_walk_includes_skill_bundled_scripts(tmp_path: Path) -> None:
    hits = [
        _touch(tmp_path / ".claude" / "workflows" / "sample-flow.js"),
        _touch(tmp_path / ".claude" / "skills" / "demo-skill" / "flow.js"),
    ]
    _touch(tmp_path / ".claude" / "workflows" / "prose.md")
    _touch(tmp_path / ".claude" / "skills" / "demo-skill" / "scripts" / "helper.js")  # too deep
    for root in ("user_home_folder", "real_project_cwd", "cwd_root"):
        node = FSRef(tmp_path, record_type=RecordType(root))
        assert _emitted(layout_walker(DYNAMIC_WORKFLOW), [node]) == _expect(RecordType.DYNAMIC_WORKFLOW, hits)


def test_dedupe_across_nodes_that_resolve_to_one_tree(tmp_path: Path) -> None:
    hit = _touch(tmp_path / ".claude" / "rules" / "a.md")
    link = tmp_path.parent / f"{tmp_path.name}-link"
    link.symlink_to(tmp_path)
    nodes = [FSRef(p, record_type=RecordType.USER_HOME_FOLDER) for p in (tmp_path, link)]
    refs = layout_walker(CLAUDE_RULES)(nodes, OPTS)
    assert [str(r._path.resolve()) for r in refs] == [str(hit.resolve())]


def test_walker_for_reads_the_registry() -> None:
    assert walker_for("skill").__name__ == "layout_walker[skill]"
    with pytest.raises(KeyError):
        walker_for("no-such-type")
