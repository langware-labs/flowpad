"""Write-back — a ``copy`` source's local copy kept in step with its remote, both ways.

A source that reflects by ``copy`` places its files into ``reflect_into``. When it is not ``read_only``
and its driver can write (``ByteStore``), an edit made there goes back: after every pull, each file is
decided by the three-way rule (``flow_sdk.datasets.merge.three_way``) between

* **here** — the local copy, under ``reflect_into``;
* **there** — what the source last delivered: its cache file (for a source whose bytes are remote), or
  its own tree (a local folder); and
* **agreed** — the content both sides last held, remembered per file under this instance (never in the
  person's folder or the project).

``same`` moves the agreement; ``here`` writes the file out (a missing local file is removed remotely —
for Drive, to the trash); ``there`` takes the remote in; ``hold`` writes NEITHER side and is reported,
because last-writer-wins silently drops someone's edit. The pull side honours the same memory: a copy
never overwrites or removes a local file that changed since the agreement (``locally_edited``).

Content is compared by fingerprint (``sha_of``); a file whose size and modification time are what they
were at the agreement is not read again. Nothing here knows a provider: it asks the driver's class for
``ByteStore``, ``stamps_identity`` and ``local_tree_key``, never its name. One pass per source at a time
is ``sync_source``'s lock.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, AsyncIterator, Optional

from flow_sdk.assets.materialize import prune_empty_dirs
from flow_sdk.capsules.atomic import atomic_write
from flow_sdk.datasets.merge import three_way
from flow_sdk.schema.data_spec.data_driver_spec import ReflectMode

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.builtin.data_source import DataSource

logger = logging.getLogger(__name__)

CHUNK = 1 << 20
#: Above this a ``.json`` file is fingerprinted by its bytes, not parsed.
JSON_PARSE_LIMIT = 4 << 20


@dataclass
class WriteBackReport:
    """What one pass did, by local path relative to ``reflect_into``."""

    pushed: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    pulled: list[str] = field(default_factory=list)
    held: list[str] = field(default_factory=list)
    #: ``{rel: why}`` — a write the remote refused (a Google document, a read-only grant).
    refused: dict[str, str] = field(default_factory=dict)

    @property
    def needs_a_person(self) -> bool:
        return bool(self.held or self.refused)

    def sentence(self) -> str:
        """The source card's line for what is waiting on a person, or ``""``."""
        parts = []
        if self.held:
            parts.append(f"Changed both here and remotely since they last agreed, so neither side was written: {', '.join(self.held[:5])}"
                         + (f" (+{len(self.held) - 5} more)" if len(self.held) > 5 else ""))
        if self.refused:
            parts.append("; ".join(f"{rel}: {why}" for rel, why in list(self.refused.items())[:5]))
        return ". ".join(parts)


# ── fingerprints ─────────────────────────────────────────────────────────────


def sha_of(path: Path) -> Optional[str]:
    """The file's content fingerprint, or None when there is no file.

    A ``.json`` file that parses is fingerprinted by its VALUE (the repo's canonical JSON) — the same row
    written by two editors (a trailing newline, another indent, key order) is the same row, not a change
    on both sides that would be held. Anything else, by its bytes."""
    from flow_sdk.llm_index.core import sha256_bytes  # noqa: PLC0415
    from flow_sdk.semantic_lock.targets import canonical_entity_bytes  # noqa: PLC0415
    from flow_sdk.utils.hashing import file_hash  # noqa: PLC0415

    if not path.is_file() or path.is_symlink():
        return None
    if path.suffix.lower() == ".json" and path.stat().st_size <= JSON_PARSE_LIMIT:
        try:
            value = json.loads(path.read_bytes())
        except (ValueError, UnicodeDecodeError):
            pass
        else:
            # The value itself, canonical: a fingerprint is a stored agreement, so its bytes never change shape.
            return "json:" + sha256_bytes(canonical_entity_bytes(value))
    return file_hash(str(path))


def _stamp(path: Path) -> Optional[list[int]]:
    try:
        st = path.stat()
    except OSError:
        return None
    return [st.st_mtime_ns, st.st_size]


# ── the agreement: {rel: {"sha", "here": [mtime_ns, size], "there": [...]}} ──────


