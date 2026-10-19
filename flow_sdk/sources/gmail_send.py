"""Gmail's send-only REST transport, independent of mailbox/IMAP permission.

The caller retains account selection, OAuth refresh, consent scopes and recipient
confirmation. This module never signs in or reads a mailbox. A token granted
``gmail.send`` is sufficient; the IMAP source's broader grant is not substituted.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Sequence

from flow_sdk.sources import http
from flow_sdk.sources.errors import SourceUnavailable

SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


@dataclass(frozen=True)
class InlineImage:
    content_id: str
    content: bytes
    filename: str
    media_type: str = "image/png"


def compose_message(
    *, sender: str, to: Sequence[str], subject: str, text: str, html: str,
    cc: Sequence[str] = (), inline_images: Sequence[InlineImage] = (),
) -> EmailMessage:
    """One plain/HTML alternative, with CID images related to the HTML part."""
    if not sender or not to or any(not address for address in (*to, *cc)):
        raise ValueError("a sender and nonempty recipient addresses are required")
    message = EmailMessage()
    message["Subject"], message["From"], message["To"] = subject, sender, ", ".join(to)
    if cc:
        message["Cc"] = ", ".join(cc)
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    seen = set()
    for image in inline_images:
        cid = image.content_id.strip("<>")
        if not cid or cid in seen or f"cid:{cid}" not in html:
            raise ValueError("inline images need unique content IDs referenced by the HTML")
        kind, separator, subtype = image.media_type.partition("/")
        if kind != "image" or not separator or not subtype:
            raise ValueError("an inline image needs an image media type")
        seen.add(cid)
        message.get_payload()[1].add_related(
            image.content, kind, subtype, cid=f"<{cid}>", filename=image.filename,
        )
    return message


def raw_message(message: EmailMessage) -> dict[str, str]:
    """Gmail REST wire body; MIME headers carry the selected recipients."""
    return {"raw": base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")}


async def send_message(access_token: str, message: EmailMessage, *, approved: bool = False) -> dict:
    """Send once after caller confirmation; never retry an ambiguous send."""
    if not approved:
        raise PermissionError("Gmail sending requires recipient confirmation")
    if not access_token:
        raise ValueError("a send-authorized Google access token is required")
    async with http.client() as client:
        answer = await http.request_json(client, "POST", SEND_URL,
            headers={"Authorization": f"Bearer {access_token}"}, json=raw_message(message))
    if not isinstance(answer, dict) or not answer.get("id"):
        raise SourceUnavailable("Gmail answered the send without a message id; do not resend automatically")
    return answer
