from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
from flow_sdk.transcript_analyzer.entry import EntryKind, TranscriptEntry

from ..handler import TranscriptContext

if TYPE_CHECKING:
    from flow_sdk.builtin.claude_memory_entities import ClaudePlan

logger = logging.getLogger(__name__)


async def resolve_plan(plan_file_path: str | Path | None) -> "ClaudePlan | None":
    """Resolve the ``ClaudePlan`` entity for a plan file path.

    Indexes the file on demand when the indexer hasn't caught up yet (the
    streamer path writes the plan then immediately cross-links). Returns
    ``None`` when the path is empty/absent or yields no entity. This is plan
    *resolution* — the cross-linking itself goes through the generic
    ``cross_link_entities`` primitive at the call site.
    """
    if not plan_file_path:
        return None
    from flow_sdk.builtin.claude_memory_entities import ClaudePlan

    plan_path = Path(plan_file_path)
    if not plan_path.exists():
        return None
    path_str = str(plan_path)
    plan = await ClaudePlan.get_one({"asset_ref": path_str})
    if plan is None:
        await _index_single_plan(plan_path)
        plan = await ClaudePlan.get_one({"asset_ref": path_str})
        if plan is None:
            logger.debug("resolve_plan: scoped reindex of %s yielded no entity", path_str)
    return plan


class PlanHandler:
    """Cross-link ClaudePlan ↔ AgenticProcess via private_context_entities.

    Resolves the plan (on-demand index fallback via :func:`resolve_plan`) and
    the owning process (by ``session_id``), sets the AP's ``plan_path`` scalar
    when stale, and mutually links them through the generic
    ``cross_link_entities`` primitive.
    """

    match_kind: ClassVar[EntryKind | None] = EntryKind.TOOL_USE
    match_tool_name: ClassVar[str | None] = "ExitPlanMode"

    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None:
        if not isinstance(entry, ExitPlanModeEntry):
            return
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.core.entity.cross_link import cross_link_entities

        plan = await resolve_plan(entry.plan_file_path)
        if plan is None:
            return
        proc = await AgenticProcess.get_by_session_id(entry.session_id)
        if proc is None:
            return
        path_str = str(entry.plan_file_path)
        if proc.plan_path != path_str:
            proc.plan_path = path_str
            await proc.save()
        await cross_link_entities(plan, proc, b_data={"path": path_str})


# Re-export so call sites that resolve a single plan file keep a stable import.
# The implementation lives in single_file_indexers.py alongside the markdown /
# skill / claude_md / claude_memory / claude_rules / command equivalents — all
# share the same generic _index_single_file helper.
from .single_file_indexers import _index_single_plan as _index_single_plan  # noqa: F401,E402
