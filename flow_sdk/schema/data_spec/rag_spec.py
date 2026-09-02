"""The two values a RAG index passes around: a chunk going in, a hit coming out.

Both are ``DataSpec`` — frozen and ``extra="forbid"`` from the base — because they cross a
process boundary. A RAG implementation is a script in an asset folder, called over the module
protocol (``flow_sdk/utils/module_rpc.py``), so these shapes are literally what gets serialized
to JSON and back. A misspelled key must fail on arrival rather than yield a hit with no text.

Stdlib + pydantic only, like the rest of ``data_spec`` — ``spec.py`` must stay importable from
``flow_sdk/builtin/*`` with no cycle. That is why the digests below are computed here rather
than through ``llm_index.core.sha256_bytes``, which is the repo's content-hash primitive: that
module imports the gitignore walker, and reaching for it from this layer would invert the
dependency. Two call sites, one convention; if the digest ever changes, both live in this file.
"""

from __future__ import annotations

import hashlib
from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec

#: Separator inside a hashed identity. NUL cannot occur in any of the parts, so
#: ``("a/b", "c")`` and ``("a", "b/c")`` cannot collide the way a "/" join would let them.
_SEP = "\x00"


class RagChunk(DataSpec):
    """One retrievable unit of a document.

    ``chunk_id`` is derived from the document, the heading path and the TEXT — deliberately not
    from the file's content hash, and deliberately not from ``ordinal``:

    * hashing the file's content hash would give every chunk in a file a new id after any edit,
      so a one-word fix re-embeds the whole document;
    * hashing the ordinal would do the same to everything below an inserted paragraph.

    Keying on the text means an untouched section keeps its id no matter what happened around
    it, which is what lets a re-index embed only what actually changed. ``doc_ref`` is in there
    so the same boilerplate in two files stays two chunks, each resolvable back to its document.
    """

    spec_kind: ClassVar[str] = "rag.chunk"

    chunk_id: str
    #: Path relative to the index root. The stable name of the document.
    doc_ref: str
    #: The document's content hash at the time this chunk was cut. Carried for provenance and
    #: for whole-file skip decisions; NOT part of ``chunk_id``.
    doc_hash: str = ""
    #: Position within the document. For ordering and display only.
    ordinal: int = 0
    #: Ancestor headings, outermost first, ending with this section's own.
    heading_path: list[str] = []
    text: str
    #: ``sha256`` of the text alone — the embedding cache key. Two identical sections in
    #: different documents are two chunks but one embedding.
    text_hash: str = ""
    token_count: int = 0

    @staticmethod
    def make_id(doc_ref: str, heading_path: list[str], text: str) -> str:
        raw = _SEP.join([doc_ref, _SEP.join(heading_path), text])
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def make_text_hash(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()


class RagHit(DataSpec):
    """One search result. What a worker reads and cites."""

    spec_kind: ClassVar[str] = "rag.hit"

    chunk_id: str = ""
    doc_ref: str
    heading_path: list[str] = []
    text: str
    #: Higher is better, whatever the backend's metric. Comparable only within one response.
    score: float = 0.0


__all__ = ["RagChunk", "RagHit"]
