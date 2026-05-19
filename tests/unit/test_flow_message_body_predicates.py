"""Unit tests for FlowMessage.has_body() truth table and attachments().

These are pure-function tests — no DB, no hub, no bundle pack. They lock the
contract so the hub-side body_status state machine (Phase B) has a single,
unambiguous source of truth for "does this message need a body upload?".

# do not increase timeout without approval
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    FILE_VFS_PREFIX,
    FlowMessage,
    PROMPT_FILE_VFS_PREFIX,
)


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.parametrize(
    "attachments, expected",
    [
        pytest.param([], False, id="text-only"),
        pytest.param(
            [Attachment(attachment_type=AttachmentType.URL, data="https://example.com")],
            False,
            id="url-only",
        ),
        pytest.param(
            [Attachment(attachment_type=AttachmentType.REPO, data="/Users/x/repo")],
            False,
            id="repo-only",
        ),
        pytest.param(
            [Attachment(attachment_type=AttachmentType.PROMPT, data="inline prompt text")],
            False,
            id="inline-prompt",
        ),
        pytest.param(
            [Attachment(attachment_type=AttachmentType.FILE, data=f"{FILE_VFS_PREFIX}foo.txt")],
            True,
            id="file",
        ),
        pytest.param(
            [Attachment(attachment_type=AttachmentType.PROMPT, data=f"{PROMPT_FILE_VFS_PREFIX}p.md")],
            True,
            id="prompt-with-file",
        ),
        pytest.param(
            [Attachment(attachment_type=AttachmentType.TYPE_ID, data="skill-abc")],
            True,
            id="type_id-skill",
        ),
        pytest.param(
            [
                Attachment(attachment_type=AttachmentType.URL, data="https://x"),
                Attachment(attachment_type=AttachmentType.FILE, data="data/a.bin"),
            ],
            True,
            id="mixed-includes-file",
        ),
    ],
)
def test_has_body_truth_table(attachments, expected):
    fm = FlowMessage(text="t", attachment=attachments)
    assert fm.has_body() is expected


def test_attachments_returns_underlying_list():
    """attachments() returns the same list object stored on the FM (no copy).

    Pydantic validates and stores the list internally; attachments() must
    return that internal reference, not a defensive copy. The contract is:
    appending to attachments() is reflected on self.attachment.
    """
    atts = [Attachment(attachment_type=AttachmentType.URL, data="https://x")]
    fm = FlowMessage(text="t", attachment=atts)
    got = fm.attachments()
    assert got is fm.attachment
    got.append(Attachment(attachment_type=AttachmentType.URL, data="https://y"))
    assert len(fm.attachment) == 2


def test_attachments_empty_when_none():
    """An FM constructed without attachments has attachments() == []."""
    fm = FlowMessage(text="t")
    out = fm.attachments()
    assert out == []
