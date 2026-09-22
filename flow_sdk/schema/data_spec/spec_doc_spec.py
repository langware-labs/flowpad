"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec import FrontMatter
from flow_sdk.schema.data_spec.io.native import Text


class SpecType(StrEnum):
    PLAN = "plan"
    ISSUE = "issue"
    SUPPORT_TICKET = "support_ticket"


class SpecDocSpec(FrontMatter):
    """``specs/<name>/spec.md`` — the shape of the document: two frontmatter
    keys and the markdown ``Body``. ``name`` is not here: it is the title, or
    the folder (``derive_spec``)."""

    main_file: ClassVar[str | None] = "spec.md"

    title: Optional[str] = None
    spec_type: Optional[str] = None
    content: Text = ""
