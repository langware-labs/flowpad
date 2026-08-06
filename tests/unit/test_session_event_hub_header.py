"""A SESSION_EVENT message must still get its hub-side header created.

``FlowMessage.kind`` is annotated as ``FlowMessageKind`` but is not reliably
an enum at runtime: entities carry ``use_enum_values=True``
(``db_base_record``), so every *validated* kind — each explicit value, and
every load back out of the DB — is a bare ``str``. Only the untouched default
stays an enum member, because pydantic skips coercion on defaults.

``_send_conversation_message_header`` used to read ``reply_fm.kind.value``,
which meant the ONE kind a caller sets explicitly (SESSION_EVENT, emitted for
every live-session approve/decline/pause/resume/end) raised AttributeError.
The failure was swallowed as non-fatal, so the FlowMessage was never created
hub-side, the body upload that followed hit a nonexistent entity, and the hub
answered that entity-miss with a 401 — surfacing to the user as a spurious
"Cloud sign-in expired" toast while the session line was silently never
delivered (incident 2026-08-05).

These assert the header call survives BOTH runtime shapes of ``kind``.
"""

from types import SimpleNamespace

import pytest

from flow_sdk.app.actions.notification_action import _send_conversation_message_header
from flow_sdk.builtin.flow_message import FlowMessage, FlowMessageKind


def _recording_conversation() -> tuple[SimpleNamespace, list[dict]]:
    """A stand-in Conversation that records the kwargs of ``add_message``."""
    calls: list[dict] = []

    async def add_message(text, **kwargs):
        calls.append({"text": text, **kwargs})

    return SimpleNamespace(add_message=add_message), calls


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_session_event_header_reaches_hub():
    fm = FlowMessage.model_validate(
        {"text": "Gadi approved the live session", "kind": FlowMessageKind.SESSION_EVENT.value}
    )
    # Guard the premise: validation really does hand back a bare str here. If
    # this ever flips to an enum the test below stops covering the regression.
    assert isinstance(fm.kind, str) and not isinstance(fm.kind, FlowMessageKind)

    conv, calls = _recording_conversation()
    assert await _send_conversation_message_header(conv, fm) is True
    assert len(calls) == 1
    # The discriminator must survive to the hub — without it the receiver
    # renders the lifecycle line as an ordinary chat bubble.
    assert calls[0]["kind"] == FlowMessageKind.SESSION_EVENT.value


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_ordinary_message_header_sends_no_kind():
    # No explicit kind → the default is left alone → still a real enum member.
    fm = FlowMessage.model_validate({"text": "hello"})
    assert isinstance(fm.kind, FlowMessageKind)

    conv, calls = _recording_conversation()
    assert await _send_conversation_message_header(conv, fm) is True
    # USER is implicit; only SESSION_EVENT is sendable, so nothing is sent.
    assert calls[0]["kind"] is None
