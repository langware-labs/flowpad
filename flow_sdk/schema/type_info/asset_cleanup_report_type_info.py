"""Type metadata for ASSET_CLEANUP_REPORT."""
import json
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import NATIVE_JSON_IDENTITY, resolved_path_key
from flow_sdk.fs_store.indexer.functions.asset_cleanup_report import (
    extract_asset_cleanup_report,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class AssetCleanupReportMeta(BaseMeta):
    generated_at: Optional[str] = None
    root_count: Optional[int] = None
    finding_count: Optional[int] = None
    garbage_count: Optional[int] = None
    keep_count: Optional[int] = None
    unsure_count: Optional[int] = None
    session_id: Optional[str] = None


def _asset_cleanup_report_default_body(entity) -> Optional[str]:
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
        "generated_at": getattr(entity, "generated_at", None),
        "session_id": getattr(entity, "session_id", None),
        "roots": report.get("roots") or [],
        "findings": report.get("findings") or [],
        "summary": report.get("summary") or {},
        "markdown": report.get("markdown") or "",
    }
    return json.dumps(doc, indent=2) + "\n"


ASSET_CLEANUP_REPORT = TypeMetadata(
    type=EntityType.ASSET_CLEANUP_REPORT,
    from_disk_fn=extract_asset_cleanup_report,
    identity_backend=NATIVE_JSON_IDENTITY,
    id_stable_key_fn=resolved_path_key,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    creatable=False,
    icon="Recycle",
    api_visible=True,
    index_fields=["name"],
    asset_class="repo",
    family="asset_cleanup_report",
    main_layout="folder",
    main_file="report.json",
    main_file_is_asset_ref=True,
    default_body_fn=_asset_cleanup_report_default_body,
    owns_main_ref=True,
    meta_model=AssetCleanupReportMeta,
)
