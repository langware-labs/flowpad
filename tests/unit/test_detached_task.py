"""A detached task never inherits the request or DB session that started it.

``asyncio.create_task`` copies the caller's contextvars, so a task that
outlives a request kept its transaction handler and the sqlite driver's
"already in a session" marker — and wrote into a session that had been closed.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar

import pytest

from flow_sdk.db.drivers.sqlite.sqlite_driver import _standalone_session_var
from flow_sdk.request_context import detached
from flow_sdk.request_context.execution_context import execution_context_var

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_plain: ContextVar[str | None] = ContextVar("plain_value", default=None)


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
