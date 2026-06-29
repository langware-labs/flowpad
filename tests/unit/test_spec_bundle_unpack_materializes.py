"""Receiver-side unpack: a copied file-backed asset (spec) materializes — and
HEALS a content-less stub — via the generic restore→reindex path. This is the
blank-shared-plan fix (body-aware, idempotent), now through the UNIFIED family
path: ``_restore_file_backed_entry`` copies the bundle's ``<main_subdir>/<leaf>``
subtree into the PROJECT, then ``_reindex_received_assets`` materializes the row.

No mocks: real test DB + real FSIndexer. Exercises exactly what unpack_bundle
runs for a file-backed asset entry.
"""
import filecmp

import pytest

# Ensure SPEC TypeInfo (main_subdir/extractor/owns) is registered.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.flow_message_bundle import (
    FlowMessageExistsError,
    _reindex_received_assets,
    _restore_file_backed_entry,
)
from flow_sdk.builtin.spec import Spec
from flow_sdk.fs_store.record_types import RecordType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SPEC_ID = "e0a064f1-220e-47d0-93d5-e75432e86135"
SENTINEL = "SENTINEL-plan-body-line"


@pytest.fixture(autouse=True)
def _embedded_storage():
    """Spec.content is a blob → needs embedded storage. The server provides it
    via the request context; in unit tests we install a dev storage fallback
    (the same hook ``get_embedded_storage`` falls back to)."""
    import shutil
    import tempfile
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.config import default_service_config

    blob_root = tempfile.mkdtemp(prefix="spec_blobs_")
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(blob_root))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        shutil.rmtree(blob_root, ignore_errors=True)


def _bundle_entry_dir(tmp_path):
    """Build a bundle attachment entry the unified packer would produce:
    ``attachment/spec-@<id>/specs/<name>/spec.md`` with the sender id pinned
    into the frontmatter (the packer always pins it now)."""
    entry_dir = tmp_path / "attachment" / f"spec-@{SPEC_ID}"
    spec_md = entry_dir / "specs" / "hello-world" / "spec.md"
    spec_md.parent.mkdir(parents=True, exist_ok=True)
    spec_md.write_text(
        f'---\nid: {SPEC_ID}\ntitle: "Plan: Hello World in Python"\nspec_type: "plan"\n---\n'
        f"# Plan\n\n{SENTINEL}\n",
        encoding="utf-8",
    )
    return entry_dir


