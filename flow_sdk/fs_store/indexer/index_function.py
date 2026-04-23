"""FSIndexer — DFS walker with type-registered handlers.

Uses the existing FSRef primitive (flow_sdk/fs_store/fs_ref/base.py) tagged
with a RecordType discriminator. See tests/unit/test_fs_store/test_basic_indexer.py
for the contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


@dataclass(frozen=True, slots=True)
class IndexerOptions:
    verbose: bool = True
    limit: int | None = None


class IndexerFunc(Protocol):
    async def __call__(
        self, nodes: list[FSRef], opts: IndexerOptions
    ) -> list[FSRef]: ...


class FSIndexer:
    def __init__(
        self,
        state_dir: Path,
        roots: list[FSRef] | None = None,
    ) -> None:
        self._state_dir: Path = state_dir
        self._roots: list[FSRef] = list(roots) if roots is not None else []
        self._functions: dict[RecordType, list[IndexerFunc]] = {}

    def add_function(
        self, record_type: RecordType, fn: IndexerFunc
    ) -> None:
        self._functions.setdefault(record_type, []).append(fn)

    def add_root(self, node: FSRef) -> None:
        self._roots.append(node)

    async def scan(
        self, opts: IndexerOptions | None = None
    ) -> list[FSRef]:
        opts = opts if opts is not None else IndexerOptions()
        stack: list[FSRef] = list(reversed(self._roots))
        visited: list[FSRef] = []
        seen: set[tuple[str, RecordType | None]] = set()
        while stack:
            node = stack.pop()
            key = (node.path, node.record_type)
            if key in seen:
                continue
            seen.add(key)
            visited.append(node)
            if opts.verbose:
                print(f"[indexer] visit type={node.record_type} path={node.path}")
            fns = self._functions.get(node.record_type, []) if node.record_type is not None else []
            for fn in fns:
                children = await fn([node], opts)
                stack.extend(reversed(children))
            if opts.limit is not None and len(visited) >= opts.limit:
                break
        return visited
