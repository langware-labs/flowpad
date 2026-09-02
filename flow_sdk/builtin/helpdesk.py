"""Helpdesk — a folder-backed support-desk PORTAL.

Folder layout::

    <scope>/agentic-assets/helpdesk/<name>/
        helpdesk.json   # {display_name, desk_project_id, welcome_message?, avatar_url?}
    <guides…>.md        # ordinary markdown, indexed as itself

A repo becomes a help desk by shipping that manifest. So "add a help desk from
git" is not its own flow — it is the ordinary "add a context folder from git",
and the desk appears because of what was indexed. That is also what lets support
tiers chain: B clones A's portal and inherits A's desk, then publishes its own
portal naming B's desk for C.

``Project.adopt_helpdesk_from_git`` does not weaken that. It delegates the
attach to ``add_context_dir_from_git`` verbatim and adds only a REPORT — which
desk arrived, whether it is the one that will actually serve, and where its
portal is. The attach stays single-owner; what the action supplies is the
path→entity resolution a UI cannot do for itself.

``desk_project_id`` is the HUB project that owns the ticket queue, so cloning
the portal also discovers where tickets go. It is the manifest's *claim*, not a
verified fact — a repo can name any project, and ``display_name`` is
repo-controlled too. Adoption is therefore explicit and per-project (the
context-bucket sidecar written on the adoption prompt); this entity only reports
what the folder says.

Fields are read THROUGH to disk rather than denormalized onto the row (the same
contract as ``Journey.auto_launch_enabled``): the manifest is the single source
of truth, so a ``git pull`` that changes the desk takes effect immediately, with
no re-index and no stale copy to reconcile.
"""
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class Helpdesk(Entity):
    type: str = APIField(default=EntityType.HELPDESK.value)
    # The portal folder on THIS machine. Private: a local checkout path is
    # meaningless anywhere else.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    _api_visible: ClassVar[bool] = True

    @property
    def portal_dir(self) -> Optional[str]:
        """Local path of the portal folder — where the guides live."""
        return self.asset_ref or None

    def _manifest_str(self, key: str) -> Optional[str]:
        """Read one manifest field, through to disk.

        Re-read per access rather than cached: the manifest is the source of
        truth, and a desk is read a handful of times per open — a stale brand
        after a ``git pull`` would be worse than the file read.
        """
        if not self.asset_ref:
            return None
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.fs_store.indexer.functions.helpdesk import (  # noqa: PLC0415
            manifest_str,
            read_manifest,
        )

        return manifest_str(read_manifest(Path(self.asset_ref)), key)

    @property
    def display_name(self) -> Optional[str]:
        """Brand shown to a requester. REPO-CONTROLLED — a portal can call
        itself anything, so this is never proof of who the desk is."""
        return self._manifest_str("display_name") or self.name

    @property
    def desk_project_id(self) -> Optional[str]:
        """Hub project that receives tickets. The manifest's claim; adoption is
        what makes it this project's desk."""
        return self._manifest_str("desk_project_id")

    @property
    def welcome_message(self) -> Optional[str]:
        return self._manifest_str("welcome_message")

    @property
    def avatar_url(self) -> Optional[str]:
        return self._manifest_str("avatar_url")
