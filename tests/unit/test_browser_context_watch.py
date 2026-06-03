"""Unit tests for ``BrowserContextWatch`` — the pure refcount/diff logic that
turns per-connection browser context into hub watch/unwatch calls.

Network is stubbed: ``_hub_call`` records (action, key) instead of POSTing, and
``_remote_keys`` is stubbed to treat the passed context's ``keys`` list as the
already-classified remote key set (so these tests exercise the diff/refcount
contract without DB or auth). Two tests at the end cover the real
``_remote_keys`` gating (logged-out / null values) cheaply.
"""
from __future__ import annotations

import pytest

from flow_sdk.cloud_client.context_watch import BrowserContextWatch


def _make():
    bcw = BrowserContextWatch()
    calls: list[tuple[str, str]] = []

    async def fake_hub_call(key: str, action: str) -> None:
        calls.append((action, key))

    async def fake_remote_keys(context: dict) -> set[str]:
        return set(context.get("keys", []))

    bcw._hub_call = fake_hub_call  # type: ignore[assignment]
    bcw._remote_keys = fake_remote_keys  # type: ignore[assignment]
    return bcw, calls


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_first_add_watches_then_idempotent():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a"]})
    assert calls == [("watch", "conversation:a")]
    # identical context → no new hub call
    await bcw.on_context("c1", {"keys": ["conversation:a"]})
    assert calls == [("watch", "conversation:a")]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_remove_unwatches_on_last_drop():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a"]})
    await bcw.on_context("c1", {"keys": []})
    assert calls == [("watch", "conversation:a"), ("unwatch", "conversation:a")]
    assert bcw._refcount == {}
    assert "c1" not in bcw._per_conn


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_multi_connection_dedup():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a"]})
    await bcw.on_context("c2", {"keys": ["conversation:a"]})  # 2nd holder → no new watch
    assert calls == [("watch", "conversation:a")]
    await bcw.on_context("c1", {"keys": []})  # c1 drops, c2 still holds → no unwatch
    assert calls == [("watch", "conversation:a")]
    await bcw.on_context("c2", {"keys": []})  # last drop → unwatch
    assert calls == [("watch", "conversation:a"), ("unwatch", "conversation:a")]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_swap_active_entity_watches_new_unwatches_old():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a"]})
    await bcw.on_context("c1", {"keys": ["conversation:b"]})
    assert calls == [
        ("watch", "conversation:a"),
        ("watch", "conversation:b"),
        ("unwatch", "conversation:a"),
    ]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_disconnect_unwatches_held_entities():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a", "conversation:b"]})
    await bcw.on_disconnect("c1")
    assert ("unwatch", "conversation:a") in calls
    assert ("unwatch", "conversation:b") in calls
    assert bcw._refcount == {}
    assert bcw._per_conn == {}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_disconnect_respects_other_holders():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a"]})
    await bcw.on_context("c2", {"keys": ["conversation:a"]})
    await bcw.on_disconnect("c1")
    assert calls == [("watch", "conversation:a")]  # c2 still holds → no unwatch
    assert bcw._refcount == {"conversation:a": 1}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_resync_reissues_active_watches():
    bcw, calls = _make()
    await bcw.on_context("c1", {"keys": ["conversation:a", "conversation:b"]})
    calls.clear()
    await bcw.resync()
    assert sorted(calls) == [("watch", "conversation:a"), ("watch", "conversation:b")]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_remote_keys_empty_when_logged_out(monkeypatch):
    bcw = BrowserContextWatch()
    import flow_sdk.cli.auth.hub_login as hl

    monkeypatch.setattr(hl, "is_logged_in", lambda: False)
    # Logged out → no watches regardless of context content.
    assert await bcw._remote_keys({"CurrentActiveEntityTypeId": "conversation-x"}) == set()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_remote_keys_skips_null_and_nonstring(monkeypatch):
    bcw = BrowserContextWatch()
    import flow_sdk.cli.auth.hub_login as hl

    monkeypatch.setattr(hl, "is_logged_in", lambda: True)
    # Null / non-string / empty slots resolve to nothing (no DB hit, empty set).
    assert await bcw._remote_keys({"a": None, "b": 123, "c": ""}) == set()
