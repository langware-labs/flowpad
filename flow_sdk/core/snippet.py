"""Code snippets: one plain code file, three comment-marked regions, run as-is.

::

    import sys                 # before the first marker: part of the hidden (imports) region
    # %% flowpad:hidden
    import json
    # %% flowpad:init
    data = {"a": 1}
    # %% flowpad:snippet
    print(json.dumps(data))

The markers are comments, so the file stays an ordinary program: it runs top to
bottom exactly as written and a traceback's line numbers are the file's own. The
regions only decide what a viewer shows. ``%%`` is the Jupyter/VS Code cell
convention, so editors that know cells still see them.

Everything a viewer does — parse, save, run — lives here so it is provable in a
fast unit test; the UI only renders what these functions return.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import re
import secrets
import shlex
import tempfile
import time
from pathlib import Path
from typing import Literal, Optional

from pydantic import ConfigDict, Field

from flow_sdk.capsules.atomic import atomic_write, capsule_lock
from flow_sdk.core.compute.exec import run_shell
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)

RegionKind = Literal["hidden", "init", "snippet"]

_MARKER = re.compile(r"^\s*(?:#|//|--)\s*%%\s*flowpad:(hidden|init|snippet)\b")

#: Suffix → command. ``{file}`` and ``{out}`` arrive shell-quoted. A compiled
#: language builds into ``{out}`` (a throwaway directory) and runs it, so a
#: compile error and a runtime error both come back as the one result.
RUNNERS: dict[str, str] = {
    ".py": "python3 {file}",
    ".js": "node {file}",
    ".mjs": "node {file}",
    ".cjs": "node {file}",
    ".rs": "rustc --edition 2021 -o {out} {file} && {out}",
    ".sh": "sh {file}",
}

#: Where a snippet with no file of its own is written. The OS temp dir: outside
#: every project, so it is never indexed and the OS cleans it up.
TEMP_DIR_NAME = "flowpad-snippets"


class SnippetRegion(DataSpec):
    """One region: its marker line and its body, each WITH its line endings.

    Keeping the ``\n`` inside the strings (rather than joining lines back) is
    what makes "no line" and "one empty line" different values — and so what
    makes the round trip exact.
    """

    model_config = ConfigDict(frozen=True)

    kind: RegionKind
    marker: str
    body: str

    @property
    def shown(self) -> str:
        """What a viewer edits: the body without the line break that closes it."""
        return self.body.removesuffix("\n").removesuffix("\r")

    @property
    def eol(self) -> str:
        """The line ending this region is written in: its marker line decides, or
        its body for the leading region, which has no marker."""
        return "\r\n" if (self.marker or self.body).split("\n", 1)[0].endswith("\r") else "\n"


class SnippetDoc(DataSpec):
    """A snippet file split into regions. ``SnippetDoc.parse(t).text() == t``, byte for byte.

    Text before the first marker is a leading ``hidden`` region with no marker
    line: imports put there (a shebang, a `use`) show and edit with the rest of
    the imports instead of being a part of the file no view can reveal.
    """

    model_config = ConfigDict(frozen=True)

    regions: list[SnippetRegion]

    @classmethod
    def parse(cls, text: str) -> Optional["SnippetDoc"]:
        """The regions of *text*, or None when it has no marker (not a snippet).

        Lines end at ``\n`` only, so a ``\r`` stays on its line: CRLF, mixed
        endings and a missing final newline all survive.
        """
        pieces = re.findall(r"[^\n]*\n|[^\n]+$", text)
        starts = [i for i, piece in enumerate(pieces) if _MARKER.match(piece)]
        if not starts:
            return None
        ends = [*starts[1:], len(pieces)]
        leading = "".join(pieces[: starts[0]])
        return cls(
            regions=[
                *([SnippetRegion(kind="hidden", marker="", body=leading)] if leading else []),
                *(
                    SnippetRegion(
                        kind=_MARKER.match(pieces[s]).group(1),  # type: ignore[union-attr]
                        marker=pieces[s],
                        body="".join(pieces[s + 1 : e]),
                    )
                    for s, e in zip(starts, ends)
                ),
            ],
        )

    def text(self) -> str:
        """The file. Every part but the last is closed with a newline: a marker on
        the file's last line has none, and once a body is added after it the two
        would glue into one line and the marker would stop being one."""
        parts = [p for p in (x for r in self.regions for x in (r.marker, r.body)) if p]
        return "".join(p if p.endswith("\n") or i == len(parts) - 1 else p + "\n" for i, p in enumerate(parts))

    def with_body(self, index: int, kind: RegionKind, shown: str) -> "SnippetDoc":
        """Replace one region from its ``shown`` text (see ``SnippetRegion.shown``).

        Line breaks are written in the region's own ending (a CRLF file stays
        CRLF). The closing one is put back, and a region with a region after it
        always gets one — otherwise the next marker would glue onto the edited
        line and stop being a marker. Only the last region of a file that had no
        final newline stays without one.

        *kind* must match what is at *index*: a viewer edits the file it last
        read, and if someone restructured it since, writing by position would
        land the text in the wrong region. ``ValueError`` then.
        """
        if not 0 <= index < len(self.regions) or self.regions[index].kind != kind:
            raise ValueError(f"region {index} is not '{kind}' any more; reload the snippet")
        old = self.regions[index]
        eol = old.eol
        shown = shown.replace("\r\n", "\n").replace("\n", eol)
        closed = old.body.endswith("\n") or index < len(self.regions) - 1
        body = shown + eol if closed else shown
        regions = [*self.regions[:index], old.model_copy(update={"body": body}), *self.regions[index + 1 :]]
        return self.model_copy(update={"regions": regions})


class SnippetReadRequest(DataSpec):
    """``POST /api/v1/snippet/read``."""

    path: str


class SnippetSaveRequest(DataSpec):
    """``POST /api/v1/snippet/save`` — one region, by position AND kind (see ``with_body``).

    ``base`` is the region text the edit started from (see ``edit_region``).
    """

    path: str
    index: int
    kind: RegionKind
    shown: str
    base: Optional[str] = None


class SnippetRunRequest(DataSpec):
    """``POST /api/v1/snippet/run``. ``run_id`` (the caller's) is what a stop names;
    ``connection_id`` ties the run to a WebSocket, so it ends when the socket does."""

    path: str
    timeout_seconds: float = Field(default=30.0, gt=0, le=600)
    run_id: Optional[str] = None
    connection_id: Optional[str] = None


class SnippetStopRequest(DataSpec):
    """``POST /api/v1/snippet/stop``."""

    run_id: str


def read_snippet(path: Path) -> Optional[SnippetDoc]:
    # Bytes, not ``read_text``: text mode translates CRLF to LF on read, and a
    # save would then silently convert the whole file.
    return SnippetDoc.parse(Path(path).read_bytes().decode("utf-8"))


def edit_region(
    path: Path, index: int, kind: RegionKind, shown: str, base: Optional[str] = None
) -> SnippetDoc:
    """Replace one region's text in the file on disk; returns the file re-read.

    Read, edit and write happen under ONE lock: two editors saving different
    regions at once (two region panes, or the agent and the viewer) would
    otherwise each write back the other's region as it was, losing an edit.

    *base* is the region text the edit was made against. When given and the
    region on disk is no longer that text — the agent changed it since the
    viewer loaded it — nothing is written: saving would silently erase the
    other writer's change. Raises ``ValueError`` then, and when the file is no
    snippet or the region moved.
    """
    path = Path(path)
    with capsule_lock(path):
        doc = read_snippet(path)
        if doc is None:
            raise ValueError(f"{path} is not a snippet any more")
        if base is not None and 0 <= index < len(doc.regions) and doc.regions[index].shown != base:
            raise ValueError(f"region {index} changed on disk since it was loaded; reload the snippet")
        edited = doc.with_body(index, kind, shown)
        atomic_write(path, edited.text().encode("utf-8"))
        return edited


def write_temp_snippet(code: str, ext: str, name: Optional[str] = None) -> Path:
    """A file for code that has no file yet, under the OS temp dir.

    A given *name* is reused on purpose (the agent rewrites its snippet by name)
    and kept to a bare file name, so it cannot point outside the folder. Without
    one the name is unique: two snippets shown within one second must not share
    a file, or the second silently replaces the first.
    """
    folder = Path(tempfile.gettempdir()) / TEMP_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    stem = Path(name or "").name.strip(". ") or f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"
    target = folder / f"{stem}.{ext.lstrip('.')}"
    target.write_text(code, encoding="utf-8")
    return target


@functools.cache
def _terminal_path() -> str:
    """The PATH a terminal would have (nvm's node, ~/.cargo/bin). Captured once:
    it costs a login shell, ~1s. A toolchain installed later needs a restart."""
    from flow_sdk.core.capabilities.env_probe import capture_terminal_path  # noqa: PLC0415

    return capture_terminal_path()


#: Runs in flight by the caller's run id: the event ``stop_snippet`` sets, and
#: the connection that started it.
_RUNNING: dict[str, tuple[asyncio.Event, Optional[str]]] = {}


def stop_snippet(run_id: str) -> bool:
    """Stop a run in flight: its process group is killed and the run answers with
    what it printed. False when nothing by that id is running (already done)."""
    running = _RUNNING.get(run_id)
    if running is None:
        return False
    running[0].set()
    return True


def stop_runs_of(connection_id: str) -> int:
    """Stop every run a WebSocket connection started — called when it drops. A
    closed or reloaded tab never runs its unmount cleanup, and its run would
    otherwise go on until its timeout."""
    stopped = 0
    for stop, owner in list(_RUNNING.values()):
        if owner == connection_id and not stop.is_set():
            stop.set()
            stopped += 1
    if stopped:
        logger.info("snippet: stopped %d run(s) of dropped connection %s", stopped, connection_id)
    return stopped


async def run_snippet(
    path: Path,
    *,
    timeout_seconds: float,
    env_path: Optional[str] = None,
    run_id: Optional[str] = None,
    connection_id: Optional[str] = None,
) -> CliResult:
    """Run the file as written. Never raises: a missing file, an unknown language,
    a compile error, an exception, a hang and a stop are all a ``CliResult``.

    ``env_path`` overrides the PATH the language toolchain is looked up on;
    ``run_id`` makes the run stoppable by ``stop_snippet``, and ``connection_id``
    by ``stop_runs_of``.
    """
    if env_path is None:
        # Off the event loop: the first capture runs a login shell (~1s).
        env_path = await asyncio.to_thread(_terminal_path)
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        return CliResult.of_process(str(path), None, stderr=f"snippet file not found: {path}")
    template = RUNNERS.get(path.suffix.lower())
    if template is None:
        known = ", ".join(sorted(RUNNERS))
        return CliResult.of_process(str(path), None, stderr=f"no runner for '{path.suffix}' files (runnable: {known})")
    stop = asyncio.Event()
    # Registered under the caller's run id when it has one, else a key of its own:
    # ``stop_runs_of`` finds it by owner, and ``stop_snippet`` only knows real run ids.
    key = run_id or f"run:{secrets.token_hex(8)}"
    _RUNNING[key] = (stop, connection_id)
    try:
        with tempfile.TemporaryDirectory(prefix="flowpad-snippet-build-") as build:
            command = template.format(file=shlex.quote(str(path)), out=shlex.quote(str(Path(build) / "snippet")))
            return await run_shell(
                command,
                timeout_seconds=timeout_seconds,
                workdir=path.parent,
                extra_env={"PATH": env_path},
                stop=stop,
            )
    finally:
        _RUNNING.pop(key, None)


__all__ = [
    "RUNNERS",
    "SnippetDoc",
    "SnippetReadRequest",
    "SnippetRunRequest",
    "SnippetSaveRequest",
    "SnippetStopRequest",
    "SnippetRegion",
    "read_snippet",
    "run_snippet",
    "stop_runs_of",
    "stop_snippet",
    "edit_region",
    "write_temp_snippet",
]
