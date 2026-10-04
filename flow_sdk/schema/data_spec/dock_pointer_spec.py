"""DockPointerSpec — a tab's address as a value that can be authored and shipped.

Byte-for-byte the JSON ``DockPointer.toJSON()`` writes and ``Tab.pointer`` stores
(``{"viewType": ..., "pointer": ...}``), so a tab someone has open IS a value they
can declare — an agent's ``auto_open`` is a list of these.

A declared pointer travels (git, a share), so it must not name a machine: a vfs
rooted at a compute node (``vfs/compute_node-…/Users/…``) is refused. A file is
named relative to its project instead — ``vfs/project-<id>/<rel>`` — and
rebased onto the local machine when it is opened (``Agent.rebase_auto_open``).
"""

from __future__ import annotations

import json
import re
from typing import ClassVar

from pydantic import ConfigDict, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

#: A vfs segment rooted at a machine — the one part of a pointer that cannot travel.
MACHINE_VFS = re.compile(r"(^|/)vfs/compute_node-[^/]+/")
#: A vfs segment rooted at a project: ``vfs/project-<id>/<rel>``.
PROJECT_VFS = re.compile(r"(^|/)vfs/project-(?P<project>[^/]+)/(?P<rel>.+)$")


class DockPointerSpec(DataSpec):
    """One tab address. The field names ARE the wire names (``Tab.pointer`` JSON)."""

    spec_kind: ClassVar[str] = "dock.pointer"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: A ``ViewType`` value, held as the plain string the wire carries: the data-spec layer must not
    #: import ``flow_sdk.core`` (tests/unit/assets/test_runtime_boundary.py), so the view table is
    #: consulted inside the validator instead of in the annotation.
    viewType: str  # noqa: N815 — the DockPointer JSON key, verbatim
    pointer: str = ""

    @model_validator(mode="after")
    def _portable_tab(self) -> "DockPointerSpec":
        from flow_sdk.core.dock_address import ViewType, can_be_tab  # noqa: PLC0415

        try:
            view = ViewType(self.viewType)
        except ValueError:
            raise ValueError(f"{self.viewType!r} is not a view") from None
        if not can_be_tab(view, self.pointer or None):
            raise ValueError(f"{self.viewType}/{self.pointer} is not a tab")
        if MACHINE_VFS.search(self.pointer):
            raise ValueError(
                "a declared tab must not name a machine path — root the file in its project "
                "(vfs/project-<id>/<path>)"
            )
        return self

    def to_json(self) -> str:
        """The ``Tab.pointer`` string (``DockPointer.toJSON()``'s plain form)."""
        return json.dumps({"viewType": self.viewType, "pointer": self.pointer}, separators=(",", ":"))
