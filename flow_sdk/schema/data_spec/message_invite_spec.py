"""``MessageInvite`` — what an invite message carries: which share it is and what became of it.

Every share (a machine, a team, a project, an agent…) arrives as a message in the 1:1 conversation
between the person who shared and the person shared with. The hub writes this on the message and
updates ``state`` in place when the invite is accepted, declined or revoked, so the card in the
thread always reads the current answer — on the desktop and on the hub page alike.

The hub's dict is a foreign payload: a key we do not model is dropped, never an error.
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal, Optional

from pydantic import AwareDatetime, ConfigDict, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

InviteState = Literal["pending", "accepted", "declined", "revoked"]


class MessageInvite(DataSpec):
    # A key the hub adds that we do not model is dropped, not an error.
    model_config = ConfigDict(frozen=True, extra="ignore")
    spec_kind: ClassVar[str] = "message.invite"

    invitation_id: str
    state: InviteState = "pending"
    target_type: str
    target_id: str
    target_name: Optional[str] = None
    roles: list[str] = []
    resolved_at: Optional[AwareDatetime] = None

    @model_validator(mode="before")
    @classmethod
    def _drop_nulls(cls, value: Any) -> Any:
        # The hub sends null for what it does not know; the defaults stand for it.
        return {k: v for k, v in value.items() if v is not None} if isinstance(value, dict) else value


__all__ = ["InviteState", "MessageInvite"]
