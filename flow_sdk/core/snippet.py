"""Code snippets: one plain code file, three comment-marked regions, run as-is.

::

    import sys                 # preamble — before the first marker, kept, not shown
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
import re
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
        """The line ending this region is written in (its marker line decides)."""
        return "\r\n" if self.marker.endswith("\r\n") else "\n"


class SnippetDoc(DataSpec):
    """A snippet file split into regions. ``SnippetDoc.parse(t).text() == t``, byte for byte."""

    model_config = ConfigDict(frozen=True)

    preamble: str = ""
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
        return cls(
            preamble="".join(pieces[: starts[0]]),
            regions=[
                SnippetRegion(
                    kind=_MARKER.match(pieces[s]).group(1),  # type: ignore[union-attr]
                    marker=pieces[s],
                    body="".join(pieces[s + 1 : e]),
                )
                for s, e in zip(starts, ends)
            ],
        )

    def text(self) -> str:
        """The file. Every part but the last is closed with a newline: a marker on
        the file's last line has none, and once a body is added after it the two
        would glue into one line and the marker would stop being one."""
        parts = [p for p in [self.preamble, *(x for r in self.regions for x in (r.marker, r.body))] if p]
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
    """``POST /api/v1/snippet/run``."""

    path: str
    timeout_seconds: float = Field(default=30.0, gt=0, le=600)


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
    """A file for code that has no file yet, under the OS temp dir."""
    folder = Path(tempfile.gettempdir()) / TEMP_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    stem = name or time.strftime("%Y%m%d-%H%M%S")
    target = folder / f"{stem}.{ext.lstrip('.')}"
    target.write_text(code, encoding="utf-8")
    return target


@functools.cache
def _terminal_path() -> str:
    """The PATH a terminal would have (nvm's node, ~/.cargo/bin). Captured once:
    it costs a login shell, ~1s. A toolchain installed later needs a restart."""
    from flow_sdk.core.capabilities.env_probe import capture_terminal_path  # noqa: PLC0415

    return capture_terminal_path()


async def run_snippet(path: Path, *, timeout_seconds: float, env_path: Optional[str] = None) -> CliResult:
    """Run the file as written. Never raises: a missing file, an unknown language,
    a compile error, an exception and a hang are all a ``CliResult``.

    ``env_path`` overrides the PATH the language toolchain is looked up on.
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
    with tempfile.TemporaryDirectory(prefix="flowpad-snippet-build-") as build:
        command = template.format(file=shlex.quote(str(path)), out=shlex.quote(str(Path(build) / "snippet")))
        return await run_shell(
            command,
            timeout_seconds=timeout_seconds,
            workdir=path.parent,
            extra_env={"PATH": env_path},
        )


__all__ = [
    "RUNNERS",
    "SnippetDoc",
    "SnippetReadRequest",
    "SnippetRunRequest",
    "SnippetSaveRequest",
    "SnippetRegion",
    "read_snippet",
    "run_snippet",
    "edit_region",
    "write_temp_snippet",
]
