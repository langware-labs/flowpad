"""Receiver-side unpack: a copied file-backed asset (spec) materializes — and
HEALS a content-less stub — via the generic restore→reindex path. This is the
blank-shared-plan fix (body-aware, idempotent), now through the UNIFIED family
path: ``_restore_file_backed_entry`` copies the bundle's ``<main_subdir>/<leaf>``
subtree into the PROJECT, then ``_reindex_received_assets`` materializes the row.

No mocks: real test DB + real FSIndexer. Exercises exactly what unpack_bundle
runs for a file-backed asset entry.
"""
import pytest

# Ensure SPEC TypeInfo (main_subdir/extractor/owns) is registered.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.flow_message_bundle import (
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
