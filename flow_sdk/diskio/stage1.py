"""Stage 1 of a scan, complete or not at all (spec §0 Completeness, §13).

``scan_stage1`` asks the selected ``Scanner`` backend for a whole stream and hands
back the verified items. Any failure of a non-Python backend — a missing terminal,
a count mismatch, a dead child, an exception — re-runs THAT call on the Python
backend, so a caller never sees a shorter-but-well-formed result. A failure is per
call and never latches: the next scan asks the selected backend again.

``stage1_items`` is what the indexer's walkers call: the items when a non-Python
backend will answer, else None — the Python walk they already have is the same
descent, so there is nothing to gain by routing it through here.
"""

from __future__ import annotations

import logging
from typing import Sequence

from flow_sdk.diskio.contract import (
    ScanCandidate,
    Scanner,
    ScanProblem,
    ScanRequest,
    ScanRoot,
    StreamEnd,
    TypeScanSpec,
    WalkEntry,
)
from flow_sdk.diskio.select import kernel, python_backend

logger = logging.getLogger(__name__)

Stage1Item = WalkEntry | ScanCandidate | ScanProblem


class StreamFailure(RuntimeError):
    """A backend stream that cannot be trusted as a complete answer."""


def _collect(scanner: Scanner, request: ScanRequest) -> list[Stage1Item]:
    """Every item of the stream — THE completeness check, for any backend: exactly one
    ``StreamEnd``, last, whose per-kind counts equal what was received."""
    items: list[Stage1Item] = []
    counts: dict[str, int] = {}
    end: StreamEnd | None = None
    for item in scanner.scan(request):
        if end is not None:
            raise StreamFailure("an item follows the terminal StreamEnd")
        if isinstance(item, StreamEnd):
            end = item
            continue
        counts[item.spec_kind] = counts.get(item.spec_kind, 0) + 1
        items.append(item)
    if end is None:
        raise StreamFailure("the stream has no terminal StreamEnd")
    for kind in set(counts) | set(end.counts):
        if counts.get(kind, 0) != end.counts.get(kind, 0):
            raise StreamFailure(f"{kind}: received {counts.get(kind, 0)}, terminal says {end.counts.get(kind, 0)}")
    return items


def scan_stage1(request: ScanRequest) -> list[Stage1Item]:
    """The verified stage-1 items for ``request``, from the selected backend."""
    scanner = kernel(Scanner)
    python = python_backend(Scanner)
    if scanner is python:
        return _collect(python, request)
    try:
        return _collect(scanner, request)
    except Exception as exc:  # noqa: BLE001 — every failure re-runs on Python
        logger.warning("diskio stage-1 scan failed on the %s backend (%s); re-running on Python",
                       type(scanner).__name__, exc)
        return _collect(python, request)


def stage1_items(
    root: str, *, gitignore: bool, denylist: bool, file_exts: tuple[str, ...] | None,
    specs: Sequence[TypeScanSpec] = (),
) -> list[Stage1Item] | None:
    """One root's stage-1 items when a non-Python backend answers, else None.

    None means "walk in-process": Python is selected, or the selected backend is
    unavailable here (no binary on this platform, another contract version). With no
    ``specs`` the request is a pure tree walk under the same policy.
    """
    if kernel(Scanner) is python_backend(Scanner):
        return None
    from flow_sdk.diskio.python.tree_walker import walk_policy  # noqa: PLC0415

    return scan_stage1(ScanRequest(
        roots=(ScanRoot(path=root, kind="real_project_cwd"),),
        policy=walk_policy(gitignore=gitignore, denylist=denylist, file_exts=file_exts),
        specs=tuple(specs),
    ))
