"""FS-rooted bundle id-injection — the workflow/whiteboard share fix.

Workflow + whiteboard are filesystem-primary assets whose indexer ids are
path/name-derived. When shared, the receiver restores the subtree to a
different path, so without carrying the sender's id the receiver would mint a
DIFFERENT entity id and the message's ``<type>-<id>`` chip would never resolve.
The packer injects the sender's id into the asset's main markdown doc so the
receiver's gen_id (which preserves an existing frontmatter id) materializes the
SAME entity. This locks both that contract and the type registration.
"""
import os
import shutil
import zipfile
from pathlib import Path

import pytest

from flow_sdk.builtin.flow_message_bundle import (
    _ASSET_PACK_IGNORE,
    _FS_ROOTED_TYPES,
    _ensure_id_in_md_frontmatter,
    _extended_length_path,
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


# --- Pack-side fix: never bundle a `.venv`/cache into a shared asset ---------
#
# A skill packed with its `.venv` shipped a deep
# `…/site-packages/pip/_internal/…/__pycache__/*.pyc` tree that overran
# Windows' 260-char MAX_PATH on the receiver's extractall, silently aborting
# the whole download. The packer copies with ``ignore=_ASSET_PACK_IGNORE``;
# this locks that those env/cache trees are dropped while real source rides.

def test_asset_pack_ignore_drops_env_and_cache_trees(tmp_path):
    src = tmp_path / "skills" / "soc2-evidence-renewal"
    # Real skill source that MUST survive.
    (src).mkdir(parents=True)
    (src / "SKILL.md").write_text("---\nname: soc2\n---\n\n# do the thing\n", encoding="utf-8")
    (src / "scripts").mkdir()
    (src / "scripts" / "run.py").write_text("print('hi')\n", encoding="utf-8")
    # Env/cache cruft that MUST be dropped (mirrors the failing bundle).
    venv_deep = src / ".venv" / "lib" / "site-packages" / "pip" / "__pycache__"
    venv_deep.mkdir(parents=True)
    (venv_deep / "build_tracker.cpython-314.pyc").write_text("x", encoding="utf-8")
    (src / "scripts" / "__pycache__").mkdir()
    (src / "scripts" / "__pycache__" / "run.cpython-314.pyc").write_text("x", encoding="utf-8")
    (src / "node_modules").mkdir()
    (src / "node_modules" / "left-pad.js").write_text("x", encoding="utf-8")

    dest = tmp_path / "bundle" / "soc2"
    shutil.copytree(src, dest, ignore=_ASSET_PACK_IGNORE)

    # Source preserved.
    assert (dest / "SKILL.md").exists()
    assert (dest / "scripts" / "run.py").exists()
    # Env/cache dropped entirely.
    assert not (dest / ".venv").exists()
    assert not (dest / "node_modules").exists()
    assert not (dest / "scripts" / "__pycache__").exists()
    assert not list(dest.rglob("*.pyc"))


# --- Unpack-side hardening: Windows long-path extraction --------------------
#
# (We don't fake ``os.name`` to exercise the off-Windows branch — that global
# also drives pathlib and would break Path on the host. The non-nt branch is a
# trivial ``return p``; we cover the load-bearing Windows behavior directly.)

@pytest.mark.skipif(os.name != "nt", reason="Windows extended-length path semantics")
def test_extended_length_path_prefixes_and_is_idempotent(tmp_path):
    out = str(_extended_length_path(tmp_path))
    assert out.startswith("\\\\?\\")
    # Re-wrapping an already-prefixed path must not double-prefix.
    assert _extended_length_path(_extended_length_path(tmp_path)) == _extended_length_path(tmp_path)


# The bug, captured at the extraction primitive (real zip, real FS, no mocks).
# A shared skill carrying a `.venv` produced this exact member path; on the
# receiver, ``zf.extractall`` into a plain root raised FileNotFoundError once
# the full path crossed 260 chars (MAX_PATH), aborting the whole download so
# the skill never materialized and its chip stayed on "download". The proven
# on/off switch is the extended-length (``\\?\``) prefix on the extraction
# root — this test toggles it BOTH ways: OFF reproduces the bug, ON is the fix.
@pytest.mark.skipif(os.name != "nt", reason="MAX_PATH (260) is a Windows-only extraction limit")
def test_deep_bundle_member_extracts_only_with_extended_length_root(tmp_path):
    deep_arc = (
        "attachment/skill-@359c3e7b-eac8-40fe-863b-74379f527fa2/.claude/skills/"
        "soc2-evidence-renewal/.venv/lib/python3.14/site-packages/pip/_internal/"
        "operations/build/__pycache__/build_tracker.cpython-314.pyc"
    )
    zip_path = tmp_path / "bundle.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr(deep_arc, b"x")

    # Precondition: the extracted path must actually exceed MAX_PATH, else the
    # bug can't manifest and this test would prove nothing.
    plain_root = tmp_path / "off"
    plain_root.mkdir()
    target = plain_root / deep_arc.replace("/", os.sep)
    assert len(str(target)) > 260, f"path only {len(str(target))} chars; widen tmp or arcname"

    # SWITCH OFF — plain root: reproduces the production failure exactly.
    with zipfile.ZipFile(zip_path, "r") as zf:
        with pytest.raises(FileNotFoundError):
            zf.extractall(plain_root)

    # SWITCH ON — extended-length root (the fix): extraction succeeds and the
    # deep member lands. Presence is checked via the extended-length path
    # because a plain ``.exists()`` on a 260+ char path also fails MAX_PATH.
    ext_root = tmp_path / "on"
    ext_root.mkdir()
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(_extended_length_path(ext_root))
    landed = Path(str(_extended_length_path(ext_root)) + os.sep + deep_arc.replace("/", os.sep))
    assert landed.exists()
    assert landed.read_bytes() == b"x"
