"""What ``syncmd`` says about a project's harness markdown files (``flow_sdk/core/md_sync.py``).

``syncmd`` keeps equivalent files equal (``CLAUDE.md`` ↔ ``AGENTS.md``, ``.claude/skills`` ↔
``.agents/skills``). The footer's MD chip shows this value: what a sync would write, and the
sources that have files in the repo but are not synced.
"""

from __future__ import annotations

from enum import StrEnum
from typing import ClassVar

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec


class MdSyncState(StrEnum):
    #: syncmd ran; ``stale`` and ``unsynced`` are its answer (both empty = in sync).
    OK = "ok"
    #: No ``syncmd`` executable on this computer.
    UNAVAILABLE = "unavailable"
    #: A ``syncmd`` older than the version this Flowpad needs.
    OUTDATED = "outdated"
    #: The project folder is not inside a git repository: nothing to sync.
    NOT_A_REPO = "not_a_repo"
    #: syncmd ran and failed; ``detail`` says why.
    ERROR = "error"


class MdSyncStaleSpec(DataSpec):
    """One group of equivalent files a sync would bring together."""

    name: str
    #: syncmd's asset type (``claude_md``, ``skill``, …).
    kind: str = ""
    #: The file the others are brought to.
    source: str = ""
    #: The files a sync writes, creates or deletes.
    targets: list[str] = Field(default_factory=list)


class MdSyncUnsyncedSpec(DataSpec):
    """A source with files in the repo that is not synced."""

    source: str
    paths: list[str] = Field(default_factory=list)


class MdSyncStatusSpec(DataSpec):
    """A project's markdown sync status on this computer."""

    spec_kind: ClassVar[str] = "md_sync.status"

    state: MdSyncState
    #: The installed syncmd version, when one was found.
    version: str = ""
    stale: list[MdSyncStaleSpec] = Field(default_factory=list)
    unsynced: list[MdSyncUnsyncedSpec] = Field(default_factory=list)
    #: Set on the answer to a sync: how many files it wrote.
    written: int | None = None
    #: ``unavailable`` / ``outdated``: the command that installs or updates syncmd.
    install_hint: str = ""
    #: ``error``: what syncmd said.
    detail: str = ""