def agreed_path(source: "DataSource") -> Path:
    """``<instance>/write_back/<source id>.json``: this machine's memory of the agreement — another clone
    keeps its own, and holds rather than undoes this one's edits."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "write_back" / f"{source.id}.json"


_AGREED_CACHE: dict[Path, tuple[tuple[int, int], dict]] = {}


def _read_agreed(source: "DataSource") -> dict[str, dict]:
    """The agreement, re-read only when its file changed (the pull asks once per placed file)."""
    path = agreed_path(source)
    stamp = _stamp(path)
    if stamp is None:
        return {}
    cached = _AGREED_CACHE.get(path)
    if cached is not None and cached[0] == tuple(stamp):
        return cached[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    agreed = {str(k): (v if isinstance(v, dict) else {"sha": str(v)}) for k, v in data.items()} if isinstance(data, dict) else {}
    _AGREED_CACHE[path] = (tuple(stamp), agreed)
    return agreed


def _write_agreed(source: "DataSource", agreed: dict[str, dict]) -> None:
    path = agreed_path(source)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(agreed, indent=2, sort_keys=True).encode("utf-8"))


def _fingerprint(path: Path, remembered: Optional[dict], side: str) -> Optional[str]:
    """``sha_of(path)``, without reading the file when its size and mtime are what they were at the agreement."""
    stamp = _stamp(path) if path.is_file() else None
    if stamp is None:
        return None
    if remembered and remembered.get(side) == stamp:
        return remembered.get("sha")
    return sha_of(path)


# ── who writes back ──────────────────────────────────────────────────────────


def _driver_of(source: "DataSource") -> "Optional[DataDriver]":
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    return DRIVERS.get_or_none(str(source.provider or ""))


def writes_back(source: "DataSource") -> bool:
    """A ``copy`` source that is not read-only, whose driver can write bytes and leaves its copies alone.

    A driver that stamps our identity into what it places (``stamps_identity``, e.g. ``folder``) rewrites
    the copy itself, so the copy is not the person's edit — pushing it would write our stamp into their
    tree. Such a source mirrors one way, as it always has."""
    from flow_sdk.sources.protocols import ByteStore  # noqa: PLC0415

    if source.reflect != ReflectMode.COPY.value or getattr(source, "read_only", False) or not source.reflect_into:
        return False
    driver = _driver_of(source)
    return driver is not None and driver.is_object and issubclass(driver.cls, ByteStore) and not driver.stamps_identity


def locally_edited(source: "DataSource", dest: Path) -> bool:
    """Whether the local copy at ``dest`` changed since the content both sides last agreed on — the pull
    must then neither overwrite nor remove it. Only for a source that writes back; a file with no
    agreement on record counts as edited, so a pre-existing local file is never clobbered."""
    from flow_sdk.ingest.reflect import target_root  # noqa: PLC0415

    target = target_root(source)
    if target is None or not dest.exists() or not writes_back(source):
        return False
    try:
        rel = dest.relative_to(target).as_posix()
    except ValueError:
        return False
    remembered = _read_agreed(source).get(rel)
    return remembered is None or _fingerprint(dest, remembered, "here") != remembered.get("sha")


# ── one pass ─────────────────────────────────────────────────────────────────


def _local_files(target: Path) -> set[str]:
    """Every file under the local copy, relative — dotfiles skipped (``.DS_Store``, editor swap files).
    The sanctioned walker WITHOUT git rules: the local copy is itself kept out of git, and every file in it
    is the source's."""
    from flow_sdk.fs_store.indexer.walk import gitignore_walk  # noqa: PLC0415

    if not target.is_dir():
        return set()
    out: set[str] = set()
    for _directory, _subdirs, files in gitignore_walk(target, gitignore=False, denylist=False):
        for path in files:
            rel = path.relative_to(target)
            if not path.is_symlink() and not any(part.startswith(".") for part in rel.parts):
                out.add(rel.as_posix())
    return out


@dataclass
class _Plan:
    """The decisions of one pass, made off the loop from files alone; the pushes are what is left."""

    push: list[str] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    agreed: dict[str, dict] = field(default_factory=dict)
    report: WriteBackReport = field(default_factory=WriteBackReport)
    changed: bool = False


def _agree(rel: str, sha: Optional[str], target: Path, root: Path) -> dict:
    return {"sha": sha, "here": _stamp(target / rel), "there": _stamp(root / rel)}


