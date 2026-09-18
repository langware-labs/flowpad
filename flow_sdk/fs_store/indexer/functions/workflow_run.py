"""Walker + extractor + id mint for WORKFLOW_RUN records.

A Claude Code **workflow run** writes a single-JSON-object journal at
``~/.claude/projects/<slug>/<sessionId>/workflows/wf_<runId>.json``. We treat the
run like a worker transcript/session (worker_type ``"workflow"``): read-only, the
provider owns the file. The extractor reads only the cheap top-level envelope into
the record — the per-agent ``workflowProgress`` payload is NOT walked here (it's
served on demand through the transcript route via the WorkflowParser).
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def workflow_run_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Glob workflow run journals under ``<home>/.claude/projects/*/*/workflows/wf_*.json``.

    Wired for the USER_HOME_FOLDER node only — journals live under ~/.claude,
    never under a project cwd.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        projects = Path(node.path) / ".claude" / "projects"
        if not projects.is_dir():
            continue
        for journal in sorted(projects.glob("*/*/workflows/wf_*.json")):
            key = str(journal.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(journal, record_type=RecordType.WORKFLOW_RUN, parent=node))
    return out
