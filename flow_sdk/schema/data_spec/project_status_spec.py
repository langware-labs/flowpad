"""A project's status on this machine: parts, each answered once and kept until it goes stale.

``project.status`` is read from ``core/project_status`` and carried on the Project row as a computed field, so a
GET and every push carry what is stored. A part is never checked on read: a stale one is refreshed in the
background and pushed when it lands.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from flow_sdk.schema.data_spec.spec import DataSpec


class StatusPartSpec(DataSpec):
    """One part of a project's status: its last answer and how old it is."""

    spec_kind: ClassVar[str] = "project.status.part"

    #: The part's last answer (``setup``: a ``project.setup.readiness`` value). None: never answered here.
    value: Optional[dict[str, Any]] = None
    #: Epoch seconds of that answer.
    checked_at: Optional[float] = None
    #: How long an answer holds before a read refreshes it.
    ttl_s: float = 30.0
    #: Something changed what the answer depends on: the next read refreshes it, whatever its age.
    stale: bool = False
    #: A refresh is running now.
    checking: bool = False
    #: Why the last refresh failed; empty when it did not.
    error: str = ""


class ProjectStatusSpec(DataSpec):
    """Every part of a project's status on this machine, by name."""

    spec_kind: ClassVar[str] = "project.status"

    project_id: str
    parts: dict[str, StatusPartSpec] = {}
