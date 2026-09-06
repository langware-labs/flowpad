"""Type metadata for DECK_TEMPLATE."""
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import (
    folder_json_identity,
)
from flow_sdk.fs_store.indexer.functions.deck_template import (
    deck_template_asset_hash,
    extract_deck_template,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class DeckTemplateMeta(BaseMeta):
    layouts: Optional[list] = None
    page_types: Optional[list] = None
    num_layouts: Optional[int] = None


DECK_TEMPLATE = TypeInfo(
    type_name=EntityType.DECK_TEMPLATE,
    icon="Presentation",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="deck_template",
    # template.json is the folder's main document (see builtin/deck_template.py).
    # Declaring it — like DECK does with deck.json — lets file-resolving callers
    # (e.g. the asset "Improve" flow's resolveImproveTarget) find the editable
    # main file instead of erroring "no main file metadata".
    shape=Folder(main="template.json"),
    editor="deck_template",
    from_disk_fn=extract_deck_template,
    identity_carrier=folder_json_identity(),
    asset_hash_fn=deck_template_asset_hash,
    meta_model=DeckTemplateMeta,
)
