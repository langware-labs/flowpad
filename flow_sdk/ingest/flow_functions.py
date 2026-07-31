"""GraphWorkflowFunctions for the hn-radar demo flow.

Two inline functions, deliberately split by cost:

``hn_radar_tick`` runs on EVERY sync cycle. It exists to make the canvas move —
the visible proof that global ingestion events are reaching a project's flow —
so it must stay near-free. It does no I/O.

``hn_radar_collect`` runs only when the report is asked for. It does the entity
query and hands the agent node a file, rather than leaving the agent to discover
the entity API by itself. That split is the ``daily-analysis`` shape: the
deterministic part is code, and the LLM only does the part that needs judgement.
A run therefore still produces usable data even when no worker is available.

Both are inline (direct SDK access, no REST hop) — the sanctioned inline pattern,
same as ``flow_publish_usage_report``. Neither blocks: the tick does no I/O at
all, and the collector pushes both its provider filter and its time window into
the query rather than hydrating the table and filtering in Python.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from flow_sdk.graph_workflow_manager import graph_workflow_functions

logger = logging.getLogger(__name__)

#: How far back the report looks. The user-facing promise is "last 24h".
REPORT_WINDOW_HOURS = 24

#: Ceiling on rows handed to the agent, newest first. A prompt that swallows an
#: unbounded feed is how a cheap report turns into an expensive one.
MAX_REPORT_ITEMS = 60

PROVIDER = "hackernews"


@graph_workflow_functions.register(
    "hn_radar_tick",
    meaning="hn-radar: record one ingestion cycle (no I/O — keeps the canvas live)",
)
def hn_radar_tick(event_name: str, data: dict, flow_ctx: Any) -> dict:
    """One beat per sync cycle.

    ``data`` is the bus envelope as the subscription delivers it:
    ``{tag, target, data}`` where the inner dict carries the cycle's counts and
    ``changed_ids``. We summarise rather than fan out: subscribing to the
    per-item lane instead would opt into its 30/min ceiling, where the excess is
    silently dropped.
    """
    payload = (data or {}).get("data") or {}
    changed = payload.get("changed_ids") or []
    summary = {
        "provider": payload.get("provider") or PROVIDER,
        "source_id": payload.get("source_id") or "",
        "created": int(payload.get("created") or 0),
        "updated": int(payload.get("updated") or 0),
        "unchanged": int(payload.get("unchanged") or 0),
        "changed": len(changed) if isinstance(changed, list) else 0,
        "tag": (data or {}).get("tag") or event_name,
    }
    flow_ctx.log(
        "hn-radar: cycle {created} new / {updated} updated / {unchanged} unchanged".format(**summary)
    )
    return summary


@graph_workflow_functions.register(
    "hn_radar_collect",
    meaning="hn-radar: gather the last 24h of Hacker News items for the report",
)
async def hn_radar_collect(event_name: str, data: dict, flow_ctx: Any) -> dict:
    """Write ``items.json`` into this execution's output folder.

    ``provider`` and ``hours`` come from the event, so this is the general verb
    ("window one provider's SourceItems") rather than an hn-only one; the seeded
    graph just takes the defaults.

    Ranking uses ``score``, which lives in ``raw``. That field is
    ``Persist.FALSE`` — a real DB column that never reaches metadata.json or FTS
    — precisely so it can move on every poll without flipping the content digest.
    So it is readable here and still cannot cause spurious updates.
    """
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    # Explicit None check, not `or`: `hours=0` is a legitimate request for an
    # empty window and must not silently fall back to the 24h default.
    requested = (data or {}).get("hours")
    hours = REPORT_WINDOW_HOURS if requested is None else int(requested)
    provider = str((data or {}).get("provider") or PROVIDER)
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    # Both the provider and the window are pushed into the query. Filtering in
    # Python instead would hydrate the WHOLE table — and `raw` is a real column
    # holding each item's verbatim provider payload, so that grows without
    # bound as the corpus does.
    rows = await SourceItem.get_all(
        QueryFilter(
            match=ExpressionNode(op=QueryOp.AND, operands=[
                ExpressionNode(op=QueryOp.EQ, operands=["provider", provider]),
                ExpressionNode(op=QueryOp.GE, operands=["occurred_at", since.isoformat()]),
            ])
        )
    )
    # The window bound is now the query's; this re-check only drops rows whose
    # occurred_at is unparseable or absent, which a string comparison cannot.
    fresh = [r for r in rows if _occurred_after(r.occurred_at, since)]
    # Score lives in `raw`, and JSON-field order_by is a no-op in this codebase,
    # so the ranking cut stays in Python.
    fresh.sort(key=_score_of, reverse=True)
    selected = fresh[:MAX_REPORT_ITEMS]

    items = [
        {
            "title": row.name or "",
            "url": row.permalink or "",
            "link": row.body or "",
            "author": row.author_display or "",
            "score": _score_of(row),
            "occurred_at": row.occurred_at or "",
            "external_id": row.external_id or "",
        }
        for row in selected
    ]
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_hours": hours,
        "provider": provider,
        "total_in_window": len(fresh),
        "included": len(items),
        "items": items,
    }

    out = flow_ctx.output_folder / "items.json"
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    flow_ctx.log(
        f"hn-radar: {len(items)} of {len(fresh)} {provider} items in the last {hours}h → {out}"
    )
    # Returned dict auto-emits this node's `done`, which is what routes onward.
    return {
        "items_file": str(out),
        "count": len(items),
        "total_in_window": len(fresh),
        "window_hours": hours,
        # Empty is a legitimate outcome on a cold instance — say so here rather
        # than letting the agent invent an explanation for a blank report.
        "empty": not items,
    }


def _occurred_after(occurred_at: str | None, since: datetime) -> bool:
    """Items with no timestamp are excluded: a 'last 24h' report that silently
    includes undated rows is not the report it claims to be."""
    if not occurred_at:
        return False
    try:
        when = datetime.fromisoformat(occurred_at)
    except (TypeError, ValueError):
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when >= since


def _score_of(row: Any) -> int:
    raw = getattr(row, "raw", None)
    score = raw.get("score") if isinstance(raw, dict) else None
    try:
        return int(score or 0)
    except (TypeError, ValueError):
        return 0
