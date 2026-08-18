"""VIBE-002 contract: an ``.html`` file must never index as a MARKDOWN record.

When the vibe sub-agent is asked to open an existing ``public/open-me.html``, one
observed failure ran ``flow record index <file>.html --types markdown``. That
routes to ``discover_record_by_path("markdown", …)`` → ``extract_markdown``,
which reads any UTF-8 text file and emits a MARKDOWN record — with no check that
the file is actually ``.md``. The HTML page is minted as a ``markdown-<uuid5>``
entity and opened as raw source in a code editor instead of rendering via the
Display's ``HtmlPreview``.

The markdown *walker* only globs ``*.md``, so this only bites on the targeted
single-file index path that bypasses the glob. The guard belongs in the
extractor itself. Real filesystem, no mocks, fast.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown
from flow_sdk.fs_store.record_types import RecordType

_HTML = (
    "<!doctype html><html><body>"
    "<h1>VW03_HTML_READY</h1>"
    "<button id='activate'>Go</button>"
    "</body></html>"
)


def test_html_file_does_not_extract_as_markdown(tmp_path: Path) -> None:
    """An ``.html`` file (valid UTF-8) must yield no MARKDOWN record."""
    html = tmp_path / "open-me.html"
    html.write_text(_HTML, encoding="utf-8")

    recs = extract_markdown(
        FSRef(str(html), record_type=RecordType.MARKDOWN),
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    )

    assert recs == [], f"HTML indexed as markdown: {[getattr(r, 'name', None) for r in recs]}"


def test_real_markdown_still_extracts(tmp_path: Path) -> None:
    """Guard must not regress the happy path: a ``.md`` file still parses."""
    md = tmp_path / "note.md"
    md.write_text("# Title\n\nbody\n", encoding="utf-8")

    recs = extract_markdown(
        FSRef(str(md), record_type=RecordType.MARKDOWN),
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    )

    assert len(recs) == 1
    assert recs[0].type == RecordType.MARKDOWN
