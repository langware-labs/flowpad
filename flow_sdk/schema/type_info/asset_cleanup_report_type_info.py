"""Type metadata for ASSET_CLEANUP_REPORT."""
from flow_sdk.builtin.asset_cleanup_report import AssetCleanupReportSpec
from flow_sdk.fs_store.indexer.functions.asset_cleanup_report import derive_cleanup
from flow_sdk.schema.type_info._report import report_type_metadata
from flow_sdk.schema.types import EntityType

ASSET_CLEANUP_REPORT = report_type_metadata(
    type=EntityType.ASSET_CLEANUP_REPORT,
    icon="Recycle",
    asset_spec=AssetCleanupReportSpec,
    index_fields=["name"],
    derive_fields_fn=derive_cleanup,
)
