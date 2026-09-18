"""Authored metadata for a whiteboard's Markdown main document."""
from flow_sdk.schema.data_spec import FrontMatter


class WhiteboardSpec(FrontMatter):
    name: str = ""
    description: str = ""
