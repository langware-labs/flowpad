"""A detached task never inherits the request or DB session that started it.

``asyncio.create_task`` copies the caller's contextvars, so a task that
outlives a request kept its transaction handler and the sqlite driver's
"already in a session" marker — and wrote into a session that had been closed.

The second half: a done-callback is ALSO stored with a copy of the caller's
context, so a callback registered inside a request pins that request (its body,
its user, its target entity) for as long as the task runs — minutes for a setup
run, the life of the server for a watch loop. The helper and its callers must
register theirs under the detached context.
"""
from __future__ import annotations

import asyncio
import gc
import weakref
from contextvars import ContextVar
from typing import Any, Callable

import pytest

from flow_sdk.db.drivers.sqlite.sqlite_driver import _standalone_session_var
from flow_sdk.request_context import detached
from flow_sdk.request_context.execution_context import execution_context_var

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_plain: ContextVar[str | None] = ContextVar("plain_value", default=None)


class _Request:
    """Stands in for an ``ExecutionContext``: anything the request var can hold."""


async def _in_a_request(spawn: Callable[[], Any]) -> tuple[Any, "weakref.ref[_Request]"]:
    """Run ``spawn`` the way a handler runs under uvicorn: in its own task, with the
    request set for the duration, and reset in ``finally`` as the middleware does."""

    async def handler() -> tuple[Any, "weakref.ref[_Request]"]:
        request = _Request()
        token = execution_context_var.set(request)
        try:
            spawned = spawn()
            if asyncio.iscoroutine(spawned):
                spawned = await spawned
        finally:
            execution_context_var.reset(token)
        return spawned, weakref.ref(request)

    return await asyncio.create_task(handler())


def _pinning_callbacks(task: asyncio.Task) -> list[str]:
    """Names of the done-callbacks whose stored context still holds a request."""
    return [
        getattr(cb, "__qualname__", repr(cb))
        for cb, ctx in (getattr(task, "_callbacks", None) or [])
        if ctx.get(execution_context_var) is not None
    ]


@pytest.mark.asyncio
async def test_a_detached_task_clears_only_the_request_and_session_scopes():
    seen: dict[str, object] = {}

    async def body() -> None:
        seen["request"] = execution_context_var.get()
        seen["session"] = _standalone_session_var.get()
        seen["plain"] = _plain.get()

    request_token = execution_context_var.set(object())
    session_token = _standalone_session_var.set(object())
    plain_token = _plain.set("inherited")
    try:
        task = detached.create_detached_task(body(), name="detached-probe")
        assert task in detached._DETACHED, "held until it finishes"
        # The caller's own scope is untouched.
        assert execution_context_var.get() is not None
        assert _standalone_session_var.get() is not None
    finally:
        _plain.reset(plain_token)
        _standalone_session_var.reset(session_token)
        execution_context_var.reset(request_token)

    await task
    assert seen == {"request": None, "session": None, "plain": "inherited"}
    await asyncio.sleep(0)
    assert task not in detached._DETACHED


@pytest.mark.asyncio
async def test_a_detached_task_does_not_hold_the_request_that_started_it():
    gate = asyncio.Event()

    async def body() -> None:
        await gate.wait()

    task, request_ref = await _in_a_request(lambda: detached.create_detached_task(body(), name="probe"))
    gc.collect()
    assert not task.done()
    assert _pinning_callbacks(task) == []
    assert request_ref() is None, "the done-callback's context pins the request while the task runs"

    gate.set()
    await task


@pytest.mark.asyncio
async def test_add_detached_done_callback_does_not_hold_the_request():
    gate = asyncio.Event()
    done: set[asyncio.Task] = set()

    async def body() -> None:
        await gate.wait()

    def spawn() -> asyncio.Task:
        task = detached.create_detached_task(body(), name="probe")
        done.add(task)
        detached.add_detached_done_callback(task, done.discard)
        return task

    task, request_ref = await _in_a_request(spawn)
    gc.collect()
    assert _pinning_callbacks(task) == []
    assert request_ref() is None

    gate.set()
    await task
    await asyncio.sleep(0)
    assert task not in done, "the callback itself still runs"


@pytest.mark.asyncio
async def test_the_task_runtime_handler_does_not_hold_the_request(monkeypatch):
    """``tasks/runtime.py``'s bus handler adds its own ``_INFLIGHT`` callback — through the helper."""
    from flow_sdk.ingest import bus_sources
    from flow_sdk.tasks import runtime

    captured: dict[str, Any] = {}
    monkeypatch.setattr("flow_sdk.tags.on_tag", lambda pattern, handler: (captured.setdefault("on", handler), lambda: None)[1])
    monkeypatch.setattr(bus_sources, "start", lambda: None)
    gate = asyncio.Event()

    async def _safely(_data: dict) -> None:
        await gate.wait()

    monkeypatch.setattr(runtime, "_safely", _safely)
    monkeypatch.setattr(runtime, "_UNSUBSCRIBE", [])
    monkeypatch.setattr(runtime, "_INFLIGHT", set())
    runtime.start(watchdog=False)

    class _Event:
        data = {"event": "created", "task_id": "t"}
        tag = "task.created"

    async def spawn() -> asyncio.Task:
        await captured["on"](_Event())
        return next(iter(runtime._INFLIGHT))

    task, request_ref = await _in_a_request(spawn)
    gc.collect()
    assert _pinning_callbacks(task) == []
    assert request_ref() is None

    gate.set()
    await task
    await asyncio.sleep(0)
    assert runtime._INFLIGHT == set()


@pytest.mark.asyncio
async def test_a_file_watch_loop_does_not_hold_the_request(tmp_path):
    """The fs ``watch`` action's loop lives as long as the folder has a watcher."""
    from flow_sdk.actions.fs import file_watch

    local = str(tmp_path / "a.txt")
    (tmp_path / "a.txt").write_text("x")
    folder = str(tmp_path)

    loop_task, request_ref = await _in_a_request(
        lambda: (file_watch.watch_file("conn-1", local, "entity", local), file_watch._loops[folder])[1]
    )
    try:
        gc.collect()
        assert not loop_task.done()
        assert _pinning_callbacks(loop_task) == []
        assert request_ref() is None
    finally:
        file_watch.unwatch_file("conn-1", local, "entity", local)
        await asyncio.gather(loop_task, return_exceptions=True)
    assert folder not in file_watch._loops
