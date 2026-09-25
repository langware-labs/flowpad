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
import json
import os
import re
from pathlib import Path
from typing import Optional

SHELF = Path(__file__).resolve().parents[2] / "docs" / "snippets"

_FENCE = re.compile(r"```(\w+)\n(.*?)\n```", re.DOTALL)
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)


def fences(markdown: str, lang: str = "python") -> list[str]:
    """Every ``lang`` fence in *markdown*, in order."""
    return [body for tag, body in _FENCE.findall(markdown) if tag == lang]


def _without_fences(markdown: str) -> str:
    """*markdown* with every fenced block blanked, keeping offsets intact.

    A ``# comment`` inside a python fence is not a markdown heading, but the
    heading regex cannot tell — it silently truncated a section at its first
    fence ("section '2.' has 1 python fence(s), wanted #2").

    Scanned LINE BY LINE rather than with the fence regex: that regex requires a
    language tag, so an untagged ``` block makes it pair the wrong delimiters
    and blank real headings instead of code.
    """
    out, inside = [], False
    for line in markdown.split("\n"):
        if line.lstrip().startswith("```"):
            inside = not inside
            out.append(" " * len(line))
            continue
        out.append(" " * len(line) if inside else line)
    return "\n".join(out)


def fence_under(markdown: str, heading: str, *, lang: str = "python", nth: int = 0) -> str:
    """The *nth* ``lang`` fence beneath the heading whose text starts with *heading*.

    Sections are addressed by heading rather than by index so inserting a snippet above does
    not silently re-point every pin below it.
    """
    positions = [(m.start(), m.group(2).strip()) for m in _HEADING.finditer(_without_fences(markdown))]
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
    record_run(source)
    return ns


def record_run(source: str) -> None:
    """With ``FLOW_SNIPPET_LEDGER`` naming a file, append the text of every fence that ran to its end
    without raising — the proof a page quoting a fence (the SDK site) checks it against, verbatim."""
    path = os.environ.get("FLOW_SNIPPET_LEDGER")
    if path:
        with open(path, "a", encoding="utf-8") as ledger:
            ledger.write(json.dumps(source.strip("\n")) + "\n")


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
        else:
            record_run(source)  # the loop did what the test waited for, alive
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




def point_driver_at(monkeypatch, provider: str, root: str, url: str) -> None:
    """Point a shipped driver's API root (its module's ``root`` constant, e.g. ``GRAPH_API_BASE``) at a
    loopback double, so a fence runs exactly as the reader pastes it — with no test-only argument."""
    from flow_sdk.ingest.driver_registry import asset_module  # noqa: PLC0415

    module = asset_module(provider)
    assert hasattr(module, root), f"{provider} has no {root}"
    monkeypatch.setattr(module, root, url)


def opening_programs() -> dict[str, str]:
    """``workflows.md`` §6 as the SDK site shows it: the program, and the same program with its one channel
    line swapped for each line of the section's second fence — channel → the whole program."""
    page = doc("workflows.md")
    program, swaps = fence_under(page, "6."), fence_under(page, "6.", nth=1)
    (line,) = [ln.strip() for ln in program.split("\n") if "StreamInbox(" in ln]
    programs = {re.search(r'provider="(\w+)"', line).group(1): program}
    for swap in filter(None, (ln.strip() for ln in swaps.split("\n"))):
        programs[re.search(r'provider="(\w+)"', swap).group(1)] = program.replace(line, swap)
    return programs


__all__ = ["SHELF", "compile_fence", "doc", "fence_under", "fences", "opening_programs", "point_driver_at",
           "record_run", "run_fence", "run_fence_until"]
