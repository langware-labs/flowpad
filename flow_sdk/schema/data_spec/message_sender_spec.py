"""``MessageSender`` — who wrote a message, as a typed value instead of a string to parse.

A message's author is one of three things, and consumers need to tell them apart: a person using
Flowpad (a local or cloud user id), an Agent speaking through a channel it holds, or somebody out
there on a channel (an address or handle). ``FlowMessage.sender_id`` carried all three in one
string (``<uuid>`` / ``agent:<id>`` / ``<channel>:<address>``), so every reader re-parsed it.
``MessageSender`` is the typed form; the string grammar lives ONLY in ``from_wire`` / ``wire_id``,
because ``sender_id`` is still what travels to the hub and in share bundles.

Local only: ``FlowMessage.sender`` is PRIVATE — a hub-native message's author is always a person.
"""
from __future__ import annotations

from typing import ClassVar, Collection, Optional

from pydantic import ConfigDict

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class SenderKind(StrEnum):
    #: A person using Flowpad — ``id`` is their local or cloud user id.
    USER = "user"
    #: An Agent speaking through a channel it holds — ``id`` is the Agent's id.
    AGENT = "agent"
    #: Somebody on a channel — ``channel`` and ``address`` (empty when the provider named nobody).
    EXTERNAL = "external"


#: The wire prefix of an Agent sender. Not a bare id: a sender id is compared against user ids,
#: and an agent that looked like one would be indistinguishable from a person.
_AGENT_PREFIX = "agent"
#: The address an EXTERNAL sender carries on the wire when the provider named nobody.
_UNKNOWN = "unknown"


class MessageSender(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "message.sender"

    kind: SenderKind
    id: str = ""
    channel: str = ""
    address: str = ""

    @classmethod
    def user(cls, user_id: str) -> "MessageSender":
        return cls(kind=SenderKind.USER, id=str(user_id))

    @classmethod
    def agent(cls, agent_id: str) -> "MessageSender":
        return cls(kind=SenderKind.AGENT, id=str(agent_id))

    @classmethod
    def external(cls, channel: str, address: str = "") -> "MessageSender":
        return cls(kind=SenderKind.EXTERNAL, channel=channel, address=address)

    @classmethod
    def from_wire(cls, sender_id: Optional[str]) -> Optional["MessageSender"]:
        """The typed sender a ``sender_id`` string names, or None when it names nobody."""
        text = str(sender_id or "").strip()
        if not text:
            return None
        head, sep, tail = text.partition(":")
        if not sep:
            return cls.user(text)
        if head == _AGENT_PREFIX:
            return cls.agent(tail)
        return cls.external(head, "" if tail == _UNKNOWN else tail)

    @property
    def wire_id(self) -> str:
        """The ``sender_id`` string this sender travels as."""
        if self.kind is SenderKind.AGENT:
            return f"{_AGENT_PREFIX}:{self.id}"
        if self.kind is SenderKind.EXTERNAL:
            return f"{self.channel}:{self.address or _UNKNOWN}"
        return self.id

    def authored_by(self, self_ids: Collection[str]) -> bool:
        """Whether this machine wrote the message: one of our user ids, or an Agent we host.

        An Agent sender is always ours — only an agent-owned source on this machine stamps one.
        """
        if self.kind is SenderKind.AGENT:
            return True
        return self.kind is SenderKind.USER and self.id in self_ids


__all__ = ["MessageSender", "SenderKind"]
