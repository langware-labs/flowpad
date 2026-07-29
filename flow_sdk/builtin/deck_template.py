"""``DeckTemplate`` — a folder-backed, reusable slide-deck template.

A deck template is a folder under ``assets/deck-templates/<slug>/`` holding one
isolated HTML component per slide layout plus the shared design system:

    assets/deck-templates/<slug>/
      template.json                # {"metadata": {id?, title, description, page_types, …}, "data": {…}}
      layouts/<layout name>.html   # one <section> slide component per layout
      common/<part>.<js|ts|css|html>  # tokens.css / theme.css / deck.js shared by all layouts
      media/<common|layout name>/<file>
      vendor/reveal/               # vendored Reveal.js runtime (headless — no theme CSS)

``template.json`` is a two-section document (``{"metadata": {...}, "data": {...}}``,
same convention as ``dataset.json``) and is the walker's marker file. The
container is the entity; individual layouts are files read on demand, not
child entities. Generated decks (``assets/decks/<name>/``) are plain folders —
only the template is a first-class type.

The walker + extractor + id-mint slot functions live in
``flow_sdk/fs_store/indexer/functions/deck_template.py``; the type registration
lives in ``flow_sdk/schema/type_info/deck_template_type_info.py``. Modeled on
DATASET.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity


class DeckTemplate(Entity):
    type: str = APIField(default="deck_template")
    title: str = APIField("")
    description: Optional[str] = APIField(None, blob=True)

    # Denormalized from the folder by extract_deck_template.
    layouts: List[str] = APIField(default_factory=list)      # layout names (file stems under layouts/)
    page_types: List[str] = APIField(default_factory=list)   # semantic page types the template covers
    num_layouts: int = APIField(0)

    # Free `data` section of template.json (use-case-owned passthrough).
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)

    created_at: Optional[datetime] = APIField(None)

    # Absolute path of the template folder on disk, stamped by the indexer /
    # ``Entity.from_fs_ref``. A plain string, mirrors DATASET/WHITEBOARD.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    def layout_html(self, name: str) -> Optional[str]:
        """Lazily read one layout component's HTML from disk, else ``None``."""
        base = getattr(self, "asset_ref", None)
        if not base:
            return None
        from pathlib import Path

        path = Path(str(base)) / "layouts" / f"{name}.html"
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None
