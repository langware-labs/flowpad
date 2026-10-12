"""An empty allowlist admits nobody — unless the driver says strangers are the point."""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.agent_serve import admits as _admits

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


def _source(provider: str, *, status="active", allowed=()):
    """A desk source carries NO agent_id — the gate must not need one."""
    config = {"agent_id": "agent-1"} if provider == "cloud_email" else {"desk_project_id": "desk-1"}
    return DataSource(name=f"s {uuid.uuid4().hex[:8]}", provider=provider, channel=provider, status=status, config=config,
                      allowed_senders=list(allowed))


def test_a_help_desk_answers_everyone_when_nobody_is_listed():
    assert _admits(_source("helpdesk"), "stranger-1") is True


def test_a_listed_desk_still_restricts():
    assert _admits(_source("helpdesk", allowed=["friend"]), "stranger-1") is False
    assert _admits(_source("helpdesk", allowed=["friend"]), "friend") is True


def test_a_paused_desk_admits_nobody():
    assert _admits(_source("helpdesk", status="disabled"), "stranger-1") is False


def test_email_keeps_its_closed_default():
    assert _admits(_source("cloud_email"), "stranger@example.com") is False
    assert _admits(_source("cloud_email", allowed=["Friend@Example.com"]), "friend@example.com ") is True


def test_explicit_public_access_overrides_list_but_not_pause_and_refreshes_runtime():
    from flow_sdk.builtin.agent_serve import serving_key

    source = _source("cloud_email", allowed=["friend@example.com"])
    restricted = serving_key(source)
    source.open_to_all = True
    assert _admits(source, "stranger@example.com")
    assert serving_key(source) != restricted
    source.status = "disabled"
    assert not _admits(source, "stranger@example.com")
    source.status = "active"
    source.open_to_all = False
    assert not _admits(source, "stranger@example.com")
    assert _admits(source, "friend@example.com")
    assert serving_key(source) == restricted
