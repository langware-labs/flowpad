"""A live call on a channel, as the values the runtime speaks — whatever carries the audio.

A call is a conversation that happens in real time: a person speaks, a voice model answers, and
anything that needs the agent's knowledge or tools is **delegated** to the agent as an ordinary
turn. Three values, and nothing about audio frames — the provider carries the audio; we hold the
call's events:

* ``IncomingCall`` — a call a source has on the line: who is calling, which of our addresses they
  reached, and (for a call WE placed) what it is for.
* ``CallEvent`` — one thing that happened on it: the caller finished a sentence (``heard``), the voice
  said one (``said``), the caller is mid-sentence (``partial``), the voice asks the agent
  (``delegate``), the line closed (``ended``).
* ``VoiceTurnData`` — a finished sentence stored as a message, so a call reads in the stream inbox
  exactly like a chat: one ``MessageData`` per sentence, the caller's and the agent's, in one thread.
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values.items import FileData, MessageData

#: What a call event says happened.
CallEventKind = Literal["heard", "said", "partial", "delegate", "ended"]


class IncomingCall(DataSpec):
    spec_kind: ClassVar[str] = "call.incoming"
    model_config = ConfigDict(frozen=True)

    #: The provider's id for this call — the key its control channel is opened by.
    call_id: str
    #: The person on the other end, as this channel addresses them (E.164, a browser user id, a file name).
    caller: str
    #: Which of OUR addresses they reached — the account a source is found by.
    dialed: str = ""
    caller_name: str = ""
    #: A call we placed: what it is for. The voice opens with it instead of waiting to be spoken to.
    brief: str = ""
    #: The call's conversation key when not its id: a call we placed keeps its dial's token, so the note
    #: that placed it and the call are one conversation.
    conversation: str = ""

    @property
    def conversation_key(self) -> str:
        return self.conversation or self.call_id


class CallEvent(DataSpec):
    spec_kind: ClassVar[str] = "call.event"
    model_config = ConfigDict(frozen=True)

    kind: CallEventKind
    text: str = ""
    #: The provider's id for the sentence — a stored sentence's natural key, so a replay is one row.
    item_id: str = ""
    #: On ``delegate``: the id the answer is returned under (``CallSession.resolve``).
    ask_id: str = ""
    #: The sentence's audio, when the channel keeps it (a sound-file call does).
    audio: Optional[FileData] = None


class VoiceTurnData(MessageData):
    """One finished sentence of a call. ``text`` is the transcript; ``attachments`` carry its audio
    when the channel keeps it."""

    spec_kind: ClassVar[str] = "ingest.message.voice"

    call_id: str = ""


__all__ = ["CallEvent", "CallEventKind", "IncomingCall", "VoiceTurnData"]
