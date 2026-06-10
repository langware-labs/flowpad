"""FS-rooted bundle id-injection — the workflow/whiteboard share fix.

Workflow + whiteboard are filesystem-primary assets whose indexer ids are
path/name-derived. When shared, the receiver restores the subtree to a
different path, so without carrying the sender's id the receiver would mint a
DIFFERENT entity id and the message's ``<type>-<id>`` chip would never resolve.
The packer injects the sender's id into the asset's main markdown doc so the
receiver's gen_id (which preserves an existing frontmatter id) materializes the
SAME entity. This locks both that contract and the type registration.
"""
import pytest

from flow_sdk.builtin.flow_message_bundle import (
    _FS_ROOTED_TYPES,
    _ensure_id_in_md_frontmatter,
)
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ENTITY_ID = "7ce48c47-abab-4c9c-9780-a7198d12a260"


def test_workflow_and_whiteboard_are_fs_rooted():
    # Both must be in the pack/restore dispatch set — else their bytes never
    # ride the bundle and the receiver has nothing to materialize.
    assert EntityType.WORKFLOW.value in _FS_ROOTED_TYPES
    assert EntityType.WHITEBOARD.value in _FS_ROOTED_TYPES


def test_injects_id_into_doc_without_frontmatter(tmp_path):
    doc = tmp_path / "wf.md"
    doc.write_text("---\nname: my-workflow\n---\n\n# Body\n", encoding="utf-8")

    _ensure_id_in_md_frontmatter(doc, ENTITY_ID)

    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
    fields = _yaml_load(_extract_frontmatter(doc.read_text(encoding="utf-8")))
    assert fields["id"] == ENTITY_ID
    assert fields["name"] == "my-workflow"  # other fields preserved
    assert "# Body" in doc.read_text(encoding="utf-8")  # body preserved


def test_injects_id_into_doc_with_no_frontmatter_at_all(tmp_path):
    doc = tmp_path / "wf.md"
    doc.write_text("# Just a body, no frontmatter\n", encoding="utf-8")

    _ensure_id_in_md_frontmatter(doc, ENTITY_ID)

    text = doc.read_text(encoding="utf-8")
    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
    assert _yaml_load(_extract_frontmatter(text))["id"] == ENTITY_ID
    assert "Just a body" in text


def test_idempotent_when_id_already_matches(tmp_path):
    doc = tmp_path / "wf.md"
    original = f"---\nid: {ENTITY_ID}\nname: x\n---\n\n# Body\n"
    doc.write_text(original, encoding="utf-8")

    _ensure_id_in_md_frontmatter(doc, ENTITY_ID)

    assert doc.read_text(encoding="utf-8") == original  # untouched


def test_overwrites_a_foreign_id(tmp_path):
    doc = tmp_path / "wf.md"
    doc.write_text("---\nid: deadbeef-0000-0000-0000-000000000000\nname: x\n---\n\n# Body\n", encoding="utf-8")

    _ensure_id_in_md_frontmatter(doc, ENTITY_ID)

    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
    assert _yaml_load(_extract_frontmatter(doc.read_text(encoding="utf-8")))["id"] == ENTITY_ID
