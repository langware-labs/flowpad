from __future__ import annotations

import logging
from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
from flow_sdk.transcript_analyzer.entry import EntryKind, TranscriptEntry

from ..handler import TranscriptContext

logger = logging.getLogger(__name__)


class PlanHandler:
    """Cross-link ClaudePlan <-> AgenticProcess via private_context_entities.

    For every ExitPlanMode tool_use in the transcript:
      1. Resolve plan file path from entry.plan_file_path; skip if absent or missing.
      2. Look up the ClaudePlan entity by `asset_ref == plan_path`. If missing,
         trigger a scoped PLAN reindex of that single file and re-look up.
      3. Look up the AgenticProcess by entry.session_id. If absent, skip.
      4. Append each TypeId to the other's private_context_entities_ (idempotent)
         and save when something actually changed.
    """

    match_kind: ClassVar[EntryKind | None] = EntryKind.TOOL_USE
    match_tool_name: ClassVar[str | None] = "ExitPlanMode"

    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None:
        if not isinstance(entry, ExitPlanModeEntry):
            return
        plan_path = entry.plan_file_path
        if not plan_path or not Path(plan_path).exists():
            return

        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.claude_memory_entities import ClaudePlan
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

        plan = await ClaudePlan.get_one({"asset_ref": plan_path})
        if plan is None:
            await _index_single_plan(Path(plan_path))
            plan = await ClaudePlan.get_one({"asset_ref": plan_path})
            if plan is None:
                logger.debug(
                    "PlanHandler: scoped PLAN reindex of %s yielded no entity", plan_path
                )
                return

        procs = await AgenticProcess.get_all(
            entities_filter=QueryFilter(
                match=ExpressionNode(session_id=entry.session_id)
            )
        )
        if not procs:
            return
        proc = procs[0]

        changed_plan = plan.add_private_context_entities(
            TypeId(type=AgenticProcess.get_type(), id=proc.id)
        )
        changed_proc = proc.add_private_context_entities(
            TypeId(type=ClaudePlan.get_type(), id=plan.id)
        )
        if changed_plan:
            await plan.save()
        if changed_proc:
            await proc.save()


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
