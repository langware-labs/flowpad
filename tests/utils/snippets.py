"""Run a documentation snippet as written.

The shelf's rule is that a snippet cannot drift silently, and a snippet nobody executes drifts
the moment a signature moves. So a pin reads the ``.md``, takes the fence, and runs it — no
transcription, no paraphrase. Names a fence uses but does not define (``KEY``, ``src``) are
supplied through the namespace, the way a reader would have them in scope.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import re
from pathlib import Path
from typing import Optional

SHELF = Path(__file__).resolve().parents[2] / "docs" / "snippets"

_FENCE = re.compile(r"```(\w+)\n(.*?)\n```", re.DOTALL)
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)


def fences(markdown: str, lang: str = "python") -> list[str]:
    """Every ``lang`` fence in *markdown*, in order."""
    return [body for tag, body in _FENCE.findall(markdown) if tag == lang]


def fence_under(markdown: str, heading: str, *, lang: str = "python", nth: int = 0) -> str:
    """The *nth* ``lang`` fence beneath the heading whose text starts with *heading*.

    Sections are addressed by heading rather than by index so inserting a snippet above does
    not silently re-point every pin below it.
    """
    positions = [(m.start(), m.group(2).strip()) for m in _HEADING.finditer(markdown)]
    start = next((pos for pos, text in positions if text.startswith(heading)), None)
    if start is None:
        raise LookupError(f"no heading starting with {heading!r}")
    end = next((pos for pos, _ in positions if pos > start), len(markdown))
    found = fences(markdown[start:end], lang)
    if len(found) <= nth:
        raise LookupError(f"section {heading!r} has {len(found)} {lang} fence(s), wanted #{nth}")
    return found[nth]


def compile_fence(source: str, filename: str = "<snippet>"):
    return compile(source, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)


async def run_fence(source: str, namespace: Optional[dict] = None, *, filename: str = "<snippet>") -> dict:
    """Execute a fence — top-level ``await`` allowed — and return its namespace."""
    ns = {"__name__": "__snippet__"} if namespace is None else namespace
    ns.setdefault("__name__", "__snippet__")
    result = eval(compile_fence(source, filename), ns)  # noqa: S307 — executes checked-in documentation
    if inspect.isawaitable(result):
        await result
    return ns


async def run_fence_until(
    source: str, namespace: dict, done: asyncio.Event, *, filename: str = "<snippet>", timeout: float = 10.0
) -> dict:
    """Run a fence that never returns (an ``async for … listen()`` loop) until *done* is set.

    The fence runs as a task; when the test's own signal fires the task is cancelled. Any
    error the fence raised before that point is re-raised — a loop that died is a failure,
    not a finish. *timeout* bounds a test whose signal never comes.
    """
    task = asyncio.create_task(run_fence(source, namespace, filename=filename))
    waiter = asyncio.create_task(done.wait())
    try:
        finished, _ = await asyncio.wait({task, waiter}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if task in finished:
            task.result()  # re-raise a fence that died
        elif not finished:
            raise TimeoutError(f"{filename}: the loop neither finished nor signalled within {timeout}s")
    finally:
        for t in (task, waiter):
            if not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001 — teardown
                    pass
    return namespace


def doc(name: str) -> str:
    """The text of ``docs/snippets/<name>``."""
    return (SHELF / name).read_text(encoding="utf-8")


__all__ = ["SHELF", "compile_fence", "doc", "fence_under", "fences", "run_fence", "run_fence_until"]
