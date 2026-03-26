import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from flow_sdk._compat import UTC
from typing import List, Optional

from pydantic import BaseModel

from flow_sdk.config import default_service_config
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity


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


class Invitation(Entity):
    type: str = APIField(default=BuiltinEntityType.INVITATION.value)
    recipient_email: str = APIField()
    target_url_path: Optional[str] = APIField(None)
    accepted: Optional[bool] = APIField(False)
    expiration_at: Optional[datetime] = APIField(None)
    sent: Optional[bool] = APIField(False)
    message: Optional[str] = APIField(None)

    def __init__(self, **data):
        super().__init__(**data)
        if not self.expiration_at:
            self.gen_expiration_at()

    def gen_expiration_at(self):
        self.expiration_at = datetime.now(UTC) + timedelta(days=default_service_config.invitation_expires_in_days)

    def is_expired(self) -> bool:
        return datetime.now(UTC) > self.expiration_at

    @classmethod
    def from_membership_request(cls, membership_request: "MembershipRequest") -> "Invitation":
        return cls(
            recipient_email=membership_request.recipient_email,
            target_url_path=membership_request.target_url_path,
            expiration_at=membership_request.expiration_at,
            message=membership_request.message,
            type=membership_request.type,
        )
