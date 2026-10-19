"""DocumentReader conformance — frontmatter, capsule strip and revision (spec §4).

``read_document_bytes`` is the oracle: a value carries exactly what it returns,
and the exceptions it raises for one file arrive as that file's ``error``.
"""
from __future__ import annotations

import hashlib

import pytest

from flow_sdk.assets.document import read_document_bytes
from flow_sdk.capsules.errors import CapsuleError
from flow_sdk.diskio.contract import DocumentReader
from tests.unit.diskio._backends import backends, drain

CAPSULE = "<!-- flowpad:capsule identity\nid: 11111111-1111-4111-8111-111111111111\nflowpad:endcapsule identity -->"


@pytest.fixture(params=backends(DocumentReader))
def reader(request):
    return request.param()


def read(reader, text: str):
    doc = reader.read_bytes(text.encode("utf-8"))
    assert doc.path == "" and doc.error is None
    oracle = read_document_bytes(text.encode("utf-8"))
    assert (doc.raw_text, doc.body, doc.fields, doc.body_start_line, doc.metadata_error, doc.revision) == (
        oracle.raw_text, oracle.body, oracle.fields, oracle.body_start_line, oracle.metadata_error, oracle.revision,
    )
    return doc


def test_no_header(reader):
    doc = read(reader, "# Title\n\nbody\n")
    assert doc.fields == {} and doc.body == "# Title\n\nbody\n"
    assert doc.body_start_line == 1 and doc.metadata_error is None


def test_header_fields_and_body_start_line(reader):
    doc = read(reader, "---\ntitle: Hello\ntags: [a, b]\ncount: 3\n---\nbody\n")
    assert doc.fields == {"title": "Hello", "tags": ["a", "b"], "count": 3}
    assert doc.body == "body\n" and doc.body_start_line == 6


def test_crlf_header(reader):
    doc = read(reader, "---\r\ntitle: Hello\r\n---\r\nline one\r\n")
    assert doc.fields == {"title": "Hello"}
    assert doc.body == "line one\r\n" and doc.body_start_line == 4
    assert doc.raw_text.startswith("---\r\n")


def test_the_fence_may_carry_whitespace(reader):
    assert read(reader, "---  \ntitle: x\n ---\nbody").fields == {"title": "x"}


def test_unclosed_header(reader):
    doc = read(reader, "---\ntitle: Hello\nbody without a closing fence\n")
    assert doc.metadata_error == "Unclosed YAML frontmatter"
    assert doc.fields == {} and doc.body == doc.raw_text and doc.body_start_line == 1


def test_duplicate_key(reader):
    doc = read(reader, "---\ntitle: a\ntitle: b\n---\nbody\n")
    assert doc.metadata_error == "Duplicate document metadata key"
    assert doc.fields == {} and doc.body == "body\n" and doc.body_start_line == 5


def test_a_key_that_is_not_a_string(reader):
    assert read(reader, "---\n1: a\n---\n").metadata_error == "Document metadata keys must be strings"


def test_a_header_that_is_not_a_mapping(reader):
    doc = read(reader, "---\n- a\n- b\n---\nbody\n")
    assert doc.metadata_error == "Document frontmatter must be a mapping" and doc.fields == {}


def test_broken_yaml_is_a_metadata_error_and_the_body_survives(reader):
    doc = read(reader, "---\ntitle: [unclosed\n---\nbody\n")
    assert doc.metadata_error and doc.fields == {} and doc.body == "body\n"


def test_an_empty_header(reader):
    doc = read(reader, "---\n---\nbody\n")
    assert doc.fields == {} and doc.metadata_error is None and doc.body_start_line == 3


def test_merge_keys_are_flattened(reader):
    doc = read(reader, "---\nbase: &b {x: 1}\nchild:\n  <<: *b\n  y: 2\n---\n")
    assert doc.fields["child"] == {"x": 1, "y": 2}


def test_a_capsule_block_is_stripped_from_the_body_and_kept_in_the_raw_text(reader):
    doc = read(reader, f"---\ntitle: x\n---\nbody\n\n{CAPSULE}\n")
    assert "flowpad:capsule" not in doc.body and doc.body.startswith("body\n")
    assert CAPSULE in doc.raw_text


def test_revision_is_the_sha256_of_the_raw_bytes(reader):
    data = "---\ntitle: x\n---\nbödy\n".encode("utf-8")
    assert reader.read_bytes(data).revision == "sha256:" + hashlib.sha256(data).hexdigest()


def test_bytes_that_are_not_utf8_are_a_decode_error(reader):
    data = b"---\ntitle: x\n---\n\xff\xfe"
    doc = reader.read_bytes(data)
    assert doc.error is not None and doc.error.kind == "decode" and doc.error.path == ""
    assert doc.fields == {} and doc.revision == "sha256:" + hashlib.sha256(data).hexdigest()
    with pytest.raises(UnicodeDecodeError):
        read_document_bytes(data)


def test_a_malformed_capsule_is_a_capsule_error(reader):
    text = "body\n\n<!-- flowpad:capsule identity\nid: x\n"
    with pytest.raises(CapsuleError):
        read_document_bytes(text.encode("utf-8"))
    doc = reader.read_bytes(text.encode("utf-8"))
    assert doc.error is not None and doc.error.kind == "capsule"


def test_read_is_one_value_per_path_and_a_missing_file_is_an_item_not_an_exception(reader, tmp_path):
    good = tmp_path / "good.md"
    good.write_bytes(b"---\ntitle: g\n---\nbody\n")
    bad = tmp_path / "bad.md"
    bad.write_bytes(b"\xff")
    missing = tmp_path / "missing.md"
    body, end = drain(reader.read([str(good), str(missing), str(bad)]))
    assert end.counts == {"diskio.document_read": 3}
    by_path = {doc.path: doc for doc in body}
    assert by_path[str(good)].fields == {"title": "g"} and by_path[str(good)].error is None
    assert by_path[str(good)].revision == read_document_bytes(good.read_bytes()).revision
    assert (by_path[str(missing)].error.kind, by_path[str(missing)].error.detail) == ("unreadable", "ENOENT")
    assert by_path[str(missing)].error.path == str(missing)
    assert by_path[str(bad)].error.kind == "decode"


def test_an_empty_batch_is_only_the_terminal(reader):
    body, end = drain(reader.read([]))
    assert body == [] and end.counts == {}
