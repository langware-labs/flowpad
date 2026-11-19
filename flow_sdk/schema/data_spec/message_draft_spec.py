"""``MessageDraftOptions`` — what a draft message remembers beyond the message itself.

A draft is a whole ``FlowMessage`` in ``DeliveryStatus.DRAFT``: its text, files, quote and thread
sit in the message's own fields. These are the two things that are not message content — which
composer it belongs to, and the choices its send will act on. Cleared when it is sent.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.schema.data_spec.spec import DataSpec


class MessageDraftOptions(DataSpec):
    #: The ``MessageThread`` whose composer this is typed in; None = the conversation's own composer.
    thread_id: Optional[str] = None
    #: The composer's prompt box is open; a prompt typed there is sent as a prompt call the
    #: receiver approves and runs.
    call: bool = False
    #: That prompt, typed in its own box beside the message text. None on a draft stored before the
    #: prompt had a box of its own: there the draft's text IS the prompt.
    call_prompt: Optional[str] = None
    #: Make the sent message a task as well.
    task: bool = False
    #: A private message: shown in the conversation to this machine's user only, as a message and not
    #: as something being typed, until it is shared (sent) or dismissed.
    private: bool = False
