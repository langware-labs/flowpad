"""macOS zip-extraction junk must never be indexed as markdown.

A zip created on macOS and unzipped elsewhere leaves an ``__MACOSX/`` tree of
AppleDouble (``._foo.md``) resource-fork sidecars. These are binary, share the
``.md`` extension, and previously made the indexer raise ``UnicodeDecodeError``
inside ``extract_markdown`` — which the per-record loop swallowed into a silent
``errors += 1``. The folder showed fewer markdowns than the user expected with
no visible reason.

This pins the fix at two layers:
  - the walker prunes ``__MACOSX`` and the ``markdown_*`` emitters skip ``._*``,
    so AppleDouble files never become MARKDOWN refs; and
  - ``extract_markdown`` returns ``[]`` (not raise) on non-UTF-8 content, so any
    binary-under-.md anywhere is skipped cleanly rather than counted as an error.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions, build_default_indexer
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# Faithful AppleDouble bytes: the real ``._*.md`` header (00 05 16 07 …) plus an
# invalid-UTF-8 byte (0xa9) — matching an on-disk sample that raised
# ``UnicodeDecodeError: invalid start byte`` at position 37.
_APPLEDOUBLE = (
    bytes([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00])
    + b"Mac OS X        "
    + bytes([0x00, 0x02, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00])
    + b"\xa9\xfe\x80\x81 resource fork \x00\x00"
)


def _make_tree(root: Path) -> Path:
    """A project tree with one real markdown and a macOS __MACOSX/._*.md junk file."""
    (root / "docs").mkdir(parents=True)
    real = root / "docs" / "report.md"
    real.write_text("# Real\n\nbody\n", encoding="utf-8")

    junk_dir = root / "docs" / "_extracted" / "__MACOSX" / "reports"
    junk_dir.mkdir(parents=True)
    (junk_dir / "._report.md").write_bytes(_APPLEDOUBLE)
    # A stray AppleDouble sidecar NOT under __MACOSX (the ._ skip must catch it too).
    (root / "docs" / "._report.md").write_bytes(_APPLEDOUBLE)
    return real


@pytest.mark.asyncio
async def test_macosx_appledouble_not_indexed_as_markdown(tmp_path: Path) -> None:
    real = _make_tree(tmp_path)

    indexer = build_default_indexer()
    refs = await indexer.scan(IndexerOptions(
        verbose=False,
        roots=(FSRef(
            tmp_path,
            record_type=RecordType.REAL_PROJECT_CWD,
            scope="project",
            project_id="test-pid",
        ),),
        gitignore=True,
        project_id="test-pid",
    ))

    md_paths = {Path(r.path).resolve() for r in refs if r.record_type == RecordType.MARKDOWN}
    folder_paths = [r.path for r in refs if r.record_type == RecordType.FOLDER]

    assert real.resolve() in md_paths, "the real markdown should be discovered"
    assert not any(p.name.startswith("._") for p in md_paths), (
        f"AppleDouble ._*.md leaked into MARKDOWN refs: {sorted(str(p) for p in md_paths)}"
    )
    assert not any("__MACOSX" in p for p in folder_paths), (
        "__MACOSX dir was walked — should be pruned by _WALK_IGNORED"
    )


def test_extract_markdown_returns_empty_on_binary(tmp_path: Path) -> None:
    """Defense in depth: binary content under .md yields [] instead of raising."""
    p = tmp_path / "binary.md"
    p.write_bytes(_APPLEDOUBLE)
    assert SchemaRegistry.get("markdown").from_disk_fn(
        FSRef(p, record_type=RecordType.MARKDOWN),
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ) == []
