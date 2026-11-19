"""``Rca`` — the root-cause analysis of something that failed: why it failed, how bad it is, how to fix it.

Generic: ``subject_typeid`` names what it analyzes, of any type.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class RcaLevel(StrEnum):
    """How hard a fix is (``Rca.complexity``), or how bad a failure is (``Rca.severity``)."""

    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


class Rca(Entity):
    type: str = APIField(default=EntityType.RCA.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)

    #: What it analyzes, by typeid (any type); None when it is about nothing stored.
    subject_typeid: Optional[str] = APIField(default=None)
    #: How hard the fix is.
    complexity: Optional[RcaLevel] = APIField(default=None)
    #: How bad the failure is if it stays.
    severity: Optional[RcaLevel] = APIField(default=None)
    #: The analysis, in markdown.
    description_md: str = APIField(default="")
    #: How to fix it, in a few words (at most 250 characters).
    suggested_fix_md: Optional[str] = APIField(default=None)
