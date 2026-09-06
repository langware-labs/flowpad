"""Type metadata for DECK."""
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import (
    folder_capsule_id,
    folder_json_identity,
)
from flow_sdk.fs_store.indexer.functions.deck import (
    deck_asset_hash,
    deck_id_from_folder,
    extract_deck,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class DeckMeta(BaseMeta):
    template_ref: Optional[str] = None
    num_slides: Optional[int] = None
    html_file: Optional[str] = None


DECK = TypeInfo(
    type_name=EntityType.DECK,
    icon="Play",
    display_name="Decks",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="deck",
    # deck.json is the marker + shape claim: `flow show file <deck folder>`
    # resolves through discover_record_by_path → extract_deck → the deck entity
    # in one call (no project-root walk). asset_ref stays the FOLDER
    # so the viewer reads <folder>/*.html.
    shape=Folder(main="deck.json"),
    editor="deck",
    from_disk_fn=extract_deck,
    identity_carrier=folder_json_identity(folder_capsule_id, deck_id_from_folder),
    asset_hash_fn=deck_asset_hash,
    meta_model=DeckMeta,
)
