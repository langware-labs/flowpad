"""Shared plan-to-process cross-link helper.

Single source of truth for connecting a plan file to its AgenticProcess.
Three independent triggers call this helper:

  * **listen.py:_create_plan_annotation** — fires on the
    ``PreToolUse:ExitPlanMode`` agent-hook webhook (instant, before Claude
    actually writes the plan file). Also creates a ``plan:`` Annotation row
    for the UI gutter (that piece stays local).
  * **transcript_indexer/handlers/plan_handler.py:PlanHandler** — fires when
    a batch indexer pass walks ``CLAUDE_SESSION`` JSONLs (e.g. via
    ``flow record index``). Thin adapter — delegates here.
  * **builtin/agentic_process/transcript_subscriber.py + AgenticProcess.on_plan_created** —
    fires on every TranscriptStreamer delta containing an
    ``ExitPlanModeEntry``. Also emits the ``plan.create`` outbound entity
    event so the FE can observe the new plan in real time.

Idempotent: ``plan_path`` is only written when stale,
``add_private_context_entities`` dedups by ``(type, id)``, and ``save()``
only fires when something changed.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Tuple

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.claude_memory_entities import ClaudePlan

_log = logging.getLogger(__name__)


async def cross_link_plan_to_process(
    plan_file_path: str | Path,
    session_id: str,
    proc: Optional["AgenticProcess"] = None,
) -> Tuple[Optional["ClaudePlan"], Optional["AgenticProcess"]]:
    """Idempotently connect a plan file to its AgenticProcess.

    When ``proc`` is provided (streamer-driven path on the AP itself), mutate
    that live instance — querying by session_id returns a DETACHED copy whose
    saved fields get overwritten by the live AP's subsequent save() calls
    (see file_cross_link for the same invariant). Pre-hook + indexer call
    sites pass session_id only.

    Steps:
      1. Resolve ``ClaudePlan`` by ``asset_ref``. If missing, run the scoped
         one-file PLAN reindex (``_index_single_plan``) and re-resolve.
      2. Resolve ``AgenticProcess`` from ``proc`` arg or by ``session_id``.
      3. Set ``ap.plan_path`` if absent or stale (this is the scalar field the
         UI's "Open Plan" button reads — invariant ``hasPlan = !!plan_path``).
      4. Append each side to the other's ``private_context_entities_`` (dedup
         by ``(type, id)``).
      5. ``save()`` each side only when something changed.

    Returns the resolved ``(plan, ap)`` — either may be ``None`` if unresolvable.
    """
    if not plan_file_path:
        return (None, None)
    plan_path = Path(plan_file_path)
    plan_path_str = str(plan_path)
    if not plan_path.exists():
        return (None, None)
    if proc is None and not session_id:
        return (None, None)

    # Late imports — this module is below the entity layer (transcript_analyzer)
    # but the helper coordinates entities. Keeping imports lazy avoids forcing
    # entity-side loading when transcript_analyzer is imported in non-server
    # contexts (CLI tools, batch indexer, etc.).
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.claude_memory_entities import ClaudePlan
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
    from flow_sdk.fs_store.transcript_indexer.handlers.plan_handler import (
        _index_single_plan,
    )
    from flow_sdk.fs_store.type_id import TypeId

    # (1) Resolve ClaudePlan, with scoped reindex fallback.
    plan = await ClaudePlan.get_one({"asset_ref": plan_path_str})
    if plan is None:
        await _index_single_plan(plan_path)
        plan = await ClaudePlan.get_one({"asset_ref": plan_path_str})
        if plan is None:
            _log.debug("cross_link_plan_to_process: scoped reindex of %s yielded no entity", plan_path_str)
            return (None, None)

    # (2) Resolve AgenticProcess — caller's live instance preferred over a
    # detached DB copy (see docstring).
    if proc is None:
        procs = await AgenticProcess.get_all(
            entities_filter=QueryFilter(match=ExpressionNode(session_id=session_id))
        )
        if not procs:
            return (plan, None)
        proc = procs[0]

    # (3) Set plan_path scalar if not already set to this path. The save() WS
    # broadcast is what lights up the "Open Plan" button in the live UI.
    plan_path_changed = False
    if proc.plan_path != plan_path_str:
        proc.plan_path = plan_path_str
        plan_path_changed = True

    # (4) Cross-link via private_context_entities (both directions, dedup'd).
    # The AP-side entry carries the plan's path so a chip click that 404s
    # (entity not yet indexed) can self-heal via single-file-index.
    changed_plan = plan.add_private_context_entities(
        TypeId(type=AgenticProcess.get_type(), id=proc.id)
    )
    changed_proc_link = proc.add_private_context_entities(
        TypeId(type=ClaudePlan.get_type(), id=plan.id),
        data={"path": plan_path_str},
    )

    # (5) Save each side only when something actually changed.
    if changed_plan:
        await plan.save()
    if plan_path_changed or changed_proc_link:
        await proc.save()

    return (plan, proc)
