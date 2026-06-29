"""Step 3: trigger_callbacks registry — decorator + lookup for in-process handlers."""
from __future__ import annotations

import pytest

from flow_sdk.builtin import trigger_callbacks


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _isolate_registry():
    """Each test gets a clean registry."""
    # snapshot + restore so we don't leak names across tests
    snapshot = dict(trigger_callbacks._handlers)
    trigger_callbacks._handlers.clear()
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


def test_register_decorator_stores_handler():
    @trigger_callbacks.register("h1")
    async def my_handler(*args, **kw):
        pass

    assert "h1" in trigger_callbacks._handlers


def test_register_with_meaning():
    @trigger_callbacks.register("h2", meaning="reload toplog config")
    async def my_handler(*args, **kw):
        pass

    listed = trigger_callbacks.list_registered()
    entry = next(e for e in listed if e["name"] == "h2")
    assert entry["meaning"] == "reload toplog config"


def test_get_returns_registered():
    @trigger_callbacks.register("h3")
    async def cb(*args, **kw):
        return "ok"

    fn = trigger_callbacks.get("h3")
    assert fn is cb


def test_get_returns_none_for_unknown():
    assert trigger_callbacks.get("does_not_exist") is None


def test_re_register_replaces():
    @trigger_callbacks.register("h4")
    async def first(*a, **kw):
        return "first"

    @trigger_callbacks.register("h4")
    async def second(*a, **kw):
        return "second"

    assert trigger_callbacks.get("h4") is second
    assert trigger_callbacks.get("h4") is not first


def test_async_handler_supported():
    @trigger_callbacks.register("h5")
    async def async_cb(*args, **kw):
        return "async"

    listed = trigger_callbacks.list_registered()
    entry = next(e for e in listed if e["name"] == "h5")
    assert entry["is_async"] is True


def test_sync_handler_supported():
    @trigger_callbacks.register("h6")
    def sync_cb(*args, **kw):
        return "sync"

    listed = trigger_callbacks.list_registered()
    entry = next(e for e in listed if e["name"] == "h6")
    assert entry["is_async"] is False


def test_list_registered_empty():
    assert trigger_callbacks.list_registered() == []


def test_list_registered_shape():
    @trigger_callbacks.register("h7", meaning="m7")
    async def cb(*a, **kw):
        pass

    listed = trigger_callbacks.list_registered()
    assert len(listed) == 1
    entry = listed[0]
    assert set(entry.keys()) == {"name", "meaning", "is_async"}


def test_register_returns_the_decorated_function():
    """Decorator must return the function unchanged so callers can still invoke it directly."""

    async def fn(*a, **kw):
        return 42

    wrapped = trigger_callbacks.register("h8")(fn)
    assert wrapped is fn


def test_register_meaning_defaults_to_none():
    @trigger_callbacks.register("h9")
    async def cb(*a, **kw):
        pass

    listed = trigger_callbacks.list_registered()
    entry = next(e for e in listed if e["name"] == "h9")
    assert entry["meaning"] is None
