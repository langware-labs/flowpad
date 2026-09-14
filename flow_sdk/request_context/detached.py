"""Tasks that must outlive the request — or DB session — that started them.

``asyncio.create_task`` copies the CALLER's contextvars. Two of those are
scopes, not values: ``execution_context_var`` carries the request and its
transaction handler, and the sqlite driver's ``_standalone_session_var`` says
"you are already inside a session". A task that keeps running after that scope
has ended still sees them, so its writes join a transaction that was committed
and closed: the rows never land, and the orphaned write lock turns every other
writer's next attempt into ``database is locked``.

A detached task starts from a copy of the caller's context with exactly those
two scopes cleared — service config and everything else still inherit — and is
strongly referenced until it finishes, so the loop cannot collect it mid-run.
"""
from __future__ import annotations

import asyncio
import contextvars
from typing import Any, Coroutine, Optional

_DETACHED: "set[asyncio.Task[Any]]" = set()


def detached_context() -> contextvars.Context:
    """The caller's context with its request and DB-session scopes cleared."""
    from flow_sdk.request_context.execution_context import execution_context_var  # noqa: PLC0415

    context = contextvars.copy_context()
    context.run(execution_context_var.set, None)
    try:
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _standalone_session_var  # noqa: PLC0415
    except ImportError:  # pragma: no cover — a build without the sqlite driver has no such scope
        return context
    context.run(_standalone_session_var.set, None)
    return context


def create_detached_task(coro: Coroutine[Any, Any, Any], *, name: Optional[str] = None) -> "asyncio.Task[Any]":
    """Schedule ``coro`` outside the caller's request/session scope."""
    loop = asyncio.get_running_loop()
    # `create_task` snapshots the CURRENT context; running it inside the detached
    # one makes that snapshot a copy of it (the `context=` kwarg is 3.11+).
    task = detached_context().run(loop.create_task, coro, name=name)
    _DETACHED.add(task)
    task.add_done_callback(_DETACHED.discard)
    return task
