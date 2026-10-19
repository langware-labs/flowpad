"""Authored metadata for a chart's Markdown main document."""
from typing import Literal, Optional

from flow_sdk.schema.data_spec import FrontMatter

ChartFormat = Literal["sequence", "excalidraw", "mermaid"]


class ChartSpec(FrontMatter):
    name: str = ""
    description: str = ""
    format: ChartFormat = "excalidraw"
    # The session that authored the chart, when an agent made it.
    session: Optional[str] = None
