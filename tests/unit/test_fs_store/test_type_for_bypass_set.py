"""The types ``SchemaRegistry.type_for`` deliberately does NOT classify.

``type_for`` answers from the declarations alone (main document, fixed name,
family dir, extension). The types below are found by a BESPOKE walk that knows
a root the declaration does not carry (``~/.claude/projects/<encoded>/``, a
``settings.json`` entry, a plugin manifest …), so a point lookup on their path
is None — never a guess. The set is asserted EXACTLY: a new type that needs a
bespoke walk must be added here on purpose, and a type that gains a
declaration must be removed, so a bypass can neither appear nor linger
silently.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


# type → a path shaped the way its bespoke walker finds it. A session type
# DOES carry a declaration (``agentic-assets/<family>``, where a received copy
# lands) but its walker's own root is the harness's, and that path is None.
BYPASS: dict[str, str] = {
    "project": ".claude/projects/-Users-me-proj",                   # claude_projects_fn / codex_projects_fn
    "claude_session": ".claude/projects/-Users-me-proj/abc.jsonl",  # claude_sessions_fn
    "codex_session": ".codex/sessions/2026/09/05/rollout-1.jsonl",  # codex_sessions_fn
    "copilot_session": ".copilot/session-state/s1/events.jsonl",   # copilot_sessions_fn
    "mcp_server": ".claude/settings.json",                          # mcp_servers_in_file_fn (an entry, not the file)
    "claude_hook": ".claude/settings.json",                         # hooks_in_settings_fn (an entry, not the file)
    "plugin": ".claude/plugins/installed_plugins.json",             # plugin_fn
    "workflow_run": ".claude/workflows/wf_1/run.json",              # workflow_run_fn
}

# The one bespoke-walked type whose path DOES classify: ``claude_memory`` lives
# at ``~/.claude/projects/<encoded>/memory/*.md`` — a plain ``.md`` to the
# declarations, so the catch-all names it ``markdown``. Listed so the
# ambiguity is on record, not discovered in production.
BYPASS_MISCLASSIFIED: dict[str, tuple[str, str]] = {
    "claude_memory": (".claude/projects/-Users-me-proj/memory/notes.md", "markdown"),
}

# Walked types with NO declared location at all — no main document, fixed
# name, walk mount, family dir or unique extension names them anywhere.
UNDECLARED: frozenset[str] = frozenset({
    "project", "mcp_server", "claude_hook", "plugin", "workflow_run", "claude_memory",
})


def test_every_bypass_type_is_none_for_its_walked_path(tmp_path: Path) -> None:
    for type_name, rel in BYPASS.items():
        assert SchemaRegistry.get(type_name) is not None, f"{type_name} is not a registered type"
        assert SchemaRegistry.type_for(tmp_path / rel) is None, (type_name, rel)


def test_the_misclassified_bypass_is_exactly_as_recorded(tmp_path: Path) -> None:
    for type_name, (rel, answer) in BYPASS_MISCLASSIFIED.items():
        assert SchemaRegistry.type_for(tmp_path / rel) == answer, (type_name, rel)


def test_the_undeclared_set_is_exactly_the_walked_types_type_for_cannot_place(tmp_path: Path) -> None:
    """Every walked type is EITHER classified by ``type_for`` at some declared
    location OR listed in ``UNDECLARED`` — no third bucket. A walked type is
    one with a ``from_disk_fn``; a declared location is its main document,
    fixed name, family dir (with the document declaring its own ``type:``,
    the way two types sharing a mount are told apart) or unique extension."""
    from flow_sdk.schema.layout import File, Folder

    def classified_at(candidate: Path, type_name: str) -> bool:
        candidate.parent.mkdir(parents=True, exist_ok=True)
        if candidate.suffix.lower() == ".md":
            candidate.write_text(f"---\ntype: {type_name}\n---\n", encoding="utf-8")
        return SchemaRegistry.type_for(candidate) == type_name

    unplaced: set[str] = set()
    for type_name in SchemaRegistry.get_all_types():
        info = SchemaRegistry.get(type_name)
        if info is None or info.from_disk_fn is None or not info.declared:   # probes other tests register are not walked types
            continue
        shape = info.shape
        candidates: list[Path] = []
        mounts = set(info.scan_mounts) or {""}
        if isinstance(shape, Folder) and shape.main:
            candidates.extend(tmp_path / mount / "one" / shape.main for mount in mounts)
        elif isinstance(shape, File):
            names = shape.names or tuple(f"one{ext}" for ext in shape.exts)
            candidates.extend(tmp_path / mount / name for mount in mounts for name in names)
        if not any(classified_at(c, type_name) for c in candidates):
            unplaced.add(type_name)
    assert unplaced == UNDECLARED, (
        f"new bypass (declare a shape/placement or list it): {sorted(unplaced - UNDECLARED)}; "
        f"no longer a bypass (drop it from the list): {sorted(UNDECLARED - unplaced)}"
    )
