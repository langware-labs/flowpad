"""``MessageState`` — one stream inbox message, as a value a decision is asked about and an agent is given.

The ONE shape that serves both halves of a stream stream inbox automation: it is the ``state`` a
decision op's questions refer to by name (``text``, ``subject``, ``sender``), and the
``input`` the agent step mounts. Built from a ``FlowMessage`` by the stream inbox (which
knows how a message's body is hydrated) and from bare text for a fast test; never stored —
a run keeps the message's id and rebuilds this when asked.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec.spec import DataSpec

#: The head of a body a decision reads. A cut is marked; the agent gets the whole message
#: through the conversation anyway.
TEXT_MAX_CHARS = 4000


class MessageState(DataSpec):
    spec_kind: ClassVar[str] = "stream_inbox.message.state"

    #: The channel the message came on (``gmail``, ``whatsapp``), as the source names it.
    channel: str = ""
    #: Who sent it, as a person would say it: a name and an address when there is one.
    sender: str = ""
    subject: str = ""
    #: The body's head (``TEXT_MAX_CHARS``); ``text_cut`` says how much more there was.
    text: str = ""
    text_cut: int = 0
    received_at: Optional[str] = None
    #: The row ids a run links to. Empty for a state built from bare text.
    conversation_id: str = ""
    message_id: str = ""
    #: The message's key on its channel (``origin.key``) — what the channel's own status notices name.
    origin_key: str = ""
    #: The names of the files the message carried.
    files: list[str] = []

    @classmethod
    def from_text(cls, text: str) -> "MessageState":
        """A state with no row behind it — what a fast test types in."""
        head, cut = message_head(text)
        return cls(text=head, text_cut=cut)


def message_head(text: str) -> tuple[str, int]:
    """The body's head (``TEXT_MAX_CHARS``) and how much was cut — the one truncation rule."""
    text = text or ""
    if len(text) <= TEXT_MAX_CHARS:
        return text, 0
    return text[:TEXT_MAX_CHARS], len(text) - TEXT_MAX_CHARS
