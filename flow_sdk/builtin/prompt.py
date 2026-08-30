"""Prompt — a reusable, library-managed prompt (docs/prompt-library.md).

Markdown-backed: ``<project>/prompts/<name>.md`` with YAML frontmatter
(name/icon/color, optional group_id) and the prompt text as the body. An
ordinary entity in every other respect — ``project_id`` scope and the
generic ``group_id`` folder membership apply unchanged. The library UI
enqueues ``text`` onto a process's prompt queue (``prompt_queue.md``); the
frontmatter ``queue`` block is reserved for v1.1 enqueue flags and is not
honored (nor surfaced) in v1.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
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


class Prompt(Entity):
    type: str = APIField(default="prompt")
    name: str = APIField("")
    text: Optional[str] = APIField(
        # Inline (no blob=True): prompts are short by nature, and blob storage
        # requires a parent storage a freshly UI-created entity doesn't have.
        None, description="The prompt body (markdown body of the .md file)."
    )
    icon: Optional[str] = APIField(
        None, description="Lucide export name or emoji char (the UI's renderIconValue resolves either)."
    )
    color: Optional[str] = APIField(
        None, description="Hex color from the curated contrast-tested palette."
    )
    use_count: int = APIField(
        0, description="Times this prompt was enqueued from the library."
    )
    last_used_at: Optional[str] = APIField(
        None, description="ISO timestamp of the last library enqueue."
    )
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
