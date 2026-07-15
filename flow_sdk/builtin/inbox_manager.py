"""InboxManager — the @local singleton that owns the inbox unread projection.

A data-only projection entity: ``unread`` is the ONE number every unread surface
(sidebar pip, Unread pill, OS dock/launcher badge) renders. It is recomputed and
published exclusively by ``flow_sdk.inbox.reconcile`` — nothing else writes it,
and the frontend never computes, increments, or resets it.

Deliberately knows nothing about FlowMessages, Conversations, or Invitations:
the counting formula lives in ``flow_sdk/inbox`` — this class is only the
reflected state (backend Entity → data_op → frontend ``useInboxManager()``).
"""

import logging
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.schema.types import EntityType

# The uname of the singleton row. INTERNAL to get_local/create_local — callers
# address the manager through get_local(), never the literal.
_LOCAL_UNAME = "local"

logger = logging.getLogger(__name__)


class InboxManager(Entity):
    type: str = APIField(default=EntityType.INBOX_MANAGER.value)
    # The final unread count: active conversations whose latest message is
    # unread-received (one per conversation) + pending standalone invitations.
    unread: int = APIField(default=0, ge=0)

    # api_visible is required: entity UPDATE notifications only reach explicit
    # watchers of api-visible types (resource_tracker gate).
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[Optional[str]] = "Inbox"

    @classmethod
    def _local_id(cls) -> str:
        """Deterministic per-machine id (uuid5 via the shared @local minter)."""
        from flow_sdk.utils.machine_id import local_entity_id  # noqa: PLC0415

        return local_entity_id(EntityType.INBOX_MANAGER.value)

    @classmethod
    async def get_local(cls, *, create: bool = True) -> "InboxManager | None":
        """Return the singleton @local inbox manager (self-heals when missing).

        Resolution order mirrors ``ComputeNode.get_local``: deterministic stable
        id → legacy ``uname='local'`` row → mint. With ``create=True`` this never
        returns None.
        """
        manager = await cls.get_by_id(cls._local_id())
        if manager is None:
            try:
                manager = await cls.get_by_uname(_LOCAL_UNAME)
            except Exception:  # noqa: BLE001 — duplicate/legacy rows: take the first
                try:
                    rows = await cls.get_all({"match": {"uname": _LOCAL_UNAME}})
                    manager = rows[0] if rows else None
                except Exception:  # noqa: BLE001
                    manager = None
        if manager is None and create:
            manager = await cls.create_local()
        return manager

    @classmethod
    async def create_local(cls) -> "InboxManager":
        """Mint (or, under a race, adopt) the singleton @local row."""
        manager = cls(
            id=cls._local_id(),
            uname=_LOCAL_UNAME,
            name="Inbox",
            visitor_role="owner",
        )
        try:
            from flow_sdk.builtin.user import User  # noqa: PLC0415

            owner = await User.get_local()
            await manager.save(owner.typeid if owner else None)
        except Exception as save_error:  # noqa: BLE001
            # Concurrent creator minted the same deterministic id — adopt it.
            if "already exist" in str(save_error).lower():
                existing = await cls.get_by_id(cls._local_id())
                if existing is not None:
                    return existing
            raise
        return manager
