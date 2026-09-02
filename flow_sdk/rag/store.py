"""The vector store: usearch for the vectors, SQLite for everything a hit needs to say.

Two files in one directory, because neither half can answer a query alone. usearch holds the
vectors and answers "which keys are nearest"; its keys are **integers**, and it stores nothing
else. The SQLite sidecar maps those integers back to a chunk id, the document it came from, its
heading path and its text — the parts a citation is made of.

**Incremental by construction.** A chunk id is a function of its text and where it sits (see
``RagChunk``), so re-indexing an untouched document produces ids the store already has and
embeds nothing. ``add`` skips ids it knows; ``remove_document`` takes a whole file's chunks out
in one statement. Nothing here ever rebuilds from scratch.

Contrast ``flow_sdk/builtin/knowledge_base/`` — the other usearch user in this process. It
gzips its whole index into one entity blob and re-adds every vector on any change, which is
why this is a separate store rather than an extension of it. It is NOT superseded by this
module: it is still a registered entity with live HTTP actions, and nothing here replaces it.

**Dimensions are pinned at creation.** A vector of a different width is not a smaller answer,
it is a different space, and mixing two is silently meaningless. The store records its model
and width on first write and refuses anything else, so changing either is an explicit rebuild.

No entity, no network, no async. A RAG script imports this.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Sequence

from flow_sdk.db.drivers.sqlite.connection import open_sqlite
from flow_sdk.schema.data_spec.rag_spec import RagChunk, RagHit

#: Filenames inside the store directory. Fixed rather than configurable: a store is opened by
#: directory, and an author debugging one wants paths they can predict.
INDEX_FILE = "index.usearch"
DB_FILE = "chunks.sqlite"

#: Cosine, so a distance of 0 is identical and the score below is ``1 - distance``. Chosen over
#: L2 because embedding models are trained for it and because it is scale-free — a longer chunk
#: does not become a worse match for having more words in it.
METRIC = "cos"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    key         INTEGER PRIMARY KEY,
    chunk_id    TEXT NOT NULL UNIQUE,
    doc_ref     TEXT NOT NULL,
    doc_hash    TEXT NOT NULL DEFAULT '',
    ordinal     INTEGER NOT NULL DEFAULT 0,
    heading_path TEXT NOT NULL DEFAULT '[]',
    text        TEXT NOT NULL,
    text_hash   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_chunks_doc_hash ON chunks(doc_ref, doc_hash);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class DimensionMismatch(ValueError):
    """A vector of a width this store was not built for. Rebuild, do not mix."""


class RagStore:
    """One index over one folder. Open it by directory; close it when done."""

    def __init__(self, directory: Path | str) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        # ``open_sqlite``, not ``sqlite3.connect``: it is the one sanctioned seam in
        # ``flow_sdk/`` and carries the house pragmas — WAL, ``synchronous=NORMAL``, mmap, and
        # a percent-encoded ``file:`` URI that survives a directory with a ``?`` or ``#`` in
        # its name. Mixing pragma configurations across handles on one file is a documented
        # SQLite corruption vector, so this is not a preference. It also sets ``row_factory``.
        # Precedent for a standalone sidecar DB: ``flow_sdk/dep_graph/db.py``.
        self._db = open_sqlite(self.dir / DB_FILE)
        self._db.executescript(_SCHEMA)
        self._index = None  # built lazily: opening needs the width, which meta may not hold yet

    # ── lifecycle ───────────────────────────────────────────────────────────

    def flush(self) -> None:
        """Persist the index and commit the sidecar.

        Explicit, because saving is a whole-file rewrite of the usearch index — 127 ms and
        84 MB at fifty thousand vectors. Flushing inside every ``add`` made the bytes written
        quadratic in document count: indexing five hundred files one at a time rewrote a
        growing file five hundred times. Callers batch a build and flush once; ``close`` (and
        so the context manager) flushes for them.
        """
        if self._index is not None:
            self._index.save(str(self.dir / INDEX_FILE))
        self._db.commit()

    def close(self) -> None:
        self.flush()
        self._db.close()

    def __enter__(self) -> "RagStore":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    # ── metadata ────────────────────────────────────────────────────────────

    def _get_meta(self, key: str) -> str:
        row = self._db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return row["v"] if row else ""

    def _set_meta(self, key: str, value: str) -> None:
        self._db.execute("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                         (key, str(value)))

    @property
    def dimensions(self) -> int:
        raw = self._get_meta("dimensions")
        return int(raw) if raw else 0

    @property
    def model(self) -> str:
        return self._get_meta("model")

    @property
    def tree_hash(self) -> str:
        """The corpus hash this store currently reflects. The freshness comparison."""
        return self._get_meta("tree_hash")

    def stamp(self, *, tree_hash: str) -> None:
        self._set_meta("tree_hash", tree_hash)
        self._db.commit()

    # ── the usearch half ────────────────────────────────────────────────────

    def _open_index(self):
        """The usearch handle, opened on first use — the width is unknown until the first add."""
        from usearch.index import Index  # noqa: PLC0415

        if self._index is not None:
            return self._index
        index = Index(ndim=self.dimensions, metric=METRIC, dtype="f32")
        path = self.dir / INDEX_FILE
        if path.exists():
            index.load(str(path))
        self._index = index
        return index

    # ── reads ───────────────────────────────────────────────────────────────

    def _existing_ids(self, chunk_ids: Sequence[str]) -> set[str]:
        """Which of *chunk_ids* the store already holds.

        Scoped to the batch, deliberately. Selecting every id in the store to test forty of
        them materialized a five-megabyte set of digests per call at fifty thousand chunks,
        and the cost grew with the store rather than with the work.
        """
        if not chunk_ids:
            return set()
        placeholders = ",".join("?" * len(chunk_ids))
        rows = self._db.execute(f"SELECT chunk_id FROM chunks WHERE chunk_id IN ({placeholders})", list(chunk_ids))
        return {r["chunk_id"] for r in rows}

    def document_hashes(self) -> dict[str, str]:
        """``doc_ref -> doc_hash`` as last indexed. Lets a caller skip whole files.

        Answered from ``ix_chunks_doc_hash`` without touching the table, which is why that
        index carries ``doc_hash`` as well as ``doc_ref``.
        """
        rows = self._db.execute("SELECT doc_ref, MAX(doc_hash) AS h FROM chunks GROUP BY doc_ref")
        return {r["doc_ref"]: r["h"] or "" for r in rows}

    def document_refs(self) -> set[str]:
        """Every document with chunks here. One fact, one query — see ``document_hashes``."""
        return set(self.document_hashes())

    def chunk_count(self) -> int:
        return int(self._db.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"])

    # ── writes ──────────────────────────────────────────────────────────────

    def add(self, chunks: Sequence[RagChunk], vectors: Sequence[Sequence[float]], *, model: str = "") -> int:
        """Store chunks and their vectors, skipping ids already present. Returns the number added.

        Skipping rather than replacing is deliberate: an id that already exists describes text
        that has not changed, so its vector is the same vector. Re-adding would burn an
        embedding to write an identical row.
        """
        import numpy as np  # noqa: PLC0415

        if len(chunks) != len(vectors):
            raise ValueError(f"{len(chunks)} chunks but {len(vectors)} vectors")
        if not chunks:
            return 0

        width = len(vectors[0])
        if any(len(v) != width for v in vectors):
            raise DimensionMismatch("the batch mixes vector widths")
        pinned = self.dimensions
        if pinned and width != pinned:
            raise DimensionMismatch(
                f"this store holds {pinned}-dimension vectors and was handed {width}; "
                f"changing the embedding model is a rebuild, not a top-up"
            )
        if not pinned:
            self._set_meta("dimensions", str(width))
            if model:
                self._set_meta("model", model)

        known = self._existing_ids([c.chunk_id for c in chunks])
        fresh = [(c, v) for c, v in zip(chunks, vectors) if c.chunk_id not in known]
        if not fresh:
            return 0

        index = self._open_index()
        row = self._db.execute("SELECT COALESCE(MAX(key), 0) AS m FROM chunks").fetchone()
        next_key = int(row["m"]) + 1

        keys, rows = [], []
        for offset, (chunk, _) in enumerate(fresh):
            key = next_key + offset
            keys.append(key)
            rows.append((key, chunk.chunk_id, chunk.doc_ref, chunk.doc_hash, chunk.ordinal,
                         json.dumps(chunk.heading_path), chunk.text, chunk.text_hash))
        self._db.executemany(
            "INSERT INTO chunks(key, chunk_id, doc_ref, doc_hash, ordinal, heading_path, text, text_hash) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        index.add(np.array(keys, dtype=np.uint64),
                  np.array([v for _, v in fresh], dtype=np.float32))
        return len(fresh)

    def remove_document(self, doc_ref: str) -> int:
        """Drop every chunk of one document. Returns how many went."""
        rows = self._db.execute("SELECT key FROM chunks WHERE doc_ref = ?", (doc_ref,)).fetchall()
        if not rows:
            return 0
        if self.dimensions:
            index = self._open_index()
            for row in rows:
                try:
                    index.remove(int(row["key"]))
                except Exception:  # noqa: BLE001 -- a key the index never held is already gone
                    pass
        self._db.execute("DELETE FROM chunks WHERE doc_ref = ?", (doc_ref,))
        return len(rows)

    def prune_to(self, doc_refs: Iterable[str]) -> int:
        """Remove documents no longer in the corpus. Returns chunks removed."""
        keep = set(doc_refs)
        removed = sum(self.remove_document(ref) for ref in self.document_refs() - keep)
        self.flush()
        return removed

    # ── search ──────────────────────────────────────────────────────────────

    def search(self, vector: Sequence[float], *, top_k: int = 8) -> list[RagHit]:
        """Nearest chunks, best first. Empty when the store holds nothing."""
        import numpy as np  # noqa: PLC0415

        pinned = self.dimensions
        if not pinned:
            return []
        if len(vector) != pinned:
            raise DimensionMismatch(f"this store holds {pinned}-dimension vectors and was queried with {len(vector)}")

        index = self._open_index()
        matches = index.search(np.array(vector, dtype=np.float32), top_k)
        keys = [int(k) for k in matches.keys]
        if not keys:
            return []

        # One lookup for the whole page rather than one per hit. Rows come back unordered, so
        # they are reassembled against usearch's ranking rather than read in row order.
        placeholders = ",".join("?" * len(keys))
        by_key = {
            int(r["key"]): r
            for r in self._db.execute(f"SELECT * FROM chunks WHERE key IN ({placeholders})", keys)
        }
        hits: list[RagHit] = []
        for key, distance in zip(keys, matches.distances):
            row = by_key.get(key)
            if row is None:  # removed since the index was written; skip rather than fabricate
                continue
            hits.append(
                RagHit(
                    chunk_id=row["chunk_id"],
                    doc_ref=row["doc_ref"],
                    heading_path=json.loads(row["heading_path"]),
                    text=row["text"],
                    # Cosine distance runs 0 (identical) to 2 (opposite); a score that rises
                    # with relevance is what every caller expects to sort by.
                    score=1.0 - float(distance),
                )
            )
        return hits


# ``INDEX_FILE``, ``DB_FILE`` and ``METRIC`` are usearch facts and stay private to this
# module: a second backend has no ``index.usearch`` and need not measure in cosine. What is
# public is the store's shape — chunks in, hits out.
__all__ = ["DimensionMismatch", "RagStore"]
