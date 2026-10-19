"""``ChannelSpec`` — what a conversation's channel is, declared once and read everywhere.

Every conversation has a channel. A source-backed one replies through its ``DataSource``
(``gmail``, ``slack``, ``helpdesk``); a native one is Flowpad's own chat, ``flowpad``. What a
surface needs to know about a channel — its title and glyph, whether rows wear a chip, how a
reply is sent, whether it carries attachments or hosts a session — is a TRAIT of the channel,
so no surface branches on a channel's name or on a missing field.
"""
from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import ConfigDict

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec._types import NonBlank
from flow_sdk.schema.data_spec.spec import DataSpec


class ChannelTransport(StrEnum):
    """How a reply in a conversation leaves this machine."""

    #: Flowpad's own chat: the hub conversation (optimistic row, outbox, attachments, sessions).
    FLOWPAD = "flowpad"
    #: The DataSource the conversation was projected from, through its driver's ``send``.
    SOURCE = "source"


class ActionSpec(DataSpec):
    """One thing a person can do to a whole conversation on its channel (approve a pull request,
    close a ticket) — declared by the driver (``Acting.actions``), drawn by the surface, run through
    ``POST /graph/conversation/<id>/act``."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "channel.action"

    #: What ``act`` is called with; unique within the channel.
    id: NonBlank
    label: str
    #: A lucide icon name; empty when the action declares none.
    icon_name: str = ""
    #: A question the surface asks before running it; empty runs at once.
    confirm: str = ""
    #: The action carries the person's text (a review comment) as ``act``'s ``text``.
    needs_text: bool = False
    #: Drawn as a destructive action (closes, rejects).
    destructive: bool = False
    #: Which conversations offer it: an open one (approve), an ended one (reopen), or ``any``.
    when: Literal["open", "ended", "any"] = "open"
    #: The ``MessageMarkSpec.key`` that says it is done: when the newest message the signed-in account
    #: sent carries it, the surface draws the action as done instead of a button. Empty: never done.
    done_mark: str = ""


class ChannelSpec(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "conversation.channel"

    name: str
    title: str
    #: A lucide icon name; empty when the channel declares none.
    icon_name: str = ""
    #: Whether a row in this channel wears a source chip. Flowpad's own chat does not.
    chip: bool = True
    #: The channel a conversation is born with; a source channel that later claims the
    #: conversation replaces it (``Conversation.adopt_channel``), never the reverse.
    home: bool = False
    transport: ChannelTransport = ChannelTransport.SOURCE
    accepts_attachments: bool = False
    #: A person can answer ONE message here (the surface offers Reply). ``False`` for channels that
    #: only speak (a phone line) or only record (a task ledger, a harness transcript).
    replies: bool = False
    #: A reply to one message quotes it where the recipient reads (WhatsApp, Telegram); ``False``
    #: means it only lands in that message's thread (email, Slack) — the surface says "Reply in thread".
    quotes: bool = False
    #: People can put an emoji on a message, and so can we.
    reacts: bool = False
    needs_cloud_login: bool = False
    hosts_sessions: bool = False
    #: What a person can do to the whole conversation here (``Acting.actions``); empty when nothing.
    actions: list[ActionSpec] = []


__all__ = ["ActionSpec", "ChannelSpec", "ChannelTransport"]
