"""Real filesystem document edits, including stale and competing writers."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from flow_sdk.assets.document import DocumentConflict, DocumentPatch, read_document, update_document


def test_body_edit_preserves_exact_header_and_structured_fields(tmp_path):
    path = tmp_path / "skill.md"
    header = b'---\r\n# keep comment\r\ntags:\r\n  - one\r\nnested: {enabled: true}\r\ndescription: |\r\n  line one\r\n  line two\r\n---\r\n'
    path.write_bytes(header + b'\r\nold body\r\n')
    before = read_document(path)
    after = update_document(path, DocumentPatch(body="new body\r\n"), expected_revision=before.revision)
    assert path.read_bytes() == header + b'new body\r\n'
    assert after.fields == before.fields
    assert after.fields["nested"] == {"enabled": True}


def test_metadata_patch_preserves_unknown_values_and_body(tmp_path):
    path = tmp_path / "skill.md"
    path.write_text('---\ntags: [one, two]\nnested: {enabled: true}\n---\n\nbody\n\n')
    before = read_document(path)
    after = update_document(path, DocumentPatch(set_fields={"eval": True}), expected_revision=before.revision)
    assert after.fields == {**before.fields, "eval": True}
    assert after.body == before.body
    same = update_document(path, DocumentPatch(body=after.body), expected_revision=after.revision)
    assert same.revision == after.revision


@pytest.mark.parametrize("header", ["nested: [", "name: one\nname: two", "- not-a-map"])
def test_malformed_metadata_is_readable_but_metadata_write_refused(tmp_path, header):
    path = tmp_path / "bad.md"
    text = f"---\n{header}\n---\nbody"
    path.write_text(text)
    document = read_document(path)
    assert document.metadata_error
    with pytest.raises(ValueError):
        update_document(path, DocumentPatch(set_fields={"eval": True}), expected_revision=document.revision)
    assert path.read_text() == text


def test_stale_even_when_requested_body_matches_current_bytes(tmp_path):
    path = tmp_path / "skill.md"
    path.write_text("old")
    before = read_document(path)
    path.write_text("new")
    with pytest.raises(DocumentConflict):
        update_document(path, DocumentPatch(body="new"), expected_revision=before.revision)
    path.unlink()
    with pytest.raises(DocumentConflict):
        update_document(path, DocumentPatch(body="recreate"), expected_revision=before.revision)
    assert not path.exists()


def test_competing_alias_writers_share_revision_guard(tmp_path):
    target = tmp_path / "skill.md"
    target.write_text("before")
    alias = tmp_path / "alias.md"
    alias.symlink_to(target)
    revision = read_document(target).revision
    barrier = Barrier(2)

    def save(path, body):
        barrier.wait()
        try:
            return update_document(path, DocumentPatch(body=body), expected_revision=revision).body
        except DocumentConflict:
            return "conflict"

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(save, target, "first")
        second = pool.submit(save, alias, "second")
        results = [first.result(), second.result()]
    assert results.count("conflict") == 1
    assert target.read_text() in results
    assert alias.is_symlink()


def test_version_is_part_of_returned_revision_and_noop_does_not_bump(tmp_path):
    path = tmp_path / "skill.md"
    path.write_text("---\nversion: 1\n---\nbefore")
    before = read_document(path)
    after = update_document(path, DocumentPatch(body="after"), expected_revision=before.revision,
                            version_base=before.raw_text)
    assert after.fields["version"] == 2
    assert after.revision == read_document(path).revision
    assert update_document(path, DocumentPatch(body=after.body), expected_revision=after.revision,
                           version_base=before.raw_text).revision == after.revision


def test_document_patch_cannot_replace_identity(tmp_path):
    path = tmp_path / "skill.md"
    path.write_text("---\nid: kept\n---\nbody")
    with pytest.raises(ValueError, match="identity"):
        update_document(path, DocumentPatch(drop_fields=("id",)))
    with pytest.raises(ValueError, match="both"):
        DocumentPatch(set_fields={"name": "x"}, drop_fields=("name",))
