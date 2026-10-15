"""Type metadata for CHART."""
from flow_sdk.assets.identity import (
    frontmatter_identity,
)
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.types.chart import chart_asset_hash, extract_chart
from flow_sdk.assets.types.chart_spec import ChartSpec
from flow_sdk.assets.types.scaffolds import render_chart_document, scaffold_chart
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

CHART = TypeInfo(
    type_name=EntityType.CHART,
    icon="ChartNetwork",
    display_name="Charts",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description", "format"],
    asset_class="repo",
    family="chart",
    # The folder's main doc — drives the share id-pin (``Folder.main``) and
    # stabilizes asset_ref/hash (without it asset_ref was the bare folder and the
    # index hash oscillated, making receive intermittent).
    shape=Folder(main="CHART.md"),
    editor="chart",
    from_disk_fn=extract_chart,
    render_fn=render_chart_document,
    scaffold_fn=scaffold_chart,
    scaffold_spec=ChartSpec,
    identity_carrier=frontmatter_identity(),
    asset_hash_fn=chart_asset_hash,
)
