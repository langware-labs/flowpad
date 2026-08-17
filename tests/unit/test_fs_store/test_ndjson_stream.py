"""The candidate wire format round-trips losslessly.

``ndjson_stream`` is the one dialect both out-of-process children speak (the Rust
binary and the Python scan child), so its encode/decode pair is where a dropped
or mis-coerced field would silently corrupt a scan.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.ndjson_stream import (
    candidate_from_fsref,
    candidates_with_parents,
    fsref_from_candidate,
    fsrefs_from_candidates,
)
from flow_sdk.fs_store.record_types import RecordType

pytestmark = pytest.mark.timeout(10)


def _key(r: FSRef) -> tuple:
    return (r.path, r.record_type, r.scope, r.project_id, r.json_path, r.read_only)


def test_round_trip_preserves_every_field(tmp_path: Path) -> None:
    refs = [
        FSRef(
            tmp_path / "SKILL.md",
            record_type=RecordType.SKILL,
            scope="project",
            project_id="pid-1",
        ),
        FSRef(
            tmp_path / ".mcp.json",
            record_type=RecordType.MCP_SERVER,
            scope="user",
            json_path="/mcpServers/one",
        ),
        FSRef(tmp_path / "ro.md", record_type=RecordType.MARKDOWN, read_only=True),
        FSRef(tmp_path / "bare.md"),
    ]
    got = fsrefs_from_candidates([candidate_from_fsref(r) for r in refs])
    assert [_key(r) for r in got] == [_key(r) for r in refs]


def test_parent_links_round_trip(tmp_path: Path) -> None:
    """``_parent`` must survive, because ``index()`` derives parenting from it.

    ``ref_typeid(ref._parent)`` is what sets a received asset's
    ``parent_type_id``; a format that only carried the resolved scope fields would
    silently unparent everything.
    """
    root = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id="p1")
    mid = FSRef(tmp_path / "docs", record_type=RecordType.FOLDER, parent=root)
    leaf = FSRef(tmp_path / "docs" / "a.md", record_type=RecordType.MARKDOWN, parent=mid)

    got = fsrefs_from_candidates(candidates_with_parents([root, mid, leaf]))

    assert got[0]._parent is None
    assert got[1]._parent is got[0], "an in-stream parent links by index"
    assert got[2]._parent is got[1]
    assert got[2]._parent._parent is got[0], "the whole chain is walkable"


def test_out_of_stream_parent_is_inlined(tmp_path: Path) -> None:
    """A parent that isn't itself a candidate still has to resolve.

    Only its identity matters — that is all the enclosure derivation reads.
    """
    absent = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD, scope="project")
    leaf = FSRef(tmp_path / "a.md", record_type=RecordType.MARKDOWN, parent=absent)

    (got,) = fsrefs_from_candidates(candidates_with_parents([leaf]))

    assert got._parent is not None
    assert got._parent.path == absent.path
    assert got._parent.record_type is RecordType.REAL_PROJECT_CWD


def test_a_producer_without_parent_fields_decodes_parentless(tmp_path: Path) -> None:
    """The Rust binary's existing 5-field contract keeps working unchanged."""
    (got,) = fsrefs_from_candidates(
        [{"path": str(tmp_path / "a.md"), "record_type": "markdown", "scope": "user"}]
    )
    assert got._parent is None
    assert got.scope == "user"


def test_inherited_values_are_resolved_before_encoding(tmp_path: Path) -> None:
    """The child has no parent chain, so the encoder must emit resolved values.

    ``scope`` / ``project_id`` / ``read_only`` exist as parent-walking properties;
    a leaf that inherits them would come back bare if the encoder read the private
    fields instead.
    """
    root = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id="p9")
    leaf = FSRef(tmp_path / "n.md", record_type=RecordType.MARKDOWN, parent=root)
    assert (leaf.scope, leaf.project_id) == ("project", "p9")  # inherited, not set

    decoded = fsref_from_candidate(candidate_from_fsref(leaf))
    assert (decoded.scope, decoded.project_id) == ("project", "p9")


def test_read_only_is_inherited_and_survives(tmp_path: Path) -> None:
    root = FSRef(tmp_path, read_only=True)
    leaf = FSRef(tmp_path / "x.md", record_type=RecordType.MARKDOWN, parent=root)
    assert leaf.read_only is True

    assert fsref_from_candidate(candidate_from_fsref(leaf)).read_only is True


@pytest.mark.parametrize("blank", ["", None])
def test_blank_optionals_decode_to_none(tmp_path: Path, blank) -> None:
    """The Rust binary emits ``""`` where Python emits ``null``; both mean absent.

    Downstream code tests these with ``is None``, so an empty string leaking
    through would read as a real value.
    """
    decoded = fsref_from_candidate(
        {
            "path": str(tmp_path / "a.md"),
            "record_type": "markdown",
            "scope": blank,
            "project_id": blank,
            "json_path": blank,
        }
    )
    assert decoded.scope is None
    assert decoded.project_id is None
    assert decoded.json_path is None


def test_unknown_record_type_degrades_to_none(tmp_path: Path) -> None:
    """A type this build doesn't know must not abort the whole stream."""
    decoded = fsref_from_candidate(
        {"path": str(tmp_path / "a.md"), "record_type": "not_a_real_type"}
    )
    assert decoded.record_type is None