async def test_restored_spec_materializes_with_content(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir(parents=True)

    copied = _restore_file_backed_entry(_bundle_entry_dir(tmp_path), project_root, overwrite=False)
    assert copied
    # Copied at the canonical <project>/specs/<name>/spec.md location.
    assert (project_root / "specs" / "hello-world" / "spec.md").exists()

    await _reindex_received_assets(project_root, (RecordType.SPEC,))

    spec = await Spec.get_one({"id": SPEC_ID})
    assert spec is not None, "reindex did not materialize the spec row"
    assert spec.content and SENTINEL in spec.content, f"body missing: {spec.content!r}"
    assert spec.spec_type == "plan"


async def test_restore_heals_content_less_stub(tmp_path):
    # Pre-existing content-less STUB — the bug: a row minted ahead of the bundle.
    stub = Spec(title="Plan: Hello World in Python", content="", spec_type="plan")
    stub.id = SPEC_ID
    await stub.save()
    pre = await Spec.get_one({"id": SPEC_ID})
    assert pre is not None and not (pre.content or "").strip(), "precondition: empty stub"

    # Receiver copies the bundle source into the project and reindexes. The
    # body lands on the SAME row (the pinned frontmatter id resolves to it).
    project_root = tmp_path / "project"
    project_root.mkdir(parents=True)
    _restore_file_backed_entry(_bundle_entry_dir(tmp_path), project_root, overwrite=False)
    await _reindex_received_assets(project_root, (RecordType.SPEC,))

    healed = await Spec.get_one({"id": SPEC_ID})
    assert healed is not None
    assert healed.content and SENTINEL in healed.content, "stub was NOT healed (blank plan)"


# ---------------------------------------------------------------------------
# Restore-edge coverage: collision / idempotency / overwrite — drives the
# filecmp + conflict + overwrite branches of ``_restore_file_backed_entry``
# directly (real files, no DB), mirroring the helper style above.
# ---------------------------------------------------------------------------


def _spec_bundle_entry_dir(tmp_path, spec_id, body):
    """A spec bundle attachment entry with a custom id + body, laid out at the
    canonical ``specs/<name>/spec.md`` the unified packer produces."""
    entry_dir = tmp_path / "attachment" / f"spec-@{spec_id}"
    spec_md = entry_dir / "specs" / "hello-world" / "spec.md"
    spec_md.parent.mkdir(parents=True, exist_ok=True)
    spec_md.write_text(
        f'---\nid: {spec_id}\ntitle: "Plan: Hello World in Python"\nspec_type: "plan"\n---\n'
        f"# Plan\n\n{body}\n",
        encoding="utf-8",
    )
    return entry_dir


async def test_restore_raises_on_genuine_byte_collision(tmp_path):
    # [UNPACK-COLLISION] A DIFFERENT-bytes file already sits where the entry
    # would write; overwrite=False must refuse and preserve the local bytes.
    entry_dir = _bundle_entry_dir(tmp_path)
    project_root = tmp_path / "project"
    dest = project_root / "specs" / "hello-world" / "spec.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    local_bytes = b"---\nid: local\n---\n# LOCAL EDIT do not clobber\n"
    dest.write_bytes(local_bytes)

    with pytest.raises(FlowMessageExistsError) as exc_info:
        _restore_file_backed_entry(entry_dir, project_root, overwrite=False)

    # PATH-shaped conflict (not the {type,id} shape the top-level FM uses).
    assert exc_info.value.conflicts == [{"path": str(dest)}]
    # The pre-existing local file was NOT touched.
    assert dest.read_bytes() == local_bytes


async def test_restore_byte_identical_existing_is_idempotent_noop(tmp_path):
    # [UNPACK-IDEMPOTENT] Re-receiving the SAME asset is a no-op, not a conflict.
    entry_dir = _bundle_entry_dir(tmp_path)
    project_root = tmp_path / "project"
    project_root.mkdir(parents=True)

    assert _restore_file_backed_entry(entry_dir, project_root, overwrite=False) is True
    dest = project_root / "specs" / "hello-world" / "spec.md"
    src = entry_dir / "specs" / "hello-world" / "spec.md"
    assert filecmp.cmp(src, dest, shallow=False), "precondition: dest == source bytes"
    before = dest.read_bytes()

    # Second restore from the byte-identical source: no raise, nothing copied.
    assert _restore_file_backed_entry(entry_dir, project_root, overwrite=False) is False
    assert dest.read_bytes() == before  # unchanged


async def test_overwrite_replaces_existing_on_disk_asset(tmp_path):
    # [UNPACK-OVERWRITE] overwrite=True replaces a stale local body; the
    # reindexed Spec reflects the replacement; a later overwrite=False restore
    # against the now-identical dest is a no-op (not a conflict).
    ow_spec_id = "b2c3d4e5-1111-4aaa-9bbb-0123456789ab"
    new_body = "SENTINEL-overwrite-fresh-body"
    entry_dir = _spec_bundle_entry_dir(tmp_path, ow_spec_id, new_body)

    project_root = tmp_path / "project"
    dest = project_root / "specs" / "hello-world" / "spec.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        f'---\nid: {ow_spec_id}\ntitle: "stale"\nspec_type: "plan"\n---\n# Old\n\nSTALE-old-body\n',
        encoding="utf-8",
    )

    assert _restore_file_backed_entry(entry_dir, project_root, overwrite=True) is True
    text = dest.read_text(encoding="utf-8")
    assert new_body in text and "STALE-old-body" not in text, "overwrite did not replace bytes"

    await _reindex_received_assets(project_root, (RecordType.SPEC,))
    spec = await Spec.get_one({"id": ow_spec_id})
    assert spec is not None, "reindex did not materialize the overwritten spec"
    assert spec.content and new_body in spec.content, f"reindex kept stale body: {spec.content!r}"

    # Now dest is byte-identical to the bundle source → overwrite=False no-op,
    # NOT a conflict.
    assert _restore_file_backed_entry(entry_dir, project_root, overwrite=False) is False


async def test_restored_single_file_markdown_materializes_same_pinned_id(tmp_path):
    # [UNPACK-IDPIN] A SINGLE-FILE markdown-family asset (main_layout="file",
    # main_subdir="docs") with a pinned frontmatter id must materialize the SAME
    # id at the receiver-canonical <project>/docs/<leaf> path — not a uuid5(path)
    # duplicate.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    md_id = "c3d4e5f6-2222-4ccc-8ddd-aabbccddeeff"
    body = "SENTINEL-markdown-single-file-body"
    entry_dir = tmp_path / "attachment" / f"markdown-@{md_id}"
    leaf = entry_dir / "docs" / "shared-note.md"
    leaf.parent.mkdir(parents=True, exist_ok=True)
    leaf.write_text(
        f'---\nid: {md_id}\ntitle: "Shared Note"\n---\n# Shared Note\n\n{body}\n',
        encoding="utf-8",
    )

    project_root = tmp_path / "project"
    project_root.mkdir(parents=True)

    assert _restore_file_backed_entry(entry_dir, project_root, overwrite=False) is True
    canonical = project_root / "docs" / "shared-note.md"
    assert canonical.exists(), "single-file markdown not restored at <project>/docs/<leaf>"

    await _reindex_received_assets(project_root, (RecordType.MARKDOWN,))

    md_cls = SchemaRegistry.get_entity_cls("markdown")
    assert md_cls is not None, "markdown entity class not registered"
    ent = await md_cls.get_one({"id": md_id})
    assert ent is not None, "reindex minted a uuid5(path) duplicate, not the pinned id"
    # asset_ref points at the receiver-canonical path (same materialized leaf).
    assert ent.asset_ref and canonical.samefile(ent.asset_ref), (
        f"materialized at wrong path: {ent.asset_ref!r}"
    )

    # Re-run restore byte-identical → idempotent no-op (re-receive path).
    assert _restore_file_backed_entry(entry_dir, project_root, overwrite=False) is False
