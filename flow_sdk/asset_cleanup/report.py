"""Persist an asset-cleanup scan as an AssetCleanupReport + gated Feed entry.

``generate_asset_cleanup_report(result)`` always saves the report entity (the
scan happened either way); the Home-Feed entry is posted ONLY when the scan
found garbage — a clean scan is not feed-worthy. Mirrors
``flow_sdk/usage_report/callback.py``.
"""
from __future__ import annotations

import logging
from datetime import datetime

from flow_sdk.asset_cleanup.run import AssetCleanupResult

_log = logging.getLogger(__name__)


def render_markdown(result: AssetCleanupResult) -> str:
    """Human-readable report body — garbage first, then unsure, then keepers."""
    lines = ["# Asset cleanup report", ""]
    groups = result.by_verdict()
    lines.append(
        f"Scanned {len(result.roots)} root(s) — "
        f"**{len(groups['garbage'])} garbage**, {len(groups['unsure'])} unsure, "
        f"{len(groups['keep'])} keep."
    )
    lines.append("")
    lines.append("## Scanned roots")
    lines.append("")
    lines.extend(f"- `{root}`" for root in result.roots)
    for verdict, title in (
        ("garbage", "Garbage"),
        ("unsure", "Unsure"),
        ("keep", "Keep"),
    ):
        section = groups[verdict]
        if not section:
            continue
        lines.append("")
        lines.append(f"## {title} ({len(section)})")
        lines.append("")
        for f in section:
            lines.append(f"- **{f.name}** ({f.kind}) — {f.reason}")
            lines.append(f"  `{f.path}`")
    return "\n".join(lines) + "\n"


async def generate_asset_cleanup_report(result: AssetCleanupResult):
    """Save an AssetCleanupReport for ``result``; post a Feed entry iff garbage.

    Returns the saved report entity. Feed-entry failures are logged, never
    raised — the persisted report is the primary artifact.
    """
    from flow_sdk.builtin.asset_cleanup_report import AssetCleanupReport  # noqa: PLC0415
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    generated_at = datetime.now().astimezone().isoformat()
    markdown = render_markdown(result)
    report = AssetCleanupReport.from_result(
        result, markdown=markdown, generated_at=generated_at
    )
    report = await report.save()

    if report.garbage_count > 0:
        try:
            user = await get_or_create_local_user()
            feed = FeedEntry(
                feed_status=FeedStatus.NEW.value,
                data={"type_id": str(report.typeid)},
            )
            await feed.save(user.typeid)
        except Exception:
            _log.exception(
                "asset_cleanup: failed to post Feed entry for %s", report.id
            )

    _log.info(
        "asset_cleanup: report %s saved (%d findings, %d garbage) — feed entry %s",
        report.id, report.finding_count, report.garbage_count,
        "posted" if report.garbage_count > 0 else "skipped (no garbage)",
    )
    return report
