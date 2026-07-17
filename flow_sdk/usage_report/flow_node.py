"""The daily-analysis flow's ``analyze`` pysdk node body.

The seeded flow's ``scripts/analyze_usage.py`` is a thin shim importing
``on_flow_event`` from here, so the real logic is package-versioned and
unit-testable — upgrading flow_sdk upgrades every instance's flow without
touching the flow folder.

Stage contract (subprocess, full flow_sdk import access):

* window: ``data["start"]`` / ``data["end"]`` (ISO) when injected — the
  backfill/validation override — else yesterday in local time;
* runs the deterministic ``analyze_usage`` + ``render_markdown``;
* persists the UsageReport via the instance REST create (a subprocess must
  never open the instance DB directly);
* emits ``report_ready`` with the compact headline (full detail lives in the
  report's report.json — run journals / WS stay small).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any


def _yesterday_local_range() -> tuple[datetime, datetime]:
    """[yesterday 00:00, today 00:00) in the machine's local timezone."""
    now_local = datetime.now().astimezone()
    today_midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return today_midnight - timedelta(days=1), today_midnight


def _window_from_event(data: dict) -> tuple[datetime, datetime]:
    """The analysis window: explicit ``start``/``end`` ISO override, else yesterday.

    Overrides go through analyze's canonical ``_parse_iso`` (``Z`` suffix,
    naive→UTC) so a hand-authored backfill payload can't yield naive datetimes
    that mismatch the tz-aware bucketing inside ``analyze_usage``.
    """
    from flow_sdk.usage_report.analyze import _parse_iso

    start = _parse_iso(str(data.get("start") or "") or None)
    end = _parse_iso(str(data.get("end") or "") or None)
    if start is not None and end is not None:
        return start, end
    return _yesterday_local_range()


def _create_payload(data: Any, markdown: str) -> dict:
    """The REST-create body for the report.

    Field set derives from the ``UsageReport`` class's OWN declarations
    (``__annotations__`` — not inherited Entity plumbing), minus what the
    server owns, so a new headline field on the entity flows through
    automatically instead of drifting out of a hand-kept allowlist.
    """
    from flow_sdk.builtin.usage_report import UsageReport

    fields = set(UsageReport.__annotations__) - {"type", "asset_ref"}
    return UsageReport.from_data(data, markdown=markdown).model_dump(include=fields)


def on_flow_event(event_name: str, data: dict, flow_ctx: Any) -> None:
    from flow_sdk.usage_report import analyze_usage, render_markdown

    start, end = _window_from_event(data or {})
    flow_ctx.log(f"analyze: window {start.isoformat()} .. {end.isoformat()} (event={event_name})")

    report_data = analyze_usage(start, end)
    markdown = render_markdown(report_data)
    row = flow_ctx.post("/api/v1/graph/usage_report", _create_payload(report_data, markdown)) or {}

    headline = {
        "report_id": row.get("id"),
        "name": row.get("name"),
        "total_cost_usd": report_data.total_cost_usd,
        "session_count": report_data.session_count,
        "prompt_count": report_data.prompt_count,
        "total_tokens": report_data.total_tokens,
        "total_duration_ms": report_data.total_duration_ms,
        "period_start": report_data.period_start,
        "period_end": report_data.period_end,
    }
    flow_ctx.log(f"analyze: report {row.get('id')} — "
                 f"${report_data.total_cost_usd:.2f} · {report_data.session_count} sessions · "
                 f"{report_data.prompt_count} prompts")
    flow_ctx.emit_flow_event("report_ready", headline)
