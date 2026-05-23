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


# Re-export so existing callers (plan_cross_link.py:77) keep working without
# import-path changes. The implementation now lives in single_file_indexers.py
# alongside the markdown / skill / claude_md / claude_memory / claude_rules /
# command equivalents — all share the same generic _index_single_file helper.
from .single_file_indexers import _index_single_plan as _index_single_plan  # noqa: F401
