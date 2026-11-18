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
    #: Send the text as a prompt call the receiver approves and runs, not as the body.
    call: bool = False
    #: Make the sent message a task as well.
    task: bool = False
