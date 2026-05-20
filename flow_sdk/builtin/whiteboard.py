"""Whiteboard entity — backed by a WhiteboardRecord on disk.

Folder layout::

    ~/.claude/whiteboards/<name>/
        WHITE_BOARD.md     # frontmatter + prose + auto-managed mermaid block
        board.json         # {kind:"excalidraw", version:1, data:<...>}
        thumbnail.svg      # generated on save (exportToSvg)

Creating a Whiteboard entity via ``save()`` writes the folder + stub files.
The Record layer (:class:`flow_sdk.fs_records.whiteboard_record.WhiteboardRecord`)
is the source of truth; this Entity provides the graph-route interface
(``POST /api/v1/graph/whiteboard`` → create, ``GET`` → list). Mirrors
:class:`flow_sdk.builtin.skill.Skill` field-for-field.
"""

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Whiteboard(Entity):
    """Whiteboard entity — folder-backed Excalidraw asset."""

    type: str = APIField(default=BuiltinEntityType.WHITEBOARD.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Palette"
