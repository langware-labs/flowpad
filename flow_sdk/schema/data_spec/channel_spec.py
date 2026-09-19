"""``ChannelSpec`` — what a conversation's channel is, declared once and read everywhere.

Every conversation has a channel. A source-backed one replies through its ``DataSource``
(``gmail``, ``slack``, ``helpdesk``); a native one is Flowpad's own chat, ``flowpad``. What a
surface needs to know about a channel — its title and glyph, whether rows wear a chip, how a
reply is sent, whether it carries attachments or hosts a session — is a TRAIT of the channel,
so no surface branches on a channel's name or on a missing field.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class ChannelTransport(StrEnum):
    """How a reply in a conversation leaves this machine."""

    #: Flowpad's own chat: the hub conversation (optimistic row, outbox, attachments, sessions).
    FLOWPAD = "flowpad"
    #: The DataSource the conversation was projected from, through its driver's ``send``.
    SOURCE = "source"


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
    needs_cloud_login: bool = False
    hosts_sessions: bool = False


__all__ = ["ChannelSpec", "ChannelTransport"]
