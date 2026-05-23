"""Shared file-op-to-process cross-link helper (markdown v1).

Sibling of ``plan_cross_link.py`` — generalizes the cross-link from
``ClaudePlan ↔ AgenticProcess`` to any markdown record. Detection of which
files to cross-link happens at the caller; this module owns resolve-and-link.

No on-demand reindex: if no markdown ``Entity`` exists for the path, returns
``None``. The natural indexer cadence eventually creates the entity.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.claude_memory_entities import Markdown

_log = logging.getLogger(__name__)


async def cross_link_file_to_process(
    file_path: str | Path,
    proc: "AgenticProcess",
) -> Optional["Markdown"]:
    """Idempotently connect a markdown file to the given live AgenticProcess.

    Caller passes the LIVE in-memory AP so subsequent AP saves (status
    transition, etc.) see the new ``private_context_entities_`` entry —
    otherwise they would overwrite this cross-link.
    """
    md_path_str = str(file_path)

    # Lazy imports keep this module importable from non-server contexts.
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.claude_memory_entities import (
        ClaudeMd, ClaudeMemory, ClaudePlan, ClaudeRules, Docs,
    )
    from flow_sdk.fs_store.type_id import TypeId

    md_entity = None
    for cls in (Docs, ClaudeMd, ClaudeMemory, ClaudeRules, ClaudePlan):
        try:
            candidate = await cls.get_one({"asset_ref": md_path_str})
        except Exception:
            candidate = None
        if candidate is not None:
            md_entity = candidate
            break
    if md_entity is None:
        _log.debug("cross_link_file_to_process: no markdown entity for %s — skipped", md_path_str)
        return None

    changed_md = md_entity.add_private_context_entities(
        TypeId(type=AgenticProcess.get_type(), id=proc.id)
    )
    changed_proc = proc.add_private_context_entities(
        TypeId(type=type(md_entity).get_type(), id=md_entity.id)
    )
    if changed_md:
        try:
            await md_entity.save()
        except Exception:
            _log.exception("cross_link_file_to_process: md save failed for %s", md_path_str)
    if changed_proc:
        try:
            await proc.save()
        except Exception:
            _log.exception("cross_link_file_to_process: ap save failed for %s", proc.id)

    return md_entity
