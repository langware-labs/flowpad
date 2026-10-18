"""Type metadata for ICON_PACK -- icons as an asset.

``<scope>/agentic-assets/icon_pack/<name>/icon_pack.json`` (an ``IconPackDocSpec``)
with its SVGs beside it, in any scope: a project, the user asset root, the
shipped assistant project, a received asset. Indexing registers the pack with
the icon registry (``extract_icon_pack``), so its ``<kind>.<icon>`` tags resolve
wherever icons do; the row's ``error`` says what did not validate.
"""

from flow_sdk.assets.identity import folder_json_identity
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.types.icon_pack import extract_icon_pack, icon_pack_asset_hash
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

ICON_PACK = TypeInfo(
    type_name=EntityType.ICON_PACK,
    icon="Palette",
    display_name="Icon packs",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description", "error"],
    asset_class="repo",
    family="icon_pack",
    shape=Folder(main="icon_pack.json"),
    from_disk_fn=extract_icon_pack,
    # The id lives beside the manifest, never in it: icon_pack.json is an
    # IconPackDocSpec and stays exactly what its author wrote.
    identity_carrier=folder_json_identity(),
    asset_hash_fn=icon_pack_asset_hash,
)
