from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional, get_args

from pydantic import BaseModel, field_validator

from flow_sdk._compat import UTC
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.user import normalize_email
from flow_sdk.config import default_service_config
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.message_invite_spec import InviteState


class InvitationTarget(BaseModel):
    typeid: TypeId
    roles: list[str]


@dataclass
class MembershipRequest(BaseModel):
    recipient_email: str
    invitation_targets: List[InvitationTarget] = field(default_factory=list)
    target_url_path: Optional[str] = None
    expiration_at: Optional[datetime] = None
    message: Optional[str] = None
    type: str = field(init=False, default="invitation")


def conversation_target_path(conversation_id: str) -> str:
    """Canonical ``target_url_path`` for a conversation-targeted invitation.

    The single place that knows the path shape — producers (invitation
    materialization) and matchers (receiver-side pickers) reference this
    instead of hand-building ``/conversation/<id>`` strings.
    """
    return f"/conversation/{conversation_id}"


INVITATION_STATES: tuple[str, ...] = get_args(InviteState)


def invitation_answered(inv) -> bool:
    """Accepted, declined or revoked — anything but waiting. Reads plain objects too (the stream inbox's
    formula and the prune are tested with them)."""
    return getattr(inv, "accepted", None) is True or getattr(inv, "status", None) in ("accepted", "declined", "revoked")


class Invitation(Entity):
    type: str = APIField(default=BuiltinEntityType.INVITATION.value)
    recipient_email: str = APIField()
    target_url_path: Optional[str] = APIField(None)
    accepted: Optional[bool] = APIField(False)
    expiration_at: Optional[datetime] = APIField(None)
    sent: Optional[bool] = APIField(False)
    message: Optional[str] = APIField(None)
    # Membership invitations (organization / team) carry a lightweight target
    # descriptor instead of a backing conversation, so the stream inbox can render a
    # generic "Organization/Team invitation" row and accept knows what was
    # joined. None for conversation invitations.
    target_type: Optional[str] = APIField(None)
    target_id: Optional[str] = APIField(None)
    target_name: Optional[str] = APIField(None)
    target_roles: Optional[list[str]] = APIField(None)
    # The inviter, resolved hub-side from the InvitedBy edge — so the stream inbox row
    # can say WHO invited ("<name> invited you to …"), not just what.
    sender_name: Optional[str] = APIField(None)
    sender_user_id: Optional[str] = APIField(None)
    # What became of it, from the recipient's side. The row is kept for every state
    # so the stream inbox can always show what was shared and what the user did with it.
    # None on rows written before this field: read through ``state``.
    status: Optional[str] = APIField(None)
    resolved_at: Optional[datetime] = APIField(None)

    @property
    def state(self) -> str:
        """``pending`` | ``accepted`` | ``declined`` | ``revoked``."""
        if self.status in INVITATION_STATES:
            return self.status
        return "accepted" if self.accepted else "pending"

    async def resolve(self, state: str, owner=None, *, notify: bool = True) -> "Invitation":
        """Record the outcome on the row, never delete it. Idempotent."""
        if state not in INVITATION_STATES:
            raise ValueError(f"unknown invitation state {state!r}")
        if self.status == state:
            return self
        self.status = state
        self.resolved_at = datetime.now(UTC)
        if state == "accepted":
            self.accepted = True
        return await self.save(owner, notify=notify)

    async def retire(self, state: str, owner=None) -> None:
        """A share (it names its ``target``) is kept with its answer — the record of what was shared;
        a bare conversation invite has nothing to keep and goes."""
        if self.target_type:
            await self.resolve(state, owner)
        else:
            await self.delete()

    @field_validator("recipient_email", mode="before")
    @classmethod
    def _normalize_recipient_email(cls, v):
        # Emails are case-insensitive; store the canonical lowercase form so
        # recipient matching (local and hub) never misses on casing.
        if v is None or isinstance(v, str):
            return normalize_email(v) or ""
        return v

    def __init__(self, **data):
        super().__init__(**data)
        if not self.expiration_at:
            self.gen_expiration_at()

    def gen_expiration_at(self):
        self.expiration_at = datetime.now(UTC) + timedelta(days=default_service_config.invitation_expires_in_days)

    def is_expired(self) -> bool:
        # None-safe: rows hydrated via ``model_validate`` bypass ``__init__``
        # and may carry no expiration; those never expire locally.
        return self.expiration_at is not None and datetime.now(UTC) > self.expiration_at

    @classmethod
    def from_membership_request(cls, membership_request: "MembershipRequest") -> "Invitation":
        return cls(
            recipient_email=membership_request.recipient_email,
            target_url_path=membership_request.target_url_path,
            expiration_at=membership_request.expiration_at,
            message=membership_request.message,
            type=membership_request.type,
        )
