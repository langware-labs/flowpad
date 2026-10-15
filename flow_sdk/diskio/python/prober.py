"""Prober — spec §6, the skip-fresh freshness probe as data in, data out.

``FSRecord.index_required`` answers this per record through the registry; here
the same decision runs on a ``ProbeRequest`` — the fingerprint from a
``FingerprintRule`` (or handed in pre-computed), the digests through
``fs_record._digest``, the sentinel from the shadow dir — with no ``FSRecord``,
no ``FSRef`` and no registry lookup.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterator, Sequence

from flow_sdk.diskio.contract import FingerprintRule, ItemError, Probe, ProbeRequest, StreamEnd
from flow_sdk.diskio.python._stream import unreadable, with_end
from flow_sdk.fs_store.fs_record import _HASH_GLOB, _METADATA_JSON, _digest
from flow_sdk.fs_store.indexer.walk import walk_entries

_HASH_SUFFIX = _HASH_GLOB.lstrip("*")


def _stat_fingerprint(path: Path) -> tuple[str, OSError | None]:
    """``FSRef.fingerprint``: ``<mtime_ns>:<size>``, ``""`` when it cannot be stat'ed."""
    try:
        st = path.stat()
    except OSError as exc:
        return "", exc
    return f"{st.st_mtime_ns}:{st.st_size}", None


def _rule_paths(rule: FingerprintRule, path: Path) -> Iterator[Path]:
    base = path if path.is_dir() else path.parent
    for part in rule.parts:
        yield path if part == "." else base / part
    for pattern in rule.globs:
        yield from base.glob(pattern)
    for tree in rule.trees:
        # Every entry below the tree, directories included, through the shared
        # walk with nothing skipped: this is one asset's inner dir, not a user tree.
        for _dir, subdirs, files, _error in walk_entries(base / tree, gitignore=False, include_files=True, skip=None):
            yield from subdirs
            yield from files


def fingerprint(rule: FingerprintRule, asset_path: str) -> tuple[str, OSError | None]:
    """The freshness fingerprint of ``asset_path`` under ``rule``, plus the
    error that left a ``stat`` fingerprint empty. A rule that cannot be
    evaluated degrades to ``stat``, as ``get_hash`` falls back to ``fingerprint``."""
    path = Path(asset_path)
    if rule.kind == "stat":
        return _stat_fingerprint(path)
    try:
        if rule.kind == "stat_sum":
            total = 0
            for part in _rule_paths(rule, path):
                try:
                    st = part.stat()
                except OSError:
                    continue
                total += st.st_mtime_ns + st.st_size
            return str(total), None
        newest = 0
        for part in _rule_paths(rule, path):
            try:
                newest = max(newest, part.stat().st_mtime_ns)
            except OSError:
                continue
        return str(newest), None
    except Exception:  # noqa: BLE001 — an unevaluable rule is the stat rule
        return _stat_fingerprint(path)


def sentinel_parts(shadow_dir: Path) -> list[str] | None:
    """Underscore-split stem of the shadow dir's ``*.hash`` sentinel, or None
    when it holds none or cannot be listed. More than one → the lexically
    greatest name (names start with the epoch, so that is the newest)."""
    try:
        names = [name for name in os.listdir(shadow_dir) if name.endswith(_HASH_SUFFIX)]
    except OSError:
        return None
    return max(names)[: -len(_HASH_SUFFIX)].split("_") if names else None


def _persisted_asset_path(shadow_dir: Path) -> str | None:
    try:
        meta_path = shadow_dir / _METADATA_JSON
        if not meta_path.exists():
            return None
        ref = json.loads(meta_path.read_text(encoding="utf-8")).get("asset_ref")
        return ref if isinstance(ref, str) and ref else None
    except (OSError, ValueError):
        return None


def index_required(fp: str, asset_path: str, shadow_dir: Path) -> bool:
    """``FSRecord.index_required`` for a live fingerprint ``fp``: content changed
    or never indexed; else relocated (3-part sentinel); else, for a legacy
    2-part sentinel, the persisted ``asset_ref`` differs — absent means fresh."""
    parts = sentinel_parts(shadow_dir)
    indexed_hash = parts[1] if parts and len(parts) >= 2 else ""
    if _digest(fp) != indexed_hash:
        return True
    if parts and len(parts) >= 3:
        return _digest(asset_path) != parts[2]
    persisted = _persisted_asset_path(shadow_dir)
    if persisted is None:
        return False
    return persisted != asset_path


class PyProber:
    def probe(
        self, requests: Sequence[ProbeRequest], rules: dict[str, FingerprintRule], *, threads: int = 1,
    ) -> Iterator[Probe | StreamEnd]:
        for request in requests:
            if request.fingerprint is None and request.type_name not in rules:
                raise ValueError(
                    f"probe of {request.record_id!r}: type {request.type_name!r} has no fingerprint rule "
                    "and the request carries no fingerprint"
                )
        return with_end(self._probes(requests, rules))

    @staticmethod
    def _probes(requests: Sequence[ProbeRequest], rules: dict[str, FingerprintRule]) -> Iterator[Probe]:
        for request in requests:
            error: ItemError | None = None
            fp = request.fingerprint
            if fp is None:
                fp, failure = fingerprint(rules[request.type_name], request.asset_path)
                if failure is not None:
                    error = unreadable(request.asset_path, failure)
            yield Probe(
                record_id=request.record_id,
                index_required=index_required(fp, request.asset_path, Path(request.shadow_dir)),
                error=error,
            )
