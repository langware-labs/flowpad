from __future__ import annotations

import logging
from pathlib import Path
from typing import ClassVar

from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
from flow_sdk.transcript_analyzer.entry import EntryKind, TranscriptEntry

from ..handler import TranscriptContext

logger = logging.getLogger(__name__)


class PlanHandler:
    """Cross-link ClaudePlan ↔ AgenticProcess via private_context_entities.

    Thin adapter — delegates to the shared
    :func:`flow_sdk.transcript_analyzer.plan_cross_link.cross_link_plan_to_process`
    helper. See that module's docstring for the canonical contract.
    """

    match_kind: ClassVar[EntryKind | None] = EntryKind.TOOL_USE
    match_tool_name: ClassVar[str | None] = "ExitPlanMode"

    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None:
        if not isinstance(entry, ExitPlanModeEntry):
            return
        from flow_sdk.transcript_analyzer.plan_cross_link import cross_link_plan_to_process

        await cross_link_plan_to_process(entry.plan_file_path, entry.session_id)


async def _index_single_plan(plan_md_path: Path) -> None:
    """Scoped PLAN-only indexer pass for one .md file.

    `claude_plan_fn` looks for `<root>/.claude/plans/*.md`. Plan files live
    under `~/.claude/plans/` or `<project>/.claude/plans/`, so walking up two
    parents from the .md file lands on the correct root in either layout.
    `force=True` bypasses skip-fresh.
    """
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn
    from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
    from flow_sdk.fs_store.record_types import RecordType

    plan_root = plan_md_path.parent.parent.parent
    idx = FSIndexer(
        roots=[FSRef(plan_root, record_type=RecordType.USER_HOME_FOLDER)]
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_plan_fn)
    await idx.index(
        IndexerOptions(types=[RecordType.PLAN], force=True, verbose=False)
    )
