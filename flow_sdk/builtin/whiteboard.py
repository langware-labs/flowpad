"""Whiteboard entity — backed by a folder on disk.

Folder layout::

    ~/agentic-assets/whiteboard/<name>/
        WHITE_BOARD.md     # frontmatter + prose + auto-managed mermaid block
        board.json         # {kind:"excalidraw", version:1, data:<...>}
        thumbnail.svg      # generated on save (exportToSvg)

Creating a Whiteboard entity writes the folder and Markdown main document.
The canvas editor writes board.json and thumbnail.svg. Filesystem rendering,
parsing, and missing-document repair belong to flow_sdk.assets; this Entity
provides the graph-route interface.
"""

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Whiteboard(Entity):
    """Whiteboard entity — folder-backed Excalidraw asset."""

    type: str = APIField(default=BuiltinEntityType.WHITEBOARD.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

