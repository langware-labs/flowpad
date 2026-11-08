"""Asking for help — one request, to a person or to a desk (docs/collab/ask-for-help.md).

``ask-for-help`` takes an ``AskForHelpRequest``. It is written on this machine FIRST — a conversation
and the opening message, plus a task when a person is asked — and delivered to the hub after, by
``Conversation.deliver``. Sign-in, the network and the hub's health decide WHEN it arrives, never
WHETHER the request exists.
"""

from __future__ import annotations

from enum import Enum
from typing import ClassVar, Optional

from pydantic import model_validator

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
    TOP_BAR = "top_bar"
    PORTAL = "portal"
    PORTAL_AGENT_CHAT = "portal_agent_chat"
    LOAD_FAILURE = "load_failure"
    ASSISTANT = "assistant"
    #: A credential's page: no secret manager to receive from, or no access to it.
    CREDENTIAL = "credential"


class HelpRecipient(DataSpec):
    """Who is asked. A team that wants to be asked enables a desk — there is no team kind."""

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


class HelpSend(str, Enum):
    """What Ask does with the request once it is written."""

    #: Send it, with the diagnosis and context the person chose (the diagnosis runs first).
    WHEN_DIAGNOSED = "when_diagnosed"
    #: Keep it on this computer: the conversation is written, nothing reaches the hub until Share.
    REVIEW_FIRST = "review_first"


class AskForHelpRequest(DataSpec):
    """One ask. ``conversation_id`` is minted by the asker and kept across resubmits — the same id is
    the same ask, so pressing Send again after a lost reply never makes a second one.

    The ask is a conversation and ONE message of kind ``help_request``: the person's words, and as its
    attachments the diagnosis and the context (screen, session, logs) when they chose to share them.
    Nobody to ask (no desk, no person) makes it a private conversation that never leaves this computer."""

    spec_kind: ClassVar[str] = "help.request"

    conversation_id: Optional[str] = None
    #: Who is asked: at most one desk (a ticket of its own) and any number of people (one conversation).
    recipients: list[HelpRecipient] = []
    #: One recipient, as older callers send it -- folded into ``recipients``.
    recipient: Optional[HelpRecipient] = None
    title: str = ""
    text: str
    #: Where the person was when they asked — lists the request with that project, routes nothing.
    project_id: Optional[str] = None
    #: Exactly what the person chose to attach (TypeIds). Nothing is added on their behalf.
    context: list[str] = []
    origin: HelpOrigin = HelpOrigin.VIBE
    #: "Run diagnosis": diagnose this machine before the request is sent (``flow_sdk.diagnose``).
    diagnose: bool = True
    #: "Share context": the diagnosis, screen, session and logs go with the request. Off, they are captured
    #: anyway and stay on this computer until the person shares them (``help-request-share``).
    share_context: bool = True
    #: Each context item the person left out in the review ("Leave out"), by file name.
    left_out: list[str] = []
    send: HelpSend = HelpSend.WHEN_DIAGNOSED
    #: A diagnosis already taken: it is the one attached, and nothing is diagnosed again.
    diagnosis_id: Optional[str] = None
    #: The session on screen (a TypeId) -- what the diagnose is told the person was in.
    process: Optional[str] = None
    #: The browser window asked from (its socket's id): what the diagnosis says was on screen.
    connection_id: Optional[str] = None

    @model_validator(mode="after")
    def _one_recipient_list(self) -> "AskForHelpRequest":
        if self.recipient is not None and self.recipient not in self.recipients:
            object.__setattr__(self, "recipients", [self.recipient, *self.recipients])
        desks = [r for r in self.recipients if r.kind is HelpRecipientKind.DESK]
        if len(desks) > 1:
            raise ValueError("ask one help desk at a time")
        return self

    @property
    def desk(self) -> Optional[HelpRecipient]:
        return next((r for r in self.recipients if r.kind is HelpRecipientKind.DESK), None)

    @property
    def people(self) -> list[HelpRecipient]:
        return [r for r in self.recipients if r.kind is HelpRecipientKind.PERSON]


class HelpRequestCarrier(DataSpec):
    """``help_request.value.json`` -- rides every help request message: it is what marks the message as one
    on every machine (the hub drops unknown header fields), and says whether its context was shared."""

    spec_kind: ClassVar[str] = "help.request.carrier"

    title: str = ""
    #: The context files on this message (``diagnosis.value.json`` …); empty while not shared.
    context: list[str] = []
    context_shared: bool = False
