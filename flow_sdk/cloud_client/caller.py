"""Who made the current hub call — the "Made by" line of an error's details.

A UI request names itself in the ``X-Flow-Caller`` header (the screen it came from); the
middleware puts it here for the request's lifetime. Background work sets it with ``as_caller``.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from collections.abc import Iterator

CALLER_HEADER = "x-flow-caller"
MAX_CALLER_CHARS = 200

_caller: ContextVar[str] = ContextVar("flow_caller", default="")


def current_caller() -> str:
    return _caller.get()


@contextmanager
def as_caller(name: str) -> Iterator[None]:
    token = _caller.set(name[:MAX_CALLER_CHARS])
    try:
        yield
    finally:
        _caller.reset(token)
