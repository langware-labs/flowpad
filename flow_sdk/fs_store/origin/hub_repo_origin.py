"""HubRepoOrigin — the ``kind="hub_repo"`` member of ``FSOrigin``.

A published asset lives in its project's hub-hosted git repository, at its real
project-relative path (``rel_path``). ``repo`` names that repository on the hub
(a ``git_repo`` typeid); a git client reaches it at
``<hub>/api/v1/graph/git_repo/<id>/git`` with the user's hub token.

``tree`` is the git object id of the asset's own file or folder — the asset's
VERSION. A publish compares it with the hub's current tree to tell "the hub has
edits I have not pulled" from "nothing changed", per asset, so publishing or
editing one asset never blocks another in the same project.

The wire shape matches the hub's ``git_origin`` for hosted assets exactly.
"""

from __future__ import annotations

from typing import Literal

from flow_sdk.fs_store.origin.fs_origin import ORIGIN_MODELS, FSOrigin

HUB_REPO_ORIGIN_KIND = "hub_repo"


class HubRepoOrigin(FSOrigin):
    kind: Literal["hub_repo"] = "hub_repo"
    #: The hosted ``git_repo`` typeid on the hub.
    repo: str = ""
    #: The commit the hub last synced this asset at.
    head_commit: str = ""
    #: The asset's own git object id at ``head_commit`` — its version.
    tree: str = ""

    @property
    def repo_id(self) -> str:
        return self.repo.removeprefix("git_repo-")

    def key(self) -> str:
        return f"{HUB_REPO_ORIGIN_KIND}:{self.repo}:{self.rel_path}"

    @property
    def transportable(self) -> bool:
        return True


ORIGIN_MODELS.register(HubRepoOrigin, HUB_REPO_ORIGIN_KIND)

__all__ = ["HUB_REPO_ORIGIN_KIND", "HubRepoOrigin"]
