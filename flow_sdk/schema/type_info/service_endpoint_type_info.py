"""Type metadata for SERVICE_ENDPOINT — one service a Deployment exposes.

Row-only, like its parent Deployment: an endpoint is a fact about a placement,
not a file. Same glyph and label the hub's ``TYPE_PRESENTATION`` ships.
"""

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

SERVICE_ENDPOINT = TypeInfo(
    type_name=EntityType.SERVICE_ENDPOINT,
    api_visible=True,
    icon="Plug",
    display_name="Service endpoints",
)
