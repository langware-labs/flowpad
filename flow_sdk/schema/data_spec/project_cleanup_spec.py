"""What a project looks like to the cleanup screen, as a value.

A harness run leaves its working directory behind. Nothing ever collects those,
so the workspace accumulates folders that hold no sessions and no files — 609 of
them on the machine this was written against, 3.15 GB, all under
``<user_home>/Flowpad workspace``. They are indistinguishable from real projects
in the picker, because the picker shows a name and nothing else.

These shapes are what makes them distinguishable: a verdict per project, and
underneath it the evidence a person needs to disagree with the verdict — which
harness used it, whether it is a git repo, when it last changed, how many files
it holds.

**The verdict is advisory.** Nothing here deletes anything, and no caller may
treat ``EMPTY`` as permission to act. Every deletion is a person pressing a
button on a named project.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec

#: Age past which an untouched project is worth mentioning. A week is long
#: enough that a folder someone is mid-way through is never swept up.
STALE_AFTER_DAYS = 7

#: The file walk stops here. A project's exact file count stops being decision-
#: relevant long before 500 — what the reader needs to know is "empty", "a few",
#: or "a lot" — and the cap is what keeps the walk affordable over ~1,200 rows.
FILE_COUNT_CAP = 500


class CleanupVerdict(StrEnum):
    """What the classifier concluded about one project.

    Ordered by how safe it is to remove: an ``ORPHANED`` row has no folder left
    to lose, an ``EMPTY`` one has a folder with nothing in it, and ``ACTIVE``
    means the evidence says a person used this.
    """

    #: The row points at a directory that no longer exists. Nothing to delete
    #: but the row itself.
    ORPHANED = "orphaned"
    #: No sessions, no recorded activity, and no visible files. Old enough to be
    #: past ``STALE_AFTER_DAYS``.
    EMPTY = "empty"
    #: Empty by every session/activity signal, but either it still holds files
    #: or it was touched within the staleness window.
    STALE = "stale"
    #: Has sessions, recorded activity, or a harness that claims it.
    ACTIVE = "active"


class HarnessUseSpec(DataSpec):
    """One harness's relationship to a project: does it know it, and how much.

    Deliberately counts only. The PATHS this harness would delete are resolved
    from a ``HarnessIndex`` at the moment something is about to be removed —
    carrying them on every row of a listing meant reading three harness stores
    per project to fill a field nothing displayed.
    """

    spec_kind: ClassVar[str] = "project.harness_use"

    #: ``claude`` | ``codex`` | ``copilot``.
    harness: str
    session_count: int = 0
    last_session_at: Optional[str] = None


class GitInfoSpec(DataSpec):
    """Whether a project is a git repo, and whether losing it would lose work.

    ``remote`` and ``dirty`` cost a subprocess each, so they are resolved on
    demand for one project rather than for a whole listing; a spec built by the
    bulk pass carries ``has_repo`` alone and leaves the other two unset.
    """

    spec_kind: ClassVar[str] = "project.git_info"

    has_repo: bool = False
    #: First configured remote URL, or None when there is none.
    remote: Optional[str] = None
    #: True when the working tree has uncommitted changes.
    dirty: Optional[bool] = None
    #: Whether ``remote``/``dirty`` were actually looked up. The bulk pass leaves
    #: this False and fills only ``has_repo``; without it a reader cannot tell
    #: "no remote" from "not asked yet", and every repo renders as clean.
    resolved: bool = False


class ProjectCleanupSpec(DataSpec):
    """One project as the cleanup screen sees it.

    Built from the project list's own rows plus a bounded look at the directory,
    so the harness columns agree with the picker by construction rather than by
    a second, drifting scan.
    """

    spec_kind: ClassVar[str] = "project.cleanup"

    project_id: str
    name: str
    cwd: str
    verdict: CleanupVerdict

    #: Files found, skipping ``WALK_SKIP_DIRS`` and dotfiles. Capped — see
    #: ``file_count_capped``, which says the real number is higher.
    file_count: int = 0
    file_count_capped: bool = False
    #: Bytes of the counted files. Also bounded by the cap, so it is a floor.
    size_bytes: int = 0

    #: Directory mtime. The signal that answers "has anyone touched this".
    dir_modified_at: Optional[str] = None
    #: Newest session-file mtime across harnesses, from the project list.
    modified_at: Optional[str] = None
    #: When the project was last opened in the UI, from the Project entity.
    last_active_at: Optional[str] = None

    harnesses: list[HarnessUseSpec] = []
    git: Optional[GitInfoSpec] = None


class CleanupSummarySpec(DataSpec):
    """The counts the footer warning is drawn from.

    Rides on the project-list response so the warning costs no extra call. It is
    deliberately only counts: the scan path must stay shallow, and anything that
    needs per-project detail belongs on the screen the user opened.
    """

    spec_kind: ClassVar[str] = "project.cleanup_summary"

    empty_count: int = 0
    orphaned_count: int = 0
    #: Empty by session signals but still holding files, or too recent to sweep.
    stale_count: int = 0
    #: Warn above this many. Carried in the payload so the backend stays the
    #: single writer of the policy and the frontend keeps no threshold of its
    #: own to drift from it.
    threshold: int = 10


__all__ = [
    "FILE_COUNT_CAP",
    "STALE_AFTER_DAYS",
    "CleanupSummarySpec",
    "CleanupVerdict",
    "GitInfoSpec",
    "HarnessUseSpec",
    "ProjectCleanupSpec",
]
