"""Type metadata for USAGE_REPORT."""
from flow_sdk.builtin.usage_report import UsageReportSpec
from flow_sdk.schema.type_info._report import report_type_metadata
from flow_sdk.schema.types import EntityType

USAGE_REPORT = report_type_metadata(
    type=EntityType.USAGE_REPORT,
    icon="BarChart3",
    asset_spec=UsageReportSpec,
    index_fields=["name", "period_kind"],
)
