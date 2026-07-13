"""``Deck`` — a folder-backed generated presentation.

A deck is a folder under ``<project>/assets/decks/<slug>/`` produced by the
`decker` skill from a ``deck_template``:

    assets/decks/<slug>/
      deck.json      # build record: {title, template, slides[]}
      <name>.html    # self-contained Reveal deck (inlined CSS/JS + base64 media)

The container is the entity; the assembled HTML is the artifact its viewer
frames. ``template_ref`` links back to the source ``deck_template`` (provenance).

The walker + extractor + id-mint live in
``flow_sdk/fs_store/indexer/functions/deck.py``; the type registration lives in
``flow_sdk/schema/type_info/deck_type_info.py``. Modeled on DECK_TEMPLATE.
"""
from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class Deck(Entity):
    type: str = APIField(default="deck")
    title: str = APIField("")
    description: Optional[str] = APIField(None, blob=True)

    # Provenance: the source deck_template's entity id (None until the template
    # is indexed). Denormalized from deck.json's `template` ref by the extractor.
    template_ref: Optional[str] = APIField(default=None)
    num_slides: int = APIField(0)
    # The assembled output HTML filename inside the folder — the viewer reads it.
    html_file: str = APIField("")

    # Absolute path of the deck folder on disk, stamped by the indexer /
    # ``Entity.from_fs_ref``. A plain string, mirrors DECK_TEMPLATE.
    asset_ref: str = APIField(default="")
