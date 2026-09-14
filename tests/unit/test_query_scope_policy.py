"""Unscoped ``Entity.get_all()`` is frozen: the sites that exist today may only shrink.

An unscoped enumeration walks every row of a type. A few sites legitimately do (the
canonical project list, a migration, a benchmark); a new one is almost always a bug —
the query should carry the scope. This scan is an AST walk, so a mention in a comment or
docstring never counts and a call can never hide behind formatting.

To remove a site, delete it here too. To add one, don't: scope the query.
"""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk"
SKIP = ("server/static/", "rust/tests/")

#: file → number of unscoped ``get_all()`` / ``get_all({})`` calls it may carry.
ALLOWLIST: dict[str, int] = {
    "app/actions/address_book_action.py": 1,
    "app/actions/execute_prompt.py": 1,
    "app/actions/flow_message_action.py": 7,
    "app/actions/workers.py": 1,
    "app/helpdesk_resolver.py": 1,
    "asset_cleanup/run.py": 1,
    "asset_cleanup/scan.py": 2,
    "builtin/agentic_process/agentic_process.py": 1,
    "builtin/agentic_process/naming/runtime.py": 1,
    "builtin/bookmark.py": 1,
    "builtin/contact_permission.py": 1,
    "builtin/cron_event.py": 2,
    "builtin/faas/compute_node.py": 2,
    "builtin/faas/pty_actions.py": 3,
    "builtin/faas/scan_actions.py": 1,
    "builtin/folder.py": 1,
    "builtin/journey.py": 1,
    "builtin/project.py": 7,
    "builtin/prompt_helpers.py": 1,
    "builtin/shell.py": 2,
    "builtin/worker_history.py": 2,
    "core/capabilities/summary.py": 1,
    "db/drivers/sqlite/benchmark.py": 3,
    "fs_store/indexer/roots.py": 1,
    "fs_store/operations/all_projects.py": 2,
    "graph_workflow_manager/manager.py": 2,
    "ingest/drivers/__init__.py": 1,
    "migrations/migration_2026_09_process_persona_backfill.py": 1,
    "server/pty_recovery.py": 1,
    "server/routes/assets.py": 1,
    "server/routes/search.py": 1,
    "server/scheduler.py": 1,
    "worldview/graph.py": 2,
}


def _is_unscoped_get_all(call: ast.Call) -> bool:
    func = call.func
    if not (isinstance(func, ast.Attribute) and func.attr == "get_all") or call.keywords:
        return False
    if not call.args:
        return True
    (arg,) = call.args[:1]
    return len(call.args) == 1 and isinstance(arg, ast.Dict) and not arg.keys


def unscoped_get_all_sites() -> Counter:
    found: Counter = Counter()
    for path in sorted(ROOT.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith(SKIP):
            continue
        text = path.read_text(encoding="utf-8")
        if "get_all(" not in text:
            continue
        tree = ast.parse(text, filename=rel)
        found[rel] += sum(isinstance(n, ast.Call) and _is_unscoped_get_all(n) for n in ast.walk(tree))
    return +found


def test_unscoped_get_all_sites_only_shrink():
    actual = unscoped_get_all_sites()
    grown = {f: (n, ALLOWLIST.get(f, 0)) for f, n in actual.items() if n > ALLOWLIST.get(f, 0)}
    assert not grown, f"new unscoped get_all() sites (file: found, allowed): {grown} — scope the query instead"
    stale = {f for f in ALLOWLIST if f not in actual}
    assert not stale, f"sites gone; delete them from ALLOWLIST so the list keeps shrinking: {sorted(stale)}"
