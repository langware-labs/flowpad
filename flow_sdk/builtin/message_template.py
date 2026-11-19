"""Message templating: take a message, make a template of it, send the template as a new message.

A message lives in one conversation, and its fields say so: its id, its conversation, and the two
``type_id`` attachments that point at both. A template is the message's CONTENT with those ties
cut; a new message is a template tied to its new place. The packed body (``.flowmsg``) repeats the
same ties — ``flow_message_bundle.rehome_bundle`` re-ties it with these same two steps.

Generic and data-free: nothing here knows who sends what. Used by forwarding (``FlowMessage.
clone_for_forward``) and by any service that sends a stored message on (the hub's welcome).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any, Optional

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.spec import DataSpec

_PROMPT_FILE_PREFIX = "prompt/"


class MessageTemplate(DataSpec):
    """A message's content with nothing that ties it to a conversation."""

    text: str = ""
    instruction: Optional[str] = None
    #: Content attachments only, as stored (``attachment_type`` + ``data`` + prompt metadata).
    attachment: list[dict[str, Any]] = []
    #: References the message carries as shared context, minus its own conversation and itself.
    shared_context_entities: list[str] = []
    #: Structured extras, passed through untouched.
    metadata: Optional[dict[str, Any]] = None


def _get(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, Mapping) else getattr(obj, name, None)


def _kind(att: Any) -> str:
    raw = _get(att, "attachment_type")
    return str(getattr(raw, "value", raw) or "")


def requires_body(attachments: Iterable[Any]) -> bool:
    """True when any attachment's bytes travel in the packed body: a file, an entity (packed into
    the bundle's attachment subtree) or a prompt file. A URL or an inline prompt travels in the
    header. The one rule — ``FlowMessage.has_body`` asks it."""
    for att in attachments or ():
        kind = _kind(att)
        if kind in ("file", "type_id"):
            return True
        if kind == "prompt" and str(_get(att, "data") or "").startswith(_PROMPT_FILE_PREFIX):
            return True
    return False


def template_from(message: Any) -> MessageTemplate:
    """The content of ``message`` (a FlowMessage, its dump, or a packed header) as a template.

    Kept: text, instruction, content attachments, shared context, metadata. Cut: the references to
    the message's own conversation and to itself (its transport), and every field that belongs to
    one send — ids, sender, time, delivery/read/body state, reply/thread, forward provenance,
    live-session and invite fields.
    """
    transport = {f"conversation-{_get(message, 'conversation_id')}", f"flow_message-{_get(message, 'id')}"}
    atts = []
    for att in _get(message, "attachment") or ():
        att = dict(att.model_dump(mode="json") if hasattr(att, "model_dump") else att)
        att.pop("local_path", None)  # transient, API responses only
        if _kind(att) == "type_id" and str(att.get("data") or "") in transport:
            continue
        att["attachment_type"] = _kind(att)
        atts.append(att)
    ctx = [str(c) for c in _get(message, "shared_context_entities") or () if str(c) not in transport]
    return MessageTemplate(
        text=_get(message, "text") or "",
        instruction=_get(message, "instruction") or None,
        attachment=atts,
        shared_context_entities=ctx,
        metadata=_get(message, "metadata") or None,
    )


def instantiate(
    template: MessageTemplate,
    *,
    conversation_id: str,
    sender_id: Optional[str],
    sender_name: str,
    message_id: Optional[str] = None,
) -> dict[str, Any]:
    """The fields of a NEW message sending ``template`` into ``conversation_id``.

    A fresh id (unless the caller already holds one), the sender given, and the two transport
    attachments pointing at the new conversation and the new message, ahead of the content.
    """
    message_id = message_id or mint_uuid()
    fields: dict[str, Any] = {
        "id": message_id,
        "text": template.text,
        "instruction": template.instruction,
        "attachment": [
            {"attachment_type": "type_id", "data": f"conversation-{conversation_id}"},
            {"attachment_type": "type_id", "data": f"flow_message-{message_id}"},
            *(dict(a) for a in template.attachment),
        ],
        "shared_context_entities": [f"conversation-{conversation_id}", *template.shared_context_entities],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": conversation_id,
    }
    if template.metadata is not None:
        fields["metadata"] = dict(template.metadata)
    return fields


def pick_template(
    messages: Iterable[Mapping[str, Any]], *, author_id: str, now: datetime, min_age: timedelta
) -> Optional[Mapping[str, Any]]:
    """The template among ``messages``: the newest one ``author_id`` sent at least ``min_age`` ago.

    The age lets the author keep editing: a message only becomes the template once it has stood
    for ``min_age``. ``None`` when there is none, or when the newest one carries a body that is not
    on the server yet (``body_status`` not ``ready``) — an older message is never used in its place.
    """
    cutoff = now - min_age
    eligible = [
        m for m in messages if m.get("sender_id") == author_id and m.get("created_date") and m["created_date"] <= cutoff
    ]
    if not eligible:
        return None
    newest = max(eligible, key=lambda m: m["created_date"])
    if requires_body(newest.get("attachment") or ()) and str(newest.get("body_status") or "") != "ready":
        return None
    return newest
