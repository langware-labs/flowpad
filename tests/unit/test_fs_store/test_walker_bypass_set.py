"""The set of bespoke-walked types is CLOSED.

Every type the production indexer writes is discovered by exactly one of:
the generic ``layout_walker`` (a declared ``TypeInfo.walk``), the repo-assets
walker (``asset_class="repo"``), or a hand-written walker listed HERE with the
reason it cannot be a ``Walk``. A new bespoke walker cannot appear silently:
it either declares a walk or is added to this list with its reason.
"""

from __future__ import annotations

import pytest

from flow_sdk.fs_store.indexer.builtin import register_default_functions
from flow_sdk.fs_store.indexer.index_function import FSIndexer
from flow_sdk.fs_store.indexer.walkers.generic import walk_roots
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)

# type → why its discovery is not expressible as shape + mounts + roots.
BESPOKE: dict[str, str] = {
    "project": "claude_projects_fn / codex_projects_fn decode harness project registries, not a shape",
    "claude_session": "sessions are <encoded-project>/<sid>.jsonl under the PROJECT scaffold, parsed for identity",
    "codex_session": "codex session store: date-tree of rollout-*.jsonl, parsed for cwd",
    "copilot_session": "copilot session-state store, parsed for cwd",
    "claude_memory": "lives inside the encoded ~/.claude/projects/<dir>/memory of the PROJECT scaffold",
    "claude_md": "fixed names at two depths (CLAUDE.md, .claude/CLAUDE.md), not an extension",
    "workflow_run": "glob ~/.claude/projects/<slug>/<sid>/workflows/wf_*.json — a name pattern, not a shape",
    "claude_hook": "two-stage into-file walk: settings.json → one ref per hook entry (json_path)",
    "mcp_server": "two-stage into-file walk over .mcp.json/.toml/settings sources → per-server refs",
    "plugin": "one user-global registry file, one ref per plugin entry",
    # markdown's docs walk IS declared; its per-FOLDER project emitter stays bespoke.
    "markdown": "markdown_in_folder_fn: the typed-ancestor fence (skip .md under any dir another type claims) is a cross-type rule",
}

DECLARED = {
    "claude_rules", "command", "plan", "todo_file", "subagent", "skill",
    "markdown", "secret_origin", "dynamic_workflow", "spreadsheet",
}


SCAFFOLDS = {"folder", "claude_hook_source", "mcp_server_source"}


def _graph() -> FSIndexer:
    idx = FSIndexer(roots=[])
    register_default_functions(idx)
    return idx


def _is_generic(fn) -> bool:
    return fn.__name__.startswith("layout_walker[") or fn.__name__ == "repo_assets_fn"


@pytest.fixture(scope="module")
def emitted() -> set[str]:
    """Every record type some registered walker declares it emits — the whole
    graph, not just the parseable terminals, so a walker for a type whose
    parser registers lazily (the transcript handlers) is still counted."""
    return {str(t) for fns in _graph()._functions.values() for _fn, types in fns for t in (types or ())} - SCAFFOLDS


def test_declared_walks_are_exactly_the_converted_types() -> None:
    declared = {t for t in SchemaRegistry.get_all_types() if SchemaRegistry.get(t).walk}
    assert declared == DECLARED


def test_bespoke_set_is_closed() -> None:
    """Outputs of every registered function that is neither the generic walker
    nor the repo-assets walker. Judged per FUNCTION, not per type: a repo-class
    type (spreadsheet, the received transcripts) may still carry a bespoke
    walker for its harness-native location, and that walker must be listed."""
    bespoke = {
        str(t)
        for fns in _graph()._functions.values()
        for fn, types in fns
        if not _is_generic(fn)
        for t in (types or ())
    } - SCAFFOLDS
    assert bespoke == set(BESPOKE), (
        f"new bespoke walker(s) {bespoke - set(BESPOKE)} — declare a walk or list them with a reason; "
        f"stale entries {set(BESPOKE) - bespoke}"
    )


def test_every_declared_walk_is_registered_on_its_roots(emitted: set[str]) -> None:
    idx = _graph()
    for type_name in DECLARED:
        info = SchemaRegistry.get(type_name)
        assert type_name in emitted, type_name
        for root in walk_roots(info):
            outputs = {t for _fn, types in idx._functions[root] for t in (types or ())}
            assert RecordType(type_name) in outputs, (type_name, root)
