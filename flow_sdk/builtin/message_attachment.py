"""MessageAttachment — a received, staged bundle attachment awaiting install.

Minted at bundle-unpack time for every file-backed asset (and git-transfer
entry) found in a received ``.flowmsg`` bundle. The asset's bytes stay in the
FlowMessage's staging area (``records_data/flow_message/<stem>/unpacked/``) —
NOT indexed, NOT visible to agents — until the user explicitly installs it via
the ``install`` action (user scope or a chosen project). ``scope is None``
means "just downloaded / staged". DB-only entity: no TypeInfo, no RecordType,
no indexer involvement (FeedEntry pattern).
"""
from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class AttachmentScope(StrEnum):
    USER = "user"
    PROJECT = "project"


class TransferMode(StrEnum):
    COPY = "copy"   # bytes ride in the bundle; install = copy from staging
    GIT = "git"     # git-transfer entry; install = clone/pull via metadata


class MessageAttachment(Entity):
    type: str = APIField(default=EntityType.MESSAGE_ATTACHMENT.value)

    flow_message_id: str = APIField(default="")
    conversation_id: Optional[str] = APIField(default=None)

    # The shared asset's identity as sent (sender-pinned frontmatter id).
    asset_type: str = APIField(default="")
    asset_id: str = APIField(default="")

    # Display snapshot taken from the bundle at unpack time.
    name: Optional[str] = APIField(default=None)
    description: Optional[str] = APIField(default=None)

    # Staging location, RELATIVE to the FlowMessage data dir
    # (e.g. "unpacked/attachment/skill-@<id>").
    unpacked_path: str = APIField(default="")

    # Whether "Install global" (user scope) is offered — schema-derived at
    # stage time from TypeInfo.main_subdir (see _stage_attachment); the install
    # action re-derives and enforces the same policy server-side.
    user_scope_allowed: bool = APIField(default=True)

    transfer_mode: str = APIField(default=TransferMode.COPY.value)
    # Provenance recorded at unpack, applied (stamped) at install.
    git_origin: Optional[dict] = APIField(default=None)
    # The git_transfers.json entry for TransferMode.GIT attachments.
    git_transfer: Optional[dict] = APIField(default=None)

    # Sender opt-in ("create bookmark" share checkbox): when true, install mints
    # a FAVORITE Bookmark on the receiver pointing at the materialized entity.
    # Rides the bundle's share_options.json (message-level), stamped at unpack.
    create_bookmark: bool = APIField(default=False)

    # Falsy (None or "") = staged only; "user" | "project" = installed there.
    # "" is the CLEARED form — entity save is exclude-none and the DB merge
    # never removes fields, so uninstall resets with "" rather than None.
    scope: Optional[str] = APIField(default=None)
    project_id: Optional[str] = APIField(default=None)
    # Absolute root the files were copied under — the uninstall anchor.
    installed_root: Optional[str] = APIField(default=None)
    installed_at: Optional[datetime] = APIField(default=None)

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "PackageOpen"

    @property
    def target_typeid(self) -> TypeId | None:
        if not self.asset_type or not self.asset_id:
            return None
        return TypeId(type=self.asset_type, id=self.asset_id)

    @property
    def installed(self) -> bool:
        return bool(self.scope)

    @staticmethod
    def allocate_deterministic_id(flow_message_id: str, entry_key: str) -> str:
        """v5 id from (message, bundle entry) — re-unpack upserts the same row."""
        return mint_uuid(f"message_attachment:{flow_message_id}:{entry_key}")
