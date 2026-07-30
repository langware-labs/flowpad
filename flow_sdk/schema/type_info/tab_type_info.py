from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

# DB-only placement record for one content-panel tab (docs/tab-management.md).
# Not walked, not browseable — rows are minted on demand (Tab.ensure_for).
TAB = TypeMetadata(
    type=EntityType.TAB,
    icon="AppWindow",
    api_visible=True,
    db_only=True,
)
