"""The values of the git-share actions (preflight fix, shared-file artifact,
how a received share comes into the receiver's checkout) — values of their own
schemas, not bare dicts."""

from __future__ import annotations

from typing import Literal

from flow_sdk.schema.data_spec.spec import DataSpec


class GitShareFixRequest(DataSpec):
    """``POST …/git_share_fix`` body: which one-click fix the sender chose."""

    fix: Literal["commit", "push"]


class SharedFileRequest(DataSpec):
    """``POST /api/v1/graph/shared-file-artifact`` body: the file being shared."""

    path: str


class GitShareApply(DataSpec):
    """``POST …/git_share_update`` / ``open-shared`` / ``install`` consent: the
    receiver said yes to bringing the share into their checkout."""

    apply: bool = False


class ReceivePlan(DataSpec):
    """How a received git share comes into the receiver's own checkout — git's
    own verbs, decided before anything is written:

    * ``have``: the checkout already holds the shared version of the asset —
      it opens in place, nothing is written.
    * ``pull``: the receiver is on the shared branch and the commit is on its
      upstream — a pull brings it (and keeps one history).
    * ``cherry_pick``: anywhere else — ``commits`` (oldest first, only those
      that touch the asset) are cherry-picked with ``-x``; ``other_files`` are
      the files outside the asset those commits also change.
    """

    action: Literal["have", "cherry_pick", "pull"]
    commit: str
    #: The receiver's checked-out branch ("HEAD" when detached).
    branch: str = ""
    #: The receiver's checkout the share comes into.
    workdir: str = ""
    commits: list[str] = []
    other_files: list[str] = []
