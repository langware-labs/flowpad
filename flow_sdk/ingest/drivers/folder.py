"""Folder — a local directory as a data source.

Every other driver reaches a remote system. This one reaches the filesystem,
and that is the point: Access is free, there is no credential and no network, so
it isolates the three layers that actually need proving — Address, Index and
Presence — from the one that does not (credentialed remote access).

**It returns refs, not items.** The bytes are already on disk. Reading them into
an ``IngestItem`` so the ingestor can write them back out is pure waste, and a
driver that fills ``refs`` is announcing that its destination is ``reflect``
rather than ``ingest_items``. The ``SourceItem`` chokepoint is untouched by this
driver — it never produces one.

**One scope, deliberately.** A subdirectory is a MUTABLE grouping and
``stream_key`` participates in the natural key, so keying scopes on
subdirectories reproduces the duplicate-on-move trap exactly: move a file
between folders and it becomes a second row that nothing cleans up. One scope
sidesteps it, and makes ``stream_budget`` moot.

**The manifest is the whole cursor.** ``state`` holds ``{rel_path: [mtime,
size, inode]}`` from the last pass. Diffing it is what produces deletions — and
deletions are the reason this driver enumerates at all rather than trusting a
watcher, which cannot observe what it did not receive. That is the same
enumerate-as-backstop rule a Confluence source needs for the same reason.

**It emits leaf FILES, not asset roots.** Resolving a file to the asset that
owns it is already ``reindex_paths``'s job via ``resolve_containing=True`` — a
file inside a skill folder resolves to the skill. Re-deriving that here would be
a second copy of the layout rules that ``TypeInfo`` already owns.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from flow_sdk.ingest.driver import FetchResult, SetupVerdict, StreamCursorView, StreamRef
from flow_sdk.ingest.health import SourceError

#: The single scope key. A constant rather than the root path: the root is
#: config, and a cursor keyed on it would be silently orphaned by an edit
#: instead of diffing against it.
ROOT_STREAM = "root"

#: Directory names never descended. Not a .gitignore implementation — the
#: indexer already owns that for the walk it does. This is the minimum that
#: keeps a poll from enumerating a dependency tree.
_SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv"}


def _iter_files(root: Path) -> Iterator[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            yield Path(dirpath) / name


def _manifest(root: Path) -> dict:
    """``{rel_path: [mtime, size, inode]}`` for everything under ``root``.

    mtime+size rather than a content hash: it is what the filesystem indexer's
    own freshness check uses, so a source that disagreed with it would make
    every reflected file look changed on the pass after it was written.
    """
    out: dict = {}
    for path in _iter_files(root):
        try:
            st = path.stat()
        except OSError:
            continue
        out[str(path.relative_to(root))] = [int(st.st_mtime), st.st_size, st.st_ino]
    return out


class FolderDriver:
    provider = "folder"
    kind = "datasource.fs.folder"
    #: Declared for protocol symmetry only. Nothing stamps it, because this
    #: driver never produces an IngestItem — its payload lands as files.
    record_kind = ""

    def source_root(self, source):
        """The watched directory — the base every ref is relative to."""
        raw = (source.config or {}).get("root") or ""
        return Path(raw).expanduser().resolve() if raw else None

    def origin_id_for(self, source, ref: str) -> str:
        """The filesystem's own handle for this file: its inode.

        What a plain folder can promise, and no more. It survives a rename or a
        move within the volume — the thing a path cannot — which is why it beats
        the path fallback here.

        The handle is re-read after every index pass (`reflect._stamp_origin`),
        and that is load-bearing rather than tidy: indexing a portable asset
        rewrites the file to stamp its capsule, atomically (temp file, rename
        over), so the inode moves. A handle read once would drift on the next
        poll.

        Two honest limits, both inherent. An editor that saves atomically mints
        a new inode and is read as a new file. And an inode means nothing off
        its volume — hence the source scoping, and hence never sharing it.
        """
        st = Path(ref).stat()  # OSError → the caller falls back to the path
        return f"{self.provider}:{source.id}:ino:{st.st_dev}:{st.st_ino}"

    def streams(self, source) -> list[StreamRef]:
        root = (source.config or {}).get("root") or ""
        return [StreamRef(key=ROOT_STREAM, label=str(root))] if root else []

    async def verify(self, source) -> SetupVerdict:
        """Can this source actually read what it was configured for?

        Distinct from health: this answers "is the setup finished", and for a
        folder the unfinished states are a human's to fix — a path that does not
        exist yet, or one the process cannot read.
        """
        raw = (source.config or {}).get("root") or ""
        if not raw:
            return SetupVerdict.waiting("Set the folder to watch.")
        root = Path(raw).expanduser().resolve()
        if not root.exists():
            return SetupVerdict.waiting(f"{root} does not exist yet.")
        if not root.is_dir():
            return SetupVerdict.waiting(f"{root} is a file, not a folder.")
        if not os.access(root, os.R_OK | os.X_OK):
            return SetupVerdict.waiting(f"{root} is not readable.")
        return SetupVerdict.ok()

    async def fetch(self, source, cursor: StreamCursorView) -> FetchResult:
        raw = (source.config or {}).get("root") or ""
        if not raw:
            raise SourceError.config("no_root", "config.root is not set")
        # ``resolve()``, not just ``expanduser()``. On macOS ``/var`` is a
        # symlink to ``/private/var``, and ``discover_record_by_path`` compares
        # the caller's path against the one the parsed record carries — which is
        # resolved. Hand it an unresolved path and the comparison silently
        # fails, the targeted parse is discarded, and it falls back to a full
        # RecordList scan that finds nothing. A source announcing a ref must
        # announce a canonical one.
        root = Path(raw).expanduser().resolve()
        if not root.is_dir():
            # Config error, not transient: a missing root needs a person, and
            # retrying every minute would only re-learn that.
            raise SourceError.config("root_missing", f"{root} is not a directory")

        current = _manifest(root)
        previous = dict(cursor.state or {})

        # A first run has no manifest to diff, so everything present is new.
        changed = [rel for rel, stamp in current.items() if previous.get(rel) != stamp]

        # ── a MOVE is not a deletion ──────────────────────────────────────
        #
        # A path that vanished whose INODE reappeared elsewhere was renamed, not
        # deleted. Only the driver can tell the difference: it is the one thing
        # holding both the previous manifest and the current one. Reporting it
        # as a tombstone would delete the row and let the new path mint a fresh
        # one — the same asset, forked, with everything pointing at it dangling.
        #
        # Inodes are stable across a rename within a volume, which is precisely
        # the case this distinguishes. An editor that saves atomically produces a
        # new inode and is honestly reported as a new file.
        live_inodes = {stamp[2] for stamp in current.values()}
        removed = [
            rel
            for rel, stamp in previous.items()
            if rel not in current and stamp[2] not in live_inodes
        ]

        return FetchResult(
            refs=[str(root / rel) for rel in changed],
            tombstones=[str(root / rel) for rel in removed],
            next_state=current,
            high_water=str(len(current)),
            unchanged=not changed and not removed,
        )
