"""``Rca`` — the root-cause analysis of something that failed: why it failed, how bad it is, how to fix it.

Generic: ``subject`` names what it analyses by typeid (a QA test result, a run, any entity). Q (the QA app) writes
one per test result that did not pass, a skip included (why it was skipped).
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class Rca(Entity):
    type: str = APIField(default=EntityType.RCA.value)
    #: What it analyses, by typeid (e.g. a ``qa_test_result``).
    subject: str = APIField(default="")
    #: How hard the fix is: ``low`` | ``moderate`` | ``high``.
    complexity: str = APIField(default="")
    #: How bad the failure is if it stays: ``low`` | ``moderate`` | ``high``.
    severity: str = APIField(default="")
    #: The analysis, in markdown.
    description_md: str = APIField(default="")
    #: How to fix it, in a few words (at most 250 characters).
    suggested_fix_md: Optional[str] = APIField(default=None)
