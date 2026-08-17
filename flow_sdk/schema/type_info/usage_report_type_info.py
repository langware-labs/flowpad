"""Type metadata for USAGE_REPORT."""
import json
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import NATIVE_JSON_IDENTITY, resolved_path_key
from flow_sdk.fs_store.indexer.functions.usage_report import (
    extract_usage_report,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class UsageReportMeta(BaseMeta):
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    period_kind: Optional[str] = None
    generated_at: Optional[str] = None
    total_cost_usd: Optional[float] = None
    session_count: Optional[int] = None
    total_duration_ms: Optional[int] = None
    total_tokens: Optional[int] = None
    prompt_count: Optional[int] = None
    skill_invocations: Optional[int] = None
    agent_spawns: Optional[int] = None
    cache_hit_rate: Optional[float] = None


def _usage_report_default_body(entity) -> Optional[str]:
    """report.json content — the full payload carried on create.

    Returns None for metadata-only saves so ``upsert_main_ref`` no-ops and never
    clobbers the on-disk report.
    """
    report = getattr(entity, "report", None)
    if isinstance(report, str):
        try:
            report = json.loads(report)
        except ValueError:
            return None
    if not isinstance(report, dict) or not report:
        return None
    # The file is the source of truth the indexer reads the id back from.
    doc = {
        "id": entity.id,
        "name": getattr(entity, "name", "") or "",
        "data": report.get("data") or {},
        "markdown": report.get("markdown") or "",
    }
    return json.dumps(doc, indent=2) + "\n"


USAGE_REPORT = TypeMetadata(
    type=EntityType.USAGE_REPORT,
    from_disk_fn=extract_usage_report,
    identity_backend=NATIVE_JSON_IDENTITY,
    id_stable_key_fn=resolved_path_key,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    creatable=False,
    icon="BarChart3",
    api_visible=True,
    index_fields=["name", "period_kind"],
    asset_class="repo",
    family="usage_report",
    main_layout="folder",
    main_file="report.json",
    main_file_is_asset_ref=True,
    default_body_fn=_usage_report_default_body,
    owns_main_ref=True,
    meta_model=UsageReportMeta,
)
