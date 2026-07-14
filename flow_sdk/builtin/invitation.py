from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional

from pydantic import BaseModel, field_validator

from flow_sdk._compat import UTC
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.user import normalize_email
from flow_sdk.config import default_service_config
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class InvitationTarget(BaseModel):
    typeid: TypeId
    role: str


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


class Invitation(Entity):
    type: str = APIField(default=BuiltinEntityType.INVITATION.value)
    recipient_email: str = APIField()
    target_url_path: Optional[str] = APIField(None)
    accepted: Optional[bool] = APIField(False)
    expiration_at: Optional[datetime] = APIField(None)
    sent: Optional[bool] = APIField(False)
    message: Optional[str] = APIField(None)
    # Membership invitations (organization / team) carry a lightweight target
    # descriptor instead of a backing conversation, so the inbox can render a
    # generic "Organization/Team invitation" row and accept knows what was
    # joined. None for conversation invitations.
    target_type: Optional[str] = APIField(None)
    target_id: Optional[str] = APIField(None)
    target_name: Optional[str] = APIField(None)
    target_role: Optional[str] = APIField(None)
    # Who sent the invitation — mirrored from the hub's ``inviter`` enrichment
    # (resolved from the InvitedBy edge) so the inbox row can say
    # "<inviter> invited you to <target>" instead of an anonymous notice.
    inviter_id: Optional[str] = APIField(None)
    inviter_name: Optional[str] = APIField(None)

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
