"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import Optional

from flow_sdk.schema.data_spec import Body, FrontMatter


class SkillSpec(FrontMatter):
    """``SKILL.md`` — the shape of the document: ``name``/``description`` in the
    frontmatter, the markdown ``Body``. The folder's other header sources
    (``skill.yaml``/``skill.yml``) and the ``-@`` folder-name rule are
    ``derive_skill``'s — facts of the folder, not of this file."""

    name: Optional[str] = None
    description: Optional[str] = None
    body: Body = ""
