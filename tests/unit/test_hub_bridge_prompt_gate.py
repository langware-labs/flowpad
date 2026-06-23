"""Unit tests for the bridge's prompt auto-run discriminator.

``_has_prompt_attachment`` is the pre-check the hub bridge uses to decide
whether an inbound FlowMessage carries a runnable prompt — and, paired with
``body_status``, whether to auto-run it now or defer until the body is READY
(the fix for the ``prompt/image.png`` relative-path bug). It must agree on both
the hub wire shape (list of dicts) and the local model shape (Attachment
instances).
"""
from flow_sdk.builtin.flow_message import Attachment, AttachmentType
from flow_sdk.cloud_client.hub_bridge import _has_prompt_attachment


def test_inline_or_file_prompt_attachment_dict():
    assert _has_prompt_attachment([{"attachment_type": "prompt", "data": "prompt/image.png"}])
    assert _has_prompt_attachment([{"attachment_type": "prompt", "data": "do the thing"}])


def test_prompt_typeid_attachment_dict():
    assert _has_prompt_attachment([
        {"attachment_type": "type_id", "data": "prompt-98c2a74c-2f5f-4d2d-b090-e2df1d8184f1"},
    ])


def test_local_attachment_model_shape():
    atts = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data="conversation-abc"),
        Attachment(attachment_type=AttachmentType.PROMPT, data="prompt/photo.jpeg"),
    ]
    assert _has_prompt_attachment(atts)


def test_no_prompt_attachment():
    assert not _has_prompt_attachment(None)
    assert not _has_prompt_attachment([])
    assert not _has_prompt_attachment([
        {"attachment_type": "type_id", "data": "conversation-abc"},
        {"attachment_type": "file", "data": "data/report.pdf"},
    ])
    # A non-prompt TYPE_ID whose id happens to contain a dash must not match.
    assert not _has_prompt_attachment([
        {"attachment_type": "type_id", "data": "markdown-1234-5678"},
    ])
