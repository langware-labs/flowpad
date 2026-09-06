"""``SchemaRegistry.type_for`` — the one registry-wide path → type classifier
(name + placement + stat; no walk roots). One case per tier."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


def test_a_shared_type_owns_its_main_document_anywhere(tmp_path: Path) -> None:
    doc = tmp_path / "anywhere" / "s" / "SKILL.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("# s\n", encoding="utf-8")
    assert SchemaRegistry.type_for(doc) == "skill"


def test_a_repo_type_owns_its_main_document_only_in_its_family_dir(tmp_path: Path) -> None:
    placed = tmp_path / "agentic-assets" / "mcp" / "crm" / "mcp.json"
    assert SchemaRegistry.type_for(placed) == "mcp"
    # the same NAME outside the family dir is not that type: a workspace
    # ``SPEC.md`` is a markdown document, not a spec
    assert SchemaRegistry.type_for(tmp_path / "workspace" / "SPEC.md") == "markdown"


def test_a_folder_holding_a_placed_main_document_is_that_type(tmp_path: Path) -> None:
    folder = tmp_path / "agentic-assets" / "mcp" / "crm"
    folder.mkdir(parents=True)
    (folder / "mcp.json").write_text("{}", encoding="utf-8")
    assert SchemaRegistry.type_for(folder) == "mcp"


def test_a_shared_main_name_is_disambiguated_by_family(tmp_path: Path) -> None:
    # graph_workflow and journey both name ``graph.json``; placement decides
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "journey" / "j" / "graph.json") == "journey"
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "graph_workflow" / "g" / "graph.json") == "graph_workflow"


def test_a_unique_file_extension_names_its_type(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "flow.js") == "dynamic_workflow"
    assert SchemaRegistry.type_for(tmp_path / "data.csv") == "spreadsheet"
    assert SchemaRegistry.type_for(tmp_path / "data.xlsx") == "spreadsheet", "spreadsheet declares also=('.xlsx',)"


def test_a_fixed_filename_is_its_type_anywhere(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "CLAUDE.md") == "claude_md"
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "CLAUDE.md") == "claude_md"
    assert SchemaRegistry.type_for(tmp_path / "CLAUDE.local.md") == "claude_md"


def test_plain_markdown_falls_to_markdown(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "notes.md") == "markdown"


def test_unknown_or_ambiguous_is_none(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "server.py") is None
    # ``.json`` is claimed by several bespoke-walked types; without roots it is
    # ambiguous, and an ambiguous answer is None rather than a guess
    assert SchemaRegistry.type_for(tmp_path / "settings.json") is None


# --- the PLACED tier: a file type's declared family dir, read off the
# declarations (``asset_class`` / ``harness`` / ``family`` through
# ``placement.family_subdir``) for every harness prefix.


def test_a_harness_type_owns_its_family_dir(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "commands" / "deploy.md") == "command"
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "rules" / "style.md") == "claude_rules"


def test_a_shared_type_is_found_under_every_harness_prefix(tmp_path: Path) -> None:
    from flow_sdk.fs_store.placement import WORKER_PREFIX

    for prefix in set(WORKER_PREFIX.values()):
        assert SchemaRegistry.type_for(tmp_path / prefix / "agents" / "reviewer.md") == "subagent", prefix


def test_a_declared_walk_mount_names_its_type(tmp_path: Path) -> None:
    # plan's ``Walk`` reads ``.claude/plans`` (Claude Code's dir); its placement
    # is ``agentic-assets/plan`` (where a received copy lands). Both are it.
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "plans" / "p.md") == "plan"
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "plan" / "p.md") == "plan"


def test_a_repo_file_type_owns_its_family_dir_only(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "prompt" / "p.md") == "prompt"
    # the same extension outside any family dir is the catch-all
    assert SchemaRegistry.type_for(tmp_path / "plan" / "p.md") == "markdown"


def test_the_nearest_family_dir_ancestor_wins(tmp_path: Path) -> None:
    # namespaced commands (``.claude/commands/<ns>/x.md``) are still commands
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "commands" / "ns" / "x.md") == "command"
    # a harness dir nested inside a docs tree is the harness dir, not docs
    assert SchemaRegistry.type_for(tmp_path / "docs" / ".claude" / "agents" / "a.md") == "subagent"


def test_a_walk_mount_places_an_otherwise_ambiguous_extension(tmp_path: Path) -> None:
    # ``.json`` is claimed by several types; todo_file's walk mount decides
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "todos" / "abc-agent-abc.json") == "todo_file"
    # a ``*`` mount segment (dynamic_workflow: ``.claude/skills/*``) matches any one dir
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "skills" / "deploy" / "flow.js") == "dynamic_workflow"


def test_a_placed_jsonl_names_its_session_type_where_a_loose_one_is_ambiguous(tmp_path: Path) -> None:
    assert SchemaRegistry.type_for(tmp_path / "agentic-assets" / "claude_session" / "s.jsonl") == "claude_session"
    assert SchemaRegistry.type_for(tmp_path / "s.jsonl") is None


def test_two_types_on_one_mount_are_told_apart_by_the_frontmatter_type(tmp_path: Path) -> None:
    # markdown and markdown_index both live under ``docs``; only the document's
    # own ``type:`` declaration makes it an index
    docs = tmp_path / "docs" / "guide"
    docs.mkdir(parents=True)
    index = docs / "index.md"
    index.write_text("---\ntype: markdown_index\ntitle: Guide\n---\n# Guide\n", encoding="utf-8")
    assert SchemaRegistry.type_for(index) == "markdown_index"
    plain = docs / "index.md"
    plain.write_text("---\ntitle: Guide\n---\n# Guide\n", encoding="utf-8")
    assert SchemaRegistry.type_for(plain) == "markdown"
    assert SchemaRegistry.type_for(docs / "missing.md") == "markdown", "no file yet: the catch-all"
    # a foreign ``type:`` never escapes the mount's candidates
    stray = docs / "stray.md"
    stray.write_text("---\ntype: skill\n---\n", encoding="utf-8")
    assert SchemaRegistry.type_for(stray) == "markdown"


# --- shape declarations the registry reads: ``File.names`` (a fixed filename)
# and ``File.also`` (a second extension). Probed with throwaway types so the
# tier is pinned even before a builtin declares one.


@pytest.fixture
def _probe_type():
    from flow_sdk.fs_store.schema_registry import TypeInfo

    registered: list[str] = []

    def register(name: str, shape) -> None:
        SchemaRegistry.register(TypeInfo(type_name=name, shape=shape, from_disk_fn=lambda ref, rid: []))
        registered.append(name)

    yield register
    for name in registered:
        SchemaRegistry._types.pop(name, None)
    SchemaRegistry._registry_generation += 1


def test_a_fixed_filename_beats_every_extension_tier(tmp_path: Path, _probe_type) -> None:
    from flow_sdk.schema.layout import File

    _probe_type("_probe_named", File(ext=".md", names=("PROBE.md", "PROBE.local.md")))
    assert SchemaRegistry.type_for(tmp_path / "PROBE.md") == "_probe_named"
    assert SchemaRegistry.type_for(tmp_path / ".claude" / "probe.local.md") == "_probe_named", "case-insensitive"
    assert SchemaRegistry.type_for(tmp_path / "other.md") == "markdown", "a fixed-name type claims no other .md"


def test_a_second_extension_names_the_same_type(tmp_path: Path, _probe_type) -> None:
    from flow_sdk.schema.layout import File

    _probe_type("_probe_multi", File(ext=".probe", also=(".probe2",)))
    assert SchemaRegistry.type_for(tmp_path / "a.probe") == "_probe_multi"
    assert SchemaRegistry.type_for(tmp_path / "a.PROBE2") == "_probe_multi"


# --- ``placed_only``: the confident half of the answer. A caller that MINTS on
# the result (``flow show``) must not treat "every .md is a markdown asset" —
# true of the type system, false of the walk — as a licence to create a row.


def test_placed_only_drops_the_extension_tier(tmp_path: Path) -> None:
    loose = tmp_path / "work" / "hello.md"
    loose.parent.mkdir(parents=True)
    loose.write_text("# scratch\n", encoding="utf-8")

    assert SchemaRegistry.type_for(loose) == "markdown", "the type system still names it"
    assert SchemaRegistry.type_for(loose, placed_only=True) is None, "but nothing placed it"


def test_placed_only_keeps_every_declared_placement(tmp_path: Path) -> None:
    for rel, expected in (
        ("docs/guide.md", "markdown"),          # a declared mount, shared with markdown_index
        ("docs/deep/nested.md", "markdown"),    # the mount is recursive
        (".claude/commands/deploy.md", "command"),
        ("CLAUDE.md", "claude_md"),             # a fixed name
        ("skills/s/SKILL.md", "skill"),         # a folder type's main document
    ):
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# x\n", encoding="utf-8")
        assert SchemaRegistry.type_for(path, placed_only=True) == expected, rel


def test_a_shared_mount_resolves_to_the_type_that_needs_no_declaration(tmp_path: Path) -> None:
    """``docs`` is both markdown and markdown_index. A document that declares
    nothing is the plain one; only an explicit ``type:`` makes it the index."""
    docs = tmp_path / "docs"
    docs.mkdir()
    plain = docs / "guide.md"
    plain.write_text("---\ntitle: Guide\n---\n# Guide\n", encoding="utf-8")
    index = docs / "index.md"
    index.write_text("---\ntype: markdown_index\n---\n# Index\n", encoding="utf-8")

    assert SchemaRegistry.type_for(plain, placed_only=True) == "markdown"
    assert SchemaRegistry.type_for(index, placed_only=True) == "markdown_index"
