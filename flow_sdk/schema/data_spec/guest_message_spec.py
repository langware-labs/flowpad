"""A guest message's reference in a help-desk ticket's team conversation, and a steer's.

The support agent (untrusted, it talks to the customer) writes to the team side only as *guest messages*: each waits
in a hub queue and is screened before anyone on the team side can read it, so the team conversation holds only a
reference that shows how screening went (``metadata.guest_message``). The internal agent writes back to the support
agent only as a *steer*, a message the hub delivers into the ticket's agent process and keeps the delivery status of
(``metadata.steer``). Neither carries the other side's text back as a status.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, ClassVar, Optional

from pydantic import Field, ValidationError

from flow_sdk.schema.data_spec.spec import DataSpec


class GuestMessageStatus(StrEnum):
    """Where a guest message stands in screening."""

    #: Waiting for the screening to answer; its text is not readable.
    PENDING = "pending"
    #: Screening passed, or a person released it: the reference's text is the message.
    PASSED = "passed"
    #: Screening flagged it: its text stays hidden until a person releases or rejects it.
    HELD = "held"
    #: A person rejected it: its text stays hidden for good.
    REJECTED = "rejected"


class GuestFileRef(DataSpec):
    """One file of a guest message in its reference, named there only once the message passed (a hub-made copy)."""

    name: str
    media_type: str = ""
    size: int = 0


class GuestMessageRef(DataSpec):
    """``metadata.guest_message`` of a reference message: which queued message it stands for and how it screened."""

    spec_kind: ClassVar[str] = "message.guest_message"

    id: str
    status: GuestMessageStatus = GuestMessageStatus.PENDING
    reasons: list[str] = Field(default_factory=list)
    #: Who released or rejected it, once a person did.
    decided_by: Optional[str] = None
    #: Its files, once the message passed.
    files: list[GuestFileRef] = Field(default_factory=list)

    @classmethod
    def from_hub(cls, meta: Any) -> Optional["GuestMessageRef"]:
        """The hub's ``metadata.guest_message``, projected field by field (a key we do not model is dropped); ``None``
        when it names no queued message or does not validate."""
        if not isinstance(meta, dict) or not meta.get("id"):
            return None
        files = [f for f in meta.get("files") or [] if isinstance(f, dict)]
        try:
            return cls(
                id=str(meta["id"]),
                status=meta.get("status") or GuestMessageStatus.PENDING,
                reasons=[str(r) for r in meta.get("reasons") or []],
                decided_by=meta.get("decided_by") or None,
                files=[
                    GuestFileRef(
                        name=str(f.get("name") or ""),
                        media_type=str(f.get("media_type") or ""),
                        size=int(f.get("size") or 0),
                    )
                    for f in files
                ],
            )
        except (ValidationError, ValueError, TypeError):
            return None


class SteerDeliveryStatus(StrEnum):
    """What came of delivering a steer into the support agent's process (never the agent's words): the machine's own
    outcome (``SteerStatus`` in ``steer_run_spec``) plus ``sending`` while the hub is still on its way there."""

    #: Written in the team conversation, on its way to the agent's machine.
    SENDING = "sending"
    #: The agent's process ran the turn.
    RAN = "ran"
    #: The delivery failed (no machine reached, a refusal).
    FAILED = "failed"
    #: The ticket's process was in a turn already.
    BUSY = "busy"
    #: The ticket's unattended-turn cap was reached: the turn did not run.
    CAPPED = "capped"


class SteerRef(DataSpec):
    """``metadata.steer`` of a steer message: whom it steers, on which ticket, and its delivery status."""

    spec_kind: ClassVar[str] = "message.steer"

    agent: str
    ticket: str
    status: SteerDeliveryStatus = SteerDeliveryStatus.SENDING

    @classmethod
    def from_hub(cls, meta: Any) -> Optional["SteerRef"]:
        """The hub's ``metadata.steer``, projected field by field; ``None`` when it names no ticket or does not
        validate."""
        if not isinstance(meta, dict) or not meta.get("ticket"):
            return None
        try:
            return cls(
                agent=str(meta.get("agent") or ""),
                ticket=str(meta["ticket"]),
                status=meta.get("status") or SteerDeliveryStatus.SENDING,
            )
        except (ValidationError, ValueError):
            return None
