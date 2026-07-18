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
    _ensure_id_in_md_frontmatter,
    _extended_length_path,
    _pack_file_backed_attachment,
)
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ENTITY_ID = "7ce48c47-abab-4c9c-9780-a7198d12a260"


def test_agent_and_whiteboard_are_file_backed():
    # The unified packer routes by the FAMILY predicate (TypeInfo.main_subdir is
    # not None), not a hardcoded type set — else their bytes never ride the
    # bundle and the receiver has nothing to materialize.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    for t in (EntityType.AGENT.value, EntityType.WHITEBOARD.value):
        info = SchemaRegistry.get(t)
        assert info is not None and info.main_subdir is not None, f"{t} must be file-backed"


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


# --- Pack-side: the unified file-backed family handler, end-to-end -----------
#
# The two tests below drive the REAL ``_pack_file_backed_attachment`` (not the
# copytree/pin primitives in isolation) for both shapes of the file-backed
# family: a FOLDER asset (whiteboard/skill) and SINGLE-FILE assets (a workflow
# ``.md`` vs. a dynamic_workflow ``.js``). The real packer routes through
# ``_resolve_file_backed_source`` → real ``TypeInfo`` (layout / main_subdir /
# main_file / main_ext) → ``shutil.copytree(ignore=_ASSET_PACK_IGNORE)`` →
# id-pin. Only the entity *lookup* is stubbed: under pytest the registry's
# ``entity_cls`` is unregistered (``get_entity_cls`` returns None), so without
# this the resolver would no-op before reaching any of the branches we mean to
# exercise. The on-disk asset, the layout, and the pin are all the real thing.


class _FakeFileBackedEntity:
    """Minimal stand-in: the resolver only reads ``asset_ref`` and ``name``."""

    def __init__(self, asset_ref: str, name: str):
        self.asset_ref = asset_ref
        self.name = name


def _stub_file_backed_lookup(monkeypatch, asset_ref: str, name: str = "asset"):
    """Point ``_resolve_file_backed_source`` at our on-disk fixture via a fake
    entity. Real ``SchemaRegistry.get`` (TypeInfo) is untouched — only the
    ``entity_cls`` resolution is replaced, because pytest never runs the
    ``register_all`` that wires real entity classes onto the registry."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    ent = _FakeFileBackedEntity(asset_ref, name)

    class _StubCls:
        @classmethod
        async def get_one(cls, query):  # noqa: ARG003
            return ent

    monkeypatch.setattr(
        SchemaRegistry, "get_entity_cls", classmethod(lambda c, t: _StubCls)
    )
    return ent


@pytest.mark.asyncio
async def test_pack_folder_asset_copytree_and_pins_id_into_main_file(tmp_path, monkeypatch):
    # FOLDER asset (whiteboard): a real on-disk folder with the main doc + a
    # noise dir (.venv / __pycache__). The bundle must keep the real files,
    # drop the ignored trees (via the REAL function's _ASSET_PACK_IGNORE), and
    # pin the sender id into TypeInfo.main_file.
    src = tmp_path / "src" / "my-board"
    src.mkdir(parents=True)
    (src / "WHITE_BOARD.md").write_text("---\nname: my-board\n---\n\n# Board\n", encoding="utf-8")
    (src / "scene.excalidraw").write_text("{}", encoding="utf-8")  # real asset file
    # Env/cache cruft that MUST be dropped (mirrors the failing skill bundle).
    venv_deep = src / ".venv" / "lib" / "site-packages" / "pip" / "__pycache__"
    venv_deep.mkdir(parents=True)
    (venv_deep / "build_tracker.cpython-314.pyc").write_text("x", encoding="utf-8")
    (src / "__pycache__").mkdir()
    (src / "__pycache__" / "scene.cpython-314.pyc").write_text("x", encoding="utf-8")

    _stub_file_backed_lookup(monkeypatch, str(src), name="my-board")

    attachment_dir = tmp_path / "bundle"
    attachment_dir.mkdir()
    await _pack_file_backed_attachment(EntityType.WHITEBOARD.value, ENTITY_ID, attachment_dir)

    base = (
        attachment_dir
        / f"{EntityType.WHITEBOARD.value}-@{ENTITY_ID}"
        / ".claude" / "whiteboards" / "my-board"
    )
    # Real source preserved.
    assert (base / "WHITE_BOARD.md").exists()
    assert (base / "scene.excalidraw").exists()
    # Ignored trees dropped — proven through the real packer, not a bare copytree.
    assert not (base / ".venv").exists()
    assert not (base / "__pycache__").exists()
    assert not list(base.rglob("*.pyc"))
    # Sender id pinned into the folder's main doc (TypeInfo.main_file).
    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
    fields = _yaml_load(_extract_frontmatter((base / "WHITE_BOARD.md").read_text(encoding="utf-8")))
    assert fields["id"] == ENTITY_ID
    assert fields["name"] == "my-board"  # other frontmatter preserved
    # …and into the `.flow/id` capsule (folder-backed), so a yaml-only skill or a
    # main-doc-less folder round-trips its id too. The receiver's gen_uuid_fn
    # reads `.flow/id` first, so it adopts the sender's id.
    assert (base / ".flow" / "id").read_text(encoding="utf-8").strip() == ENTITY_ID


@pytest.mark.asyncio
async def test_pack_single_file_copies_md_pins_id_and_js_left_unmodified(tmp_path, monkeypatch):
    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load

    # (a) SINGLE-FILE .md asset (workflow): id pinned into its frontmatter.
    md_src = tmp_path / "src_md" / "deploy.md"
    md_src.parent.mkdir(parents=True)
    md_src.write_text("---\nname: deploy\n---\n\n# Deploy\n", encoding="utf-8")
    _stub_file_backed_lookup(monkeypatch, str(md_src), name="deploy")
    att_md = tmp_path / "bundle_md"
    att_md.mkdir()
    await _pack_file_backed_attachment(EntityType.AGENT.value, ENTITY_ID, att_md)
    md_dest = (
        att_md
        / f"{EntityType.AGENT.value}-@{ENTITY_ID}"
        / ".claude" / "agents" / "deploy.md"
    )
    assert md_dest.exists()
    md_fields = _yaml_load(_extract_frontmatter(md_dest.read_text(encoding="utf-8")))
    assert md_fields["id"] == ENTITY_ID
    assert md_fields["name"] == "deploy"

    # (b) SINGLE-FILE .js body (dynamic_workflow): copied BYTE-FOR-BYTE with NO
    # frontmatter injection — the .js-skip edge (no YAML fm in a JS body).
    js_bytes = b"export default async function run(ctx) {\n  return ctx.value + 1;\n}\n"
    js_src = tmp_path / "src_js" / "flow.js"
    js_src.parent.mkdir(parents=True)
    js_src.write_bytes(js_bytes)
    _stub_file_backed_lookup(monkeypatch, str(js_src), name="flow")
    att_js = tmp_path / "bundle_js"
    att_js.mkdir()
    await _pack_file_backed_attachment(EntityType.DYNAMIC_WORKFLOW.value, ENTITY_ID, att_js)
    js_dest = (
        att_js
        / f"{EntityType.DYNAMIC_WORKFLOW.value}-@{ENTITY_ID}"
        / ".claude" / "workflows" / "flow.js"
    )
    assert js_dest.exists()
    # Byte-for-byte identical to source — no rewrite of any kind.
    assert js_dest.read_bytes() == js_bytes
    # No injected "id:" line and the sender id never appears in the JS body.
    assert b"id:" not in js_dest.read_bytes()
    assert ENTITY_ID not in js_dest.read_text(encoding="utf-8")
