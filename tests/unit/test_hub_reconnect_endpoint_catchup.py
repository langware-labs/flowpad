"""A reconnect re-reads what the hub may have announced while the socket was down.

The hub announces each change exactly once and never replays. For conversations that
loses a message; for LLM endpoints it leaves state that is ACTED on -- a box that missed a
delete goes on pointing every spawn at a row the hub answers ``Entity ... not found`` for,
and keeps doing it, because a bound endpoint outranks an unproven device login.

It is also what lets the resolver's own staleness check work: that check refuses to read an
absence as an answer unless the listing is NEWER than the binding, and on a fresh process
there is no listing at all.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from flow_sdk.cloud_client.ws_client import _catch_up_after_reconnect


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "reconnectcatchup")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.reset_cache()
    reset_instance_settings()


async def test_a_reconnect_rereads_the_endpoint_listing(env, monkeypatch) -> None:
    calls: list[int] = []

    async def _fetch(*_a, **_k):
        calls.append(1)
        return []

    monkeypatch.setattr("flow_sdk.instance_settings.llm_endpoint.fetch_hub_llm_endpoints", _fetch)
    await _catch_up_after_reconnect()
    assert calls, "a reconnect did not re-read what this box may spend"


async def test_the_endpoint_catchup_still_runs_when_the_conversation_catchup_fails(env, monkeypatch) -> None:
    """Guarded separately on purpose. Sharing one ``try`` meant a conversation-sync hiccup --
    the far more frequent of the two -- silently skipped the endpoint re-read, which is the
    half that leaves a box spending a budget that no longer exists."""
    calls: list[int] = []

    async def _boom(*_a, **_k):
        raise RuntimeError("conversation sync is down")

    async def _fetch(*_a, **_k):
        calls.append(1)
        return []

    monkeypatch.setattr("flow_sdk.builtin.user.User.get_local", _boom)
    monkeypatch.setattr("flow_sdk.instance_settings.llm_endpoint.fetch_hub_llm_endpoints", _fetch)

    await _catch_up_after_reconnect()  # must not raise
    assert calls, "a conversation-sync failure swallowed the endpoint re-read"


async def test_a_failing_endpoint_reread_does_not_raise(env, monkeypatch) -> None:
    """The connection has just come back; a catch-up hiccup must never take it down again."""

    async def _boom(*_a, **_k):
        raise RuntimeError("hub unreachable")

    monkeypatch.setattr("flow_sdk.instance_settings.llm_endpoint.fetch_hub_llm_endpoints", _boom)
    await _catch_up_after_reconnect()
