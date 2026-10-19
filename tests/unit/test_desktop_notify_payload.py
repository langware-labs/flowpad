"""The generic desktop-notification payload: `level` is carried only when it says something."""

import pytest

from flow_sdk.notifications.desktop import build_desktop_payload

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def test_an_info_notification_carries_no_level():
    """Every existing caller sends info; their payloads must not change shape."""
    assert build_desktop_payload(title="t", body="b") == {"title": "t", "body": "b"}
    assert build_desktop_payload(title="t", body="b", level="info") == {"title": "t", "body": "b"}


def test_a_warning_says_so():
    """What makes the renderer keep it in the footer warnings list, not only toast it."""
    assert build_desktop_payload(title="t", body="b", level="warning")["level"] == "warning"
