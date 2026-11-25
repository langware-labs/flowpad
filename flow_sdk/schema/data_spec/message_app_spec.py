"""``MessageAppSpec`` -- what an app message says before its app is opened.

An app message carries a nano-app (``app.html``, ``flow_sdk/schema/data_spec/nano_app_spec.py``) and the value it
opens on. The conversation draws the app's ``block`` slot in the bubble; a list row cannot afford a frame per
row, so the app's ``header`` slot is rendered once, when the message is posted, and kept here as text.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec.automation_spec import AutomationResultStatus
from flow_sdk.schema.data_spec.spec import DataSpec


class MessageAppSpec(DataSpec):
    spec_kind: ClassVar[str] = "message.app"

    #: Where the work stands, in the words an automation's result uses; drawn as a chip. None = no chip.
    status: Optional[AutomationResultStatus] = None
    #: The app's header slot, rendered: one line of text.
    header: str = ""
