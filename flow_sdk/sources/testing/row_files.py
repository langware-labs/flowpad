"""``RowFiles`` -- the in-memory double and the checks every implementation must pass.

``MemoryRowFiles`` is the authoritative double for code that keeps rows in a store (``datasets/
locations.py``). ``check_row_files(store)`` is the contract, run against each driver that says it is
``RowFiles`` (Drive, S3) over its own transport double -- the same assertions for all of them.
"""

from __future__ import annotations

import hashlib
from typing import Optional

from flow_sdk.sources.errors import Conflict


class MemoryRowFiles:
    """Files by path, each with a version that moves on every write; conditional writes and deletes."""

    def __init__(self) -> None:
        self.files: dict[str, tuple[bytes, str]] = {}
        self.writes = 0
        self._n = 0

    def _version(self, data: bytes) -> str:
        self._n += 1
        return f"{self._n}-{hashlib.sha256(data).hexdigest()[:8]}"

    def _check(self, path: str, expected: Optional[str]) -> None:
        if expected is None:
            return
        held = self.files[path][1] if path in self.files else ""
        if held != expected:
            raise Conflict(f"{path} is at {held or 'nothing'}, not {expected or 'nothing'}")

    async def list_files(self) -> dict[str, str]:
        return {path: version for path, (_, version) in self.files.items()}

    async def read_file(self, path: str) -> bytes:
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path][0]

    async def write_file(self, path: str, data: bytes, *, expected: Optional[str] = None) -> str:
        self._check(path, expected)
        version = self._version(data)
        self.files[path] = (bytes(data), version)
        self.writes += 1
        return version

    async def delete_file(self, path: str, *, expected: Optional[str] = None) -> None:
        self._check(path, expected)
        self.files.pop(path, None)


async def check_row_files(store) -> None:
    """The ``RowFiles`` contract, against an EMPTY store: what the working copy relies on."""
    from flow_sdk.sources.protocols import RowFiles

    assert isinstance(store, RowFiles), "a row store implements list_files, read_file, write_file, delete_file"
    assert await store.list_files() == {}
    first = await store.write_file("rows/a/row.json", b'{"metadata": {}}', expected="")
    assert first and (await store.list_files()) == {"rows/a/row.json": first}
    assert await store.read_file("rows/a/row.json") == b'{"metadata": {}}'
    try:
        await store.write_file("rows/a/row.json", b"{}", expected="")
    except Conflict:
        pass
    else:
        raise AssertionError("a write expecting nothing over a file that exists must be a Conflict")
    second = await store.write_file("rows/a/row.json", b'{"metadata": {"x": 1}}', expected=first)
    assert second != first, "every write moves the version"
    try:
        await store.write_file("rows/a/row.json", b"{}", expected=first)
    except Conflict:
        pass
    else:
        raise AssertionError("a write expecting a stale version must be a Conflict")
    await store.write_file("rows/a/input/x.json", b"[1]")
    assert set(await store.list_files()) == {"rows/a/row.json", "rows/a/input/x.json"}
    try:
        await store.delete_file("rows/a/row.json", expected=first)
    except Conflict:
        pass
    else:
        raise AssertionError("a delete expecting a stale version must be a Conflict")
    await store.delete_file("rows/a/row.json", expected=second)
    await store.delete_file("rows/a/input/x.json")
    await store.delete_file("rows/a/input/x.json")       # already gone is success
    assert await store.list_files() == {}
