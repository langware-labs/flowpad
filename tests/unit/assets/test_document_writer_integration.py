"""Shared writer boundaries preserve authored bytes and reject stale metadata."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

from flow_sdk.assets.document import DocumentPatch, read_document, update_document
from flow_sdk.assets.frontmatter import StaleWrite, _atomic_write_text
from flow_sdk.capsules import snapshot_capsule_blocks
from flow_sdk.capsules.atomic import capsule_lock
from flow_sdk.core.entity.frontmatter_accessor import FrontmatterAccessor


def test_body_and_metadata_edits_preserve_capsule_bytes(tmp_path):
    path = tmp_path / 'skill.md'
    capsule = '<!-- flowpad:capsule tag\r\nversion: 1\r\ndata: {note: "authored spacing"}\r\nflowpad:endcapsule tag -->\r\n'
    path.write_bytes(('---\r\nname: example\r\n---\r\nold body\r\n\r\n' + capsule).encode())
    before = read_document(path)
    after = update_document(path, DocumentPatch(body='new body\r\n'), expected_revision=before.revision)
    assert snapshot_capsule_blocks(after.raw_text) == (capsule,)
    final = update_document(path, DocumentPatch(set_fields={'eval': True}), expected_revision=after.revision)
    assert snapshot_capsule_blocks(final.raw_text) == (capsule,)
    assert final.body == after.body


def test_atomic_text_write_distinguishes_line_endings_and_checks_stale_noop(tmp_path):
    path = tmp_path / 'notes.md'
    path.write_bytes(b'line\r\n')
    _atomic_write_text(path, 'line\n')
    assert path.read_bytes() == b'line\n'
    before = path.stat()
    path.write_bytes(b'new line\n')
    with pytest.raises(StaleWrite):
        _atomic_write_text(path, 'new line\n', expect=before)
    assert path.read_bytes() == b'new line\n'


def test_entity_accessor_refuses_malformed_metadata_and_identity_updates(tmp_path):
    path = tmp_path / 'notes.md'
    accessor = FrontmatterAccessor(SimpleNamespace(asset_ref=path, type_info=None))
    malformed = b'---\nname: [unfinished\n---\nbody\n'
    path.write_bytes(malformed)
    with pytest.raises(ValueError):
        accessor.set('version', 2)
    assert path.read_bytes() == malformed
    path.write_text('---\nid: original\n---\nbody\n')
    with pytest.raises(ValueError, match='identity'):
        accessor.set('id', 'replacement')
    assert accessor.get('id') == 'original'


def test_entity_accessor_and_document_writer_share_canonical_lock(tmp_path, monkeypatch):
    import flow_sdk.assets.document as documents

    path = tmp_path / 'notes.md'
    path.write_text('---\nname: before\n---\nbody\n')
    alias = tmp_path / 'alias.md'
    alias.symlink_to(path)
    accessor = FrontmatterAccessor(SimpleNamespace(asset_ref=alias, type_info=None))
    attempted = Event()

    @contextmanager
    def observed_lock(target):
        attempted.set()
        with capsule_lock(target):
            yield

    monkeypatch.setattr(documents, 'capsule_lock', observed_lock)
    with ThreadPoolExecutor(1) as pool:
        with capsule_lock(path):
            future = pool.submit(accessor.set, 'version', 2)
            attempted.wait()
            assert not future.done()
            assert 'version' not in read_document(path).fields
        future.result()
    assert accessor.get('version') == 2
    assert alias.is_symlink()


def test_source_capsules_require_source_editor_not_markdown_body_replacement(tmp_path):
    from flow_sdk.capsules import AssetCapsule
    from flow_sdk.capsules.data import CapsuleData

    path = tmp_path / 'trigger.py'
    path.write_text('value = 1\n')
    AssetCapsule.from_path(path).write('tag', CapsuleData(1, {'tags': {'qa.value': 'keep anchor'}}))
    before = path.read_bytes()
    with pytest.raises(ValueError, match='positional capsules'):
        update_document(path, DocumentPatch(body='value = 2\n'), expected_revision=read_document(path).revision)
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_ordinary_upload_shares_document_lock(tmp_path, monkeypatch):
    import asyncio
    from io import BytesIO

    import flow_sdk.capsules.atomic as atomic
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    path = tmp_path / 'notes.md'
    path.write_text('before')
    storage = LocalStorageDriver(str(tmp_path))
    attempted = Event()

    @contextmanager
    def observed_lock(target):
        attempted.set()
        with capsule_lock(target):
            yield

    monkeypatch.setattr(atomic, 'capsule_lock', observed_lock)
    with capsule_lock(path):
        upload = asyncio.create_task(storage.upload(BytesIO(b'after'), 'notes.md'))
        await asyncio.to_thread(attempted.wait)
        assert not upload.done()
        assert path.read_bytes() == b'before'
    await upload
    assert path.read_bytes() == b'after'


@pytest.mark.asyncio
async def test_version_commit_refuses_a_stale_metadata_calculation(tmp_path, monkeypatch):
    import subprocess

    from flow_sdk.actions.fs import asset_versioning
    from flow_sdk.assets.document import DocumentConflict

    path = tmp_path / 'notes.md'
    path.write_text('---\nname: example\nversion: 1\n---\nbefore\n')
    for args in (('init',), ('config', 'user.email', 'test@example.test'),
                 ('config', 'user.name', 'Test'), ('add', 'notes.md'), ('commit', '-m', 'initial')):
        subprocess.run(['git', *args], cwd=tmp_path, check=True, capture_output=True)
    path.write_text(path.read_text().replace('before', 'after'))
    concurrent = '---\nname: example\nversion: 8\n---\nconcurrent body\n'

    def save_after_competing_writer(target, patch, **kwargs):
        Path(target).write_text(concurrent)
        return update_document(target, patch, **kwargs)

    monkeypatch.setattr(asset_versioning, 'update_document', save_after_competing_writer)
    with pytest.raises(DocumentConflict):
        await asset_versioning.commit_asset_change(str(path))
    assert path.read_text() == concurrent


def test_fsref_complete_document_preserves_identity_and_replaces_mutable_fields(tmp_path):
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.fs_store.fs_ref import FrontMatterFsRef

    path = tmp_path / 'nested' / 'spec.md'
    ref = FrontMatterFsRef(path)
    identity = mint_uuid()
    ref.write_doc('first body\n', {'id': identity, 'name': 'first', 'obsolete': True})
    ref.write_frontmatter({'version': 2})
    ref.write_doc('second body\n', {'name': 'second'})
    document = read_document(path)
    assert document.fields == {'id': identity, 'name': 'second'}
    assert document.body == 'second body\n'
    with pytest.raises(ValueError, match='identity'):
        ref.write_md('wrong body', {'id': mint_uuid()})
    assert read_document(path).revision == document.revision


def test_fsref_cannot_replace_a_legacy_capsule_identity(tmp_path):
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.capsules import AssetCapsule, CapsuleData
    from flow_sdk.fs_store.fs_ref import FrontMatterFsRef

    path = tmp_path / 'legacy.md'
    path.write_text('body\n')
    AssetCapsule.from_path(path).write('identity', CapsuleData(1, {'id': mint_uuid()}))
    before = path.read_bytes()
    with pytest.raises(ValueError, match='identity'):
        FrontMatterFsRef(path).write_doc('new body', {'id': mint_uuid()})
    assert path.read_bytes() == before
