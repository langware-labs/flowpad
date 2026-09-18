"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import field_validator

from flow_sdk.schema.data_spec import Body, FrontMatter


class PromptSpec(FrontMatter):
    """``prompts/<name>.md`` — the shape of the document: frontmatter
    (name/icon/color, an optional library folder, the usage counters that must
    survive a reindex) and the prompt ``text`` as the markdown ``Body``.

    Junk in the counters is ignored, never an error: a hand-edited file must
    still index. ``last_used_at`` normalizes the timestamp YAML parses as a
    ``datetime`` back to the ISO-Z string the entity holds.
    """

    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    group_id: Optional[str] = None
    use_count: int = 0
    last_used_at: Optional[str] = None
    text: Body = ""

    @field_validator("group_id", mode="before")
    @classmethod
    def _valid_group(cls, value: Any) -> Optional[str]:
        from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

        return adopt_entity_id(value) or None

    @field_validator("use_count", mode="before")
    @classmethod
    def _int_or_zero(cls, value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    @field_validator("last_used_at", mode="before")
    @classmethod
    def _iso_z(cls, value: Any) -> Optional[str]:
        if isinstance(value, datetime):
            return value.isoformat().replace("+00:00", "Z")
        return value if isinstance(value, str) and value else None
