"""Unit tests for ``FlowMessage.summary()`` — the pure one-line renderer the
``flow conversation summary`` command joins per message. No DB / no I/O.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    DeliveryStatus,
    FlowMessage,
)


def _fm(**kw) -> FlowMessage:
    base = {"text": "hello", "conversation_id": "conv-1", "sender_name": "Alice"}
    base.update(kw)
    fm = FlowMessage.model_validate(base)
    fm.id = "msg-1"
    return fm


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_summary_basic_line():
    fm = _fm(text="hello world")
    assert fm.summary() == "[created] Alice: hello world"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_summary_uses_delivery_status_and_sender_fallback():
    fm = _fm(sender_name=None, sender_id="u-9", delivery_status=DeliveryStatus.PENDING_SEND.value)
    assert fm.summary().startswith("[pending_send] u-9: ")
    fm2 = _fm(sender_name=None, sender_id=None)
    assert fm2.summary().startswith("[created] unknown: ")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_summary_collapses_whitespace_and_truncates_long_text():
    fm = _fm(text="line one\n   line   two")
    assert "line one line two" in fm.summary()
    long = "x" * 200
    out = _fm(text=long).summary()
    assert out.endswith("...")
    assert len(out.split(": ", 1)[1]) == 80  # 77 chars + "..."


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_summary_counts_only_meaningful_attachments():
    # Two structural self-pointers (conversation / flow_message) + one real file.
    fm = _fm(
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data="conversation-conv-1"),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data="flow_message-msg-1"),
            Attachment(attachment_type=AttachmentType.FILE, data="data/report.md"),
        ]
    )
    assert fm.summary().endswith("(+1 attachment)")

    fm_two = _fm(
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data="conversation-conv-1"),
            Attachment(attachment_type=AttachmentType.FILE, data="data/a.txt"),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data="skill-abc"),
        ]
    )
    assert fm_two.summary().endswith("(+2 attachments)")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_summary_no_suffix_when_only_structural_attachments():
    fm = _fm(
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data="conversation-conv-1"),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data="flow_message-msg-1"),
        ]
    )
    assert fm.summary() == "[created] Alice: hello"
