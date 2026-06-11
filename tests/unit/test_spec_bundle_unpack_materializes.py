"""Receiver-side unpack: a restored spec source materializes — and HEALS a
content-less stub — via the generic restore→reindex path. This is the
blank-shared-plan fix (no create-once skip, body-aware, idempotent).

No mocks: real test DB + real FSIndexer. Exercises exactly what unpack_bundle
runs for a spec attachment (``_restore_spec_source`` + ``_reindex_project_root``).
"""
import pytest

# Ensure SPEC TypeInfo (main_subdir/extractor/owns) is registered.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.flow_message_bundle import (
    _reindex_project_root,
    _restore_spec_source,
)
from flow_sdk.builtin.spec import Spec

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


def _bundle_spec_md(tmp_path, with_id: bool):
    """The bundle's ``attachment/spec-@<id>/spec.md`` (old bundles omit id)."""
    p = tmp_path / "bundle_spec.md"
    fm = "---\n"
    if with_id:
        fm += f"id: {SPEC_ID}\n"
    fm += 'title: "Plan: Hello World in Python"\nspec_type: "plan"\n---\n'
    p.write_text(fm + f"# Plan\n\n{SENTINEL}\n", encoding="utf-8")
    return p


async def test_restored_spec_materializes_with_content(tmp_path):
    staging = tmp_path / "conversation-@1bec1cfc"
    staging.mkdir(parents=True)
    _restore_spec_source(_bundle_spec_md(tmp_path, with_id=True), SPEC_ID, staging)
    # Restored at the deterministic spec-@<id> dir (no creative slug).
    assert (staging / "specs" / f"spec-@{SPEC_ID}" / "spec.md").exists()

    await _reindex_project_root(staging)

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

    # Receiver restores the bundle source (legacy bundle: no id in frontmatter →
    # id injected from the attachment dir name) and reindexes. No create-once
    # skip → the body lands on the SAME row.
    staging = tmp_path / "conversation-@1bec1cfc"
    staging.mkdir(parents=True)
    _restore_spec_source(_bundle_spec_md(tmp_path, with_id=False), SPEC_ID, staging)
    await _reindex_project_root(staging)

    healed = await Spec.get_one({"id": SPEC_ID})
    assert healed is not None
    assert healed.content and SENTINEL in healed.content, "stub was NOT healed (blank plan)"
