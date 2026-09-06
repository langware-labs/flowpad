"""An empty allowlist admits nobody — unless the driver says strangers are the point."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.email_inbox import EmailInbox
from flow_sdk.inbox.agent_runner import _admits

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


def _source(provider: str, *, status="active", allowed=()):
    src = DataSource(name="s", provider=provider, channel=provider, status=status,
                     config={"agent_id": "agent-1", "desk_project_id": "desk-1"},
                     inbound_allowed_senders=list(allowed))
    return src, EmailInbox.from_source(src)


def test_a_help_desk_answers_everyone_when_nobody_is_listed():
    assert _admits(*_source("helpdesk"), "stranger-1") is True


def test_a_listed_desk_still_restricts():
    assert _admits(*_source("helpdesk", allowed=["friend"]), "stranger-1") is False
    assert _admits(*_source("helpdesk", allowed=["friend"]), "friend") is True


def test_a_paused_desk_admits_nobody():
    assert _admits(*_source("helpdesk", status="disabled"), "stranger-1") is False


def test_email_keeps_its_closed_default():
    assert _admits(*_source("cloud_email"), "stranger@example.com") is False
