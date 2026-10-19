"""The request bodies of the git-share actions (preflight fix, shared-file
artifact, drift send-back) — values of their own schemas, not bare dicts."""

from __future__ import annotations

from typing import Literal

from flow_sdk.schema.data_spec.spec import DataSpec


class GitShareFixRequest(DataSpec):
    """``POST …/git_share_fix`` body: which one-click fix the sender chose."""

    fix: Literal["commit", "push"]


class SharedFileRequest(DataSpec):
    """``POST /api/v1/graph/shared-file-artifact`` body: the file being shared."""

    path: str


class GitShareSendBack(DataSpec):
    """``POST …/git_share_send_back`` body: who is sending, for the branch name."""

    sender: str = "receiver"
    message: str | None = None
