"""Chart entity — a visual asset backed by a folder on disk.

Folder layout::

    ~/agentic-assets/chart/<name>/
        CHART.md           # frontmatter (incl. format) + prose + auto-managed mermaid block
        chart.json         # format: sequence   — {participants:[...], messages:[...]}
        board.json         # format: excalidraw — {kind:"excalidraw", version:1, data:<...>}
        thumbnail.svg      # generated on save

A ``mermaid`` chart keeps its source in the ```mermaid``` block of CHART.md.
Creating a Chart entity writes the folder, the Markdown main document and the
format's empty source file. Filesystem rendering, parsing, and missing-document
repair belong to flow_sdk.assets; this Entity provides the graph-route interface.
"""

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.assets.types.chart import DEFAULT_CHART_FORMAT
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Chart(Entity):
    """Chart entity — folder-backed visual asset in one of several formats."""

    type: str = APIField(default=BuiltinEntityType.CHART.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    format: str = APIField(default=DEFAULT_CHART_FORMAT)
    # The agentic process that builds the chart (CHART.md ``session``); feedback goes to it.
    session: Optional[str] = APIField(default=None)
    #: What indexing found that will not render as authored -- an icon tag no pack resolves.
    problems: list[str] = APIField(default_factory=list)
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
