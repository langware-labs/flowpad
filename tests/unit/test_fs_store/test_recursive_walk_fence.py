"""Recursive filesystem walks outside the sanctioned walkers are listed here or fail.

The shared skip policy (``flow_sdk/fs_store/gitignore.py``) only protects trees
walked through ``gitignore_walk`` or ``AssetFolder``. A new ``rglob``/``os.walk``
over a user directory silently reintroduces the node_modules scan this fence
exists for. Sites that walk something other than a user project tree (a
sessions dir under ~/.codex, a temp extraction dir, a mount already pruned by
the caller) are allowed with the reason recorded beside them.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PACKAGE = REPO / "flow_sdk"
PATTERN = re.compile(r"os\.walk\(|\.rglob\(|\.walk\(\)")

#: file → why a raw recursive walk is acceptable there.
ALLOWED: dict[str, str] = {
    "flow_sdk/fs_store/operations/markdown_dirs.py": "prunes with is_ignored on every level",
    "flow_sdk/server/fsop_filters.py": "prunes with the denylist, bounded discovery",
    "flow_sdk/assets/scanning.py": "declared-mount walks; nodes arrive pre-pruned from gitignore_walk",
    "flow_sdk/assets/transfer.py": "walks one extracted asset bundle",
    "flow_sdk/assets/types/dataset.py": "walks one asset's examples dir",
    "flow_sdk/assets/types/deck_template.py": "walks one asset's inner dir",
    "flow_sdk/builtin/flow_message_bundle.py": "walks a temp bundle extraction",
    "flow_sdk/app/actions/message_attachment_action.py": "walks one attachment entry dir",
    "flow_sdk/actions/fs/fs_actions.py": "copies one asset root",
    "flow_sdk/server/routes/artifacts.py": "lists one artifact dir",
    "flow_sdk/server/app.py": "claude transcript jsonl under ~/.claude",
    "flow_sdk/server/routes/bootstrap.py": "bundled docs under the package",
    "flow_sdk/graph_workflow_manager/manager.py": "one workflow run's output dir",
    "flow_sdk/llm_index/indexer.py": "sidecars under the index's own baseline dir",
    "flow_sdk/template_engine/engine.py": "template folder shipped with the package",
    "flow_sdk/transcript_analyzer/synthesizers/agent_trace.py": "one trace output dir",
    "flow_sdk/transcript_analyzer/transcript.py": "entry-tree walk, not a filesystem",
    "flow_sdk/schema/data_spec/activity_spec.py": "spec node walk, not a filesystem",
    "flow_sdk/activity/activity.py": "spec node walk, not a filesystem",
    "flow_sdk/ingest/drivers/folder.py": "TODO: user folder source; should prune via gitignore_walk",
    "flow_sdk/builtin/faas/compute_node.py": "TODO: walks a node root; review pruning",
    "flow_sdk/fs_store/indexer/functions/claude_hook.py": "hooks.json under a claude cache dir",
    "flow_sdk/fs_store/indexer/functions/claude_projects.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/fs_store/indexer/functions/codex_projects.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/fs_store/indexer/functions/codex_sessions.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/fs_store/operations/project_cleanup.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/builtin/worker_history.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/builtin/faas/project_list.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/builtin/agentic_process/cli_drivers/codex/driver.py": "rollout jsonl under ~/.codex/sessions",
    "flow_sdk/builtin/agentic_process/cli_drivers/codex/session_history.py": "rollout jsonl under ~/.codex/sessions",
}


def _sites() -> dict[str, list[int]]:
    found: dict[str, list[int]] = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        rel = path.relative_to(REPO).as_posix()
        if "/migrations/" in rel:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if PATTERN.search(line) and "gitignore_walk" not in line and not line.lstrip().startswith("#"):
                found.setdefault(rel, []).append(number)
    return found


def test_recursive_walks_are_sanctioned_or_listed() -> None:
    sites = _sites()
    unlisted = {rel: lines for rel, lines in sites.items() if rel not in ALLOWED}
    assert not unlisted, (
        "Raw recursive filesystem walk outside the sanctioned walkers. Use gitignore_walk "
        "or AssetFolder, or add the file to ALLOWED with the reason it is safe:\n"
        + "\n".join(f"  {rel}:{','.join(map(str, lines))}" for rel, lines in sorted(unlisted.items()))
    )
    stale = sorted(set(ALLOWED) - set(sites))
    assert not stale, f"ALLOWED entries no longer walk anything, remove them: {stale}"
