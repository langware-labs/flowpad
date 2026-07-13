"""Type metadata for DECK."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.deck import (
    deck_asset_hash,
    deck_gen_id,
    extract_deck,
)


class DeckMeta(BaseMeta):
    template_ref: Optional[str] = None
    num_slides: Optional[int] = None
    html_file: Optional[str] = None


DECK = TypeMetadata(
    type=EntityType.DECK,
    icon="Play",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    main_subdir="assets/decks",
    main_layout="folder",
    # deck.json is the marker + shape claim: `flow show file <deck folder>`
    # resolves through discover_record_by_path → extract_deck → the deck entity
    # in one call (no project-root walk). asset_ref stays the FOLDER
    # (main_file_is_asset_ref default False) so the viewer reads <folder>/*.html.
    main_file="deck.json",
    from_disk_fn=extract_deck,
    gen_uuid_fn=deck_gen_id,
    asset_hash_fn=deck_asset_hash,
    meta_model=DeckMeta,
)
