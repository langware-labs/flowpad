"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import Any, ClassVar, List, Optional

from pydantic import field_validator

from flow_sdk.schema.data_spec import FrontMatter
from flow_sdk.schema.data_spec.io.native import Text
from flow_sdk.tags.grammar import to_tags


class SkillSpec(FrontMatter):
    """``SKILL.md`` — the shape of the document: ``name``/``description`` in the
    frontmatter, the markdown ``Body``. The folder's other header sources
    (``skill.yaml``/``skill.yml``) and the ``-@`` folder-name rule are
    ``derive_skill``'s — facts of the folder, not of this file."""

    main_file: ClassVar[str | None] = "SKILL.md"

    name: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    body: Text = ""

    @field_validator("tags", mode="before")
    @classmethod
    def _tags_list(cls, value: Any) -> Any:
        return None if value is None else to_tags(value)