def _plan(target: Path, root: Path, local_tree: bool, index: dict[str, str], agreed: dict[str, dict]) -> _Plan:
    """Decide every file by the three-way rule; take ``there`` in and settle ``same`` right here (file work)."""
    plan = _Plan(agreed=dict(agreed))
    for rel in sorted(_local_files(target) | set(agreed) | set(index)):
        remembered = agreed.get(rel)
        here = _fingerprint(target / rel, remembered, "here")
        # ``there``: a cache-backed source's file counts only while the index names it — a removal drops it
        # from the index, not from the disk.
        there = _fingerprint(root / rel, remembered, "there") if local_tree or rel in index else None
        decision, _ = three_way(here, there, remembered["sha"]) if remembered else three_way(here, there)
        if decision == "hold":
            plan.report.held.append(rel)
        elif decision == "here":
            (plan.remove if here is None else plan.push).append(rel)
        elif decision == "there" and there is None:
            (target / rel).unlink(missing_ok=True)
            prune_empty_dirs((target / rel).parent, target)
            plan.agreed.pop(rel, None)
            plan.report.pulled.append(rel)
        elif decision == "there":
            _copy(root / rel, target / rel)
            plan.agreed[rel] = _agree(rel, there, target, root)
            plan.report.pulled.append(rel)
        elif here is None:  # same: both gone
            plan.agreed.pop(rel, None)
        else:  # same
            plan.agreed[rel] = _agree(rel, here, target, root)
    plan.changed = plan.agreed != agreed
    return plan


async def _bytes_of(path: Path) -> AsyncIterator[bytes]:
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK):
            yield chunk


def _copy(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


async def write_back(source: "DataSource") -> Optional[WriteBackReport]:
    """Keep ``source``'s local copy and its remote in step; None for a source that does not write back.

    Runs after the pull, in the same sync: what the pull placed agrees with the cache by construction,
    so only local edits (push), remote edits a local edit kept out (hold) and stragglers remain."""
    if not writes_back(source):
        return None
    from flow_sdk.ingest.driver_runtime import read_cache_index, write_cache_index  # noqa: PLC0415
    from flow_sdk.ingest.reflect import target_root  # noqa: PLC0415
    from flow_sdk.sources.errors import SourceError, is_transient  # noqa: PLC0415

    driver = _driver_of(source)
    target, root = target_root(source), driver.tree_root(source) if driver is not None else None
    if driver is None or target is None or root is None:
        return None
    local_tree = bool(driver.cls.local_tree_key)
    index = {} if local_tree else dict(read_cache_index(root, driver.provider))
    plan = await asyncio.to_thread(_plan, target, root, local_tree, index, _read_agreed(source))
    report, agreed, index_changed = plan.report, plan.agreed, False
    if plan.push or plan.remove:
        live = await driver.open(source)
        async with live:
            for rel in plan.remove:
                try:
                    await live.delete(live.origin(index.get(rel) or rel))
                except SourceError as exc:
                    if is_transient(exc):
                        raise
                    report.refused[rel] = str(exc)
                    continue
                if not local_tree:
                    index_changed |= index.pop(rel, None) is not None
                    (root / rel).unlink(missing_ok=True)
                    prune_empty_dirs((root / rel).parent, root)
                agreed.pop(rel, None)
                report.removed.append(rel)
            for rel in plan.push:
                try:
                    item = await live.write(rel, _bytes_of(target / rel))
                except SourceError as exc:
                    if is_transient(exc):
                        raise
                    report.refused[rel] = str(exc)
                    continue
                if not local_tree:
                    _copy(target / rel, root / rel)
                    index[rel], index_changed = str(item.origin.key), True
                agreed[rel] = _agree(rel, await asyncio.to_thread(sha_of, target / rel), target, root)
                report.pushed.append(rel)
    if index_changed:
        write_cache_index(root, driver.provider, index)
    if plan.changed or report.pushed or report.removed:
        _write_agreed(source, agreed)
    if report.needs_a_person or report.pushed or report.removed:
        logger.info(
            "[write-back] %s: pushed %d, removed %d, pulled %d, held %d, refused %d",
            source.name or source.id, len(report.pushed), len(report.removed), len(report.pulled),
            len(report.held), len(report.refused),
        )
    return report


__all__ = ["WriteBackReport", "locally_edited", "sha_of", "write_back"]
