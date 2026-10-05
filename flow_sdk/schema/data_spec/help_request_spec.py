"""Asking for help — one request, to a person or to a desk (docs/collab/ask-for-help.md).

``ask-for-help`` takes an ``AskForHelpRequest``. It is written on this machine FIRST — a conversation
and the opening message, plus a task when a person is asked — and delivered to the hub after, by
``Conversation.deliver``. Sign-in, the network and the hub's health decide WHEN it arrives, never
WHETHER the request exists.
"""

from __future__ import annotations

from enum import Enum
from typing import ClassVar, Optional

from pydantic import ConfigDict, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec


class HelpRecipientKind(str, Enum):
    #: A named person: the ask is a task assigned to them, discussed in a conversation with them.
    PERSON = "person"
    #: A help desk: the ask is a ticket in the desk's queue, answered by whoever picks it up.
    DESK = "desk"


class HelpOrigin(str, Enum):
    """Where the person asked from — for the desk's triage, never for routing."""

    VIBE = "vibe"
    FOOTER = "footer"
    PORTAL = "portal"
    PORTAL_AGENT_CHAT = "portal_agent_chat"
    LOAD_FAILURE = "load_failure"


class HelpRecipient(DataSpec):
    """Who is asked. A team that wants to be asked enables a desk — there is no team kind."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    spec_kind: ClassVar[str] = "help.recipient"

    kind: HelpRecipientKind
    email: Optional[str] = None
    #: A person the hub knows but whose address we do not (a roster contact).
    user_id: Optional[str] = None
    #: The desk's hub QUEUE project id — never a portal project's local id. None asks the nearest
    #: desk, resolved when the request is delivered (it may not be knowable while offline).
    desk_project_id: Optional[str] = None
    #: How to show it ("Flowpad support", "Dana").
    name: Optional[str] = None

    @model_validator(mode="after")
    def _a_person_is_addressable(self) -> "HelpRecipient":
        if self.kind is HelpRecipientKind.PERSON and not (self.email or self.user_id):
            raise ValueError("a person is asked by email or by hub user id")
        return self


class AskForHelpRequest(DataSpec):
    """One ask. ``conversation_id`` is minted by the asker and kept across resubmits — the same id is
    the same ask, so pressing Send again after a lost reply never makes a second one."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    spec_kind: ClassVar[str] = "help.request"

    conversation_id: Optional[str] = None
    recipient: HelpRecipient
    title: str = ""
    text: str
    #: Where the person was when they asked — lists the request with that project, routes nothing.
    project_id: Optional[str] = None
    #: Exactly what the person chose to attach (TypeIds). Nothing is added on their behalf.
    context: list[str] = []
    origin: HelpOrigin = HelpOrigin.VIBE
