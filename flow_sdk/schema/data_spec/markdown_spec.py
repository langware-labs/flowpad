"""Filesystem contracts independent of application entities."""
from typing import Any, List, Optional

from pydantic import field_validator

from flow_sdk.schema.data_spec import Body, FrontMatter


class MarkdownSpec(FrontMatter):
    """A ``.md`` document under ``docs/``: the frontmatter keys a doc may
    carry and its markdown ``Body``. ``asset_type``/``title``/``links`` fall
    back to the path and the body (``derive_markdown``)."""

    title: Optional[str] = None
    asset_type: Optional[str] = None
    tags: Optional[List[str]] = None
    links: Optional[List[str]] = None
    scope: Optional[str] = None
    body: Body = ""

    @field_validator("tags", mode="before")
    @classmethod
    def _tags_list(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [t.strip() for t in value.split(",") if t.strip()]
        return value


class ClaudeMdSpec(FrontMatter):
    """A ``CLAUDE.md``: frontmatter is rare; the document is its ``Body``."""

    asset_type: Optional[str] = None
    scope: Optional[str] = None
    body: Body = ""
