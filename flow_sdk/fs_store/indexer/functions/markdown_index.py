"""Extractor + SchemaRegistry registration for MARKDOWN_INDEX records.

A ``MARKDOWN_INDEX`` record IS an ``index.md`` file produced by the rebuild
AgenticProcess.  This module:

  1. Provides ``extract_markdown_index`` — an FSRef → list[FSRecord] parser
     that reads an ``index.md`` file and returns its record.  Registered as
     ``TypeInfo.parser_fn`` so the indexer can (re-)parse an index.md that
     already exists on disk (e.g. after a restart).

  2. Provides ``markdown_index_id`` / ``markdown_index_gen_id`` — id helpers
     using the same uuid5(NAMESPACE_URL, resolved_path) formula as the base
     Record default, kept here for explicitness and documentation.

  3. Calls ``SchemaRegistry.register`` with the same metadata that
     ``MarkdownIndexRecord.__init_subclass__`` used to emit automatically.

System entity — not crawled by the default indexer and not surfaced in the
records browser (``indexed_by_default=False``, ``browseable=False``).
The rebuild AgenticProcess is the only writer; callers use
``flow_sdk.fs_store.operations.markdown_index.from_markdown`` to parse.
"""

from __future__ import annotations

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef

# ── Id helpers ────────────────────────────────────────────────────────────────

def markdown_index_id(ref: FSRef) -> str:
    """Derive the record id for an index.md file.

    Uses the same uuid5(NAMESPACE_URL, resolved_path) formula as the base
    ``Record.getId`` default.  Exposed here for tests + explicitness.
    """
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(ref._path.resolve()))

def markdown_index_gen_id(ref: FSRef) -> str:
    """Id mint for MARKDOWN_INDEX — same formula as getId (no frontmatter write).

    The rebuild agent always writes the id into frontmatter itself; this
    function just returns the deterministic uuid5 without mutating the file.
    """
    return markdown_index_id(ref)

# ── Extractor ─────────────────────────────────────────────────────────────────

def extract_markdown_index(ref: FSRef) -> list[FSRecord]:
    """Parse an ``index.md`` file into a MARKDOWN_INDEX Record.

    Delegates to ``from_markdown`` in the operations module so the parse
    logic is not duplicated.
    """
    path = ref._path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    from flow_sdk.fs_store.operations.markdown_index import from_markdown  # noqa: PLC0415
    rec = from_markdown(text, path=path)
    return [rec]
