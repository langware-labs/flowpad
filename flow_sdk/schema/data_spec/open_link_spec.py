"""The deep link an ``open`` resolver hands the desktop UI.

``GET <type>/<id>/open`` asks the type's ``resolve_open`` where the link goes;
the answer is one of these, and ``deep_link_redirect`` turns it into the
``/dock/home?action=open&…`` URL that ``IncomingDeepLink`` reads.
"""

from __future__ import annotations

from typing import Literal, Optional

from flow_sdk.schema.data_spec.spec import DataSpec


class OpenLinkSpec(DataSpec):
    """An ``action=open`` deep link: land in a message's conversation, or its
    task's flow."""

    action: Literal["open"] = "open"
    #: The message id, kept for traceability and as the UI's fallback.
    fm: str
    conversation_id: Optional[str] = None
    task_id: Optional[str] = None
    #: Shown while the UI opens it (a dialog title, a loading line).
    title: Optional[str] = None
    #: Who sent it, for "X shared … with you".
    sender_name: Optional[str] = None
    #: A ``GitOrigin`` as JSON: the repo the UI clones or pulls before opening.
    git_origin: Optional[str] = None

    def to_query(self) -> dict[str, str]:
        """The URL params: unset and empty fields are left out."""
        return {k: v for k, v in self.model_dump(exclude_none=True).items() if v != ""}
