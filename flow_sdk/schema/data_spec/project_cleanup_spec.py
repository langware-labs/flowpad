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

#: Directories skipped by the file walk. They are large, uninteresting, and
#: their presence says nothing about whether a person has work in the folder.
WALK_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "__pycache__", ".next", "dist"})


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
    """One harness's relationship to a project.

    ``state_paths`` is the whole point: it is exactly what "remove from harness"
    would delete, resolved by the same readers the project list uses. Showing it
    means the destructive action can be inspected before it is taken rather than
    described in prose and hoped about.
    """

    spec_kind: ClassVar[str] = "project.harness_use"

    #: ``claude`` | ``codex`` | ``copilot``.
    harness: str
    session_count: int = 0
    last_session_at: Optional[str] = None
    #: Absolute paths this harness keeps for the project. Empty means the
    #: harness does not know it, which is why "remove from harness" is refused.
    state_paths: list[str] = []


class GitInfoSpec(DataSpec):
    """Whether a project is a git repo, and whether losing it would lose work.

    ``remote`` and ``dirty`` cost a subprocess each, so they are resolved on
    demand for one project rather than for a whole listing; a spec built by the
    bulk pass carries ``has_repo`` alone and leaves the other two unset.
    """

    spec_kind: ClassVar[str] = "project.git_info"

    has_repo: bool = False
    #: First configured remote URL, or None when there is none / not yet resolved.
    remote: Optional[str] = None
    #: True when the working tree has uncommitted changes. None means not resolved.
    dirty: Optional[bool] = None


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

    @property
    def session_count(self) -> int:
        """Sessions across every harness — the number the verdict turns on."""
        return sum(use.session_count for use in self.harnesses)

    @property
    def has_harness_state(self) -> bool:
        """Whether "remove from harness" would delete anything.

        False for every empty workspace folder: a directory a harness ran in but
        never opened a session in leaves no state behind, so the action is
        refused rather than silently doing nothing.
        """
        return any(use.state_paths for use in self.harnesses)

    @property
    def removable(self) -> bool:
        """Whether this is a cleanup candidate at all."""
        return self.verdict in (CleanupVerdict.EMPTY, CleanupVerdict.ORPHANED)


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
    #: Bytes held by the ``empty`` set — what cleaning up would return.
    empty_size_bytes: int = 0
    #: Warn above this many. Carried in the payload so the backend stays the
    #: single writer of the policy and the frontend has no threshold of its own.
    threshold: int = 10

    @property
    def should_warn(self) -> bool:
        return self.empty_count > self.threshold


__all__ = [
    "FILE_COUNT_CAP",
    "STALE_AFTER_DAYS",
    "WALK_SKIP_DIRS",
    "CleanupSummarySpec",
    "CleanupVerdict",
    "GitInfoSpec",
    "HarnessUseSpec",
    "ProjectCleanupSpec",
]
