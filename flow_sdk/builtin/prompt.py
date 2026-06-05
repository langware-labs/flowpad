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

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


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
    asset_ref: Optional[str] = APIField(None)
