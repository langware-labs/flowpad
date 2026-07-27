"""AssetCleanupReport entity — a garbage-asset scan summary.

Produced by the asset-cleanup flow (``flow_sdk/asset_cleanup``): the
``asset_cleanup`` haiku agent inventories skills/agents under the scan roots
and classifies each; this entity carries only the headline counts the Home
Feed card needs. The full payload — per-finding verdicts + the rendered
markdown — lives in the entity's ``asset_ref`` file
(``.claude/cleanup_reports/<name>/report.json``), mirroring UsageReport.

``report`` is a create-time ferry (db-excluded): it carries the JSON payload
through save into ``default_body_fn`` (which materializes report.json) and is
never persisted or returned on GET.
"""
from __future__ import annotations

import json
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class AssetCleanupReport(Entity):
    type: str = APIField(default=EntityType.ASSET_CLEANUP_REPORT.value)
    name: str = APIField("")
    generated_at: Optional[str] = APIField(None)

    # Headline (drives the feed card; full detail is in report.json)
    root_count: int = APIField(0)
    finding_count: int = APIField(0)
    garbage_count: int = APIField(0)
    keep_count: int = APIField(0)
    unsure_count: int = APIField(0)
    session_id: Optional[str] = APIField(None, description="Worker session that produced the scan")

    asset_ref: Optional[str] = APIField(None)
    # Create-time ferry only: JSON text consumed by default_body_fn (which
    # materializes report.json at asset_ref). Never persisted to DB/blob.
    report: Optional[str] = NoDBAPIField(default=None)

    @classmethod
    def from_result(
        cls,
        result,
        *,
        name: str | None = None,
        markdown: str | None = None,
        generated_at: str | None = None,
    ) -> "AssetCleanupReport":
        """Build the entity from an ``AssetCleanupResult`` (single mapping authority)."""
        findings = list(result.findings)
        counts = {verdict: len(group) for verdict, group in result.by_verdict().items()}
        report_name = name or (
            f"cleanup-{generated_at[:10]}" if generated_at else "cleanup-report"
        )
        payload = {
            "roots": list(result.roots),
            "findings": [vars(f) for f in findings],
            "summary": dict(result.summary or counts),
            "markdown": markdown or "",
        }
        return cls(
            name=report_name,
            generated_at=generated_at,
            root_count=len(result.roots),
            finding_count=len(findings),
            garbage_count=counts["garbage"],
            keep_count=counts["keep"],
            unsure_count=counts["unsure"],
            session_id=result.session_id,
            report=json.dumps(payload),
        )
