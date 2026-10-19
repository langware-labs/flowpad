"""Scanner — spec §13, stage 1: the walk and the declared scan composed, one
``ScanRequest`` in and one tagged stream out."""

from __future__ import annotations

from typing import Iterator

from flow_sdk.diskio.contract import ScanCandidate, ScanProblem, ScanRequest, StreamEnd, WalkEntry
from flow_sdk.diskio.python._stream import with_end
from flow_sdk.diskio.python.declared_scanner import FOLDER_ROOT, PyDeclaredScanner, folder_walks
from flow_sdk.diskio.python.tree_walker import PyTreeWalker

STREAM_KINDS = (WalkEntry.spec_kind, ScanCandidate.spec_kind, ScanProblem.spec_kind)


class PyScanner:
    def scan(self, request: ScanRequest) -> Iterator[WalkEntry | ScanCandidate | ScanProblem | StreamEnd]:
        return self._ended(self._items(request))

    @staticmethod
    def _ended(items: Iterator) -> Iterator:
        """The stage-1 terminal names all three kinds, zero included (spec §13)."""
        for item in with_end(items):
            if isinstance(item, StreamEnd):
                item = StreamEnd(counts={**{kind: 0 for kind in STREAM_KINDS}, **item.counts})
            yield item

    @staticmethod
    def _items(request: ScanRequest) -> Iterator[WalkEntry | ScanCandidate | ScanProblem]:
        """Per root: FIRST the root-kind scan, then the walk in pre-order with
        each directory's folder-rooted scan right after that directory's entry.
        A root-kind line and a folder-kind line for the root directory carry the
        same ``parent``; coming before or after the root's entry is what tells
        them apart. Within one scan: per type in spec order, candidates then problems."""
        scanner = PyDeclaredScanner()

        def lines(root: str, root_type: str, specs) -> Iterator[ScanCandidate | ScanProblem]:
            for spec in specs:
                try:
                    candidates, problems = scanner.scan(root, root_type, (spec,))
                except OSError:
                    # A stat ``scan_declared`` does not guard (``<dir>/SKILL.md`` under a
                    # mode-000 directory raises EACCES): the asset reads as absent and
                    # the stream goes on — one directory never aborts stage 1.
                    continue
                yield from candidates
                yield from problems

        per_folder = tuple(
            spec for spec in request.specs if folder_walks(spec.walks)
        )
        for root in request.roots:
            yield from lines(root.path, root.kind, request.specs)
            for entry in PyTreeWalker._entries(root.path, request.policy):
                yield entry
                yield from lines(entry.dir, FOLDER_ROOT, per_folder)
