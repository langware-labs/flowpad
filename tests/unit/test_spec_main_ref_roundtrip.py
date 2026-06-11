"""Spec owns_main_ref round-trip is stable (no frontmatter accumulation).

Load-bearing for the .flowmsg unification: a shared Spec's body must survive
``default_body_fn`` -> ``specs/<name>/spec.md`` -> ``extract_spec`` -> ``content``
without the frontmatter block doubling on each save. Regression target: blank
shared plans (a content-less spec stub renders an empty "View Plan" editor).
"""
from types import SimpleNamespace

import pytest

# Populate the SchemaRegistry so compute_asset_ref/default_body resolve SPEC.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.spec import extract_spec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _spec_entity(spec_id, title, content, spec_type="plan"):
    # Duck-typed: _spec_default_body / _safe_name read id/title/name/content/spec_type.
    return SimpleNamespace(id=spec_id, title=title, name=title, content=content, spec_type=spec_type)


def test_spec_main_ref_roundtrip_is_stable(tmp_path):
    spec_id = "e0a064f1-220e-47d0-93d5-e75432e86135"
    title = "Plan: Hello World in Python"
    content = "# Step 1\n\nDo the thing.\n\n# Step 2\n\nSENTINEL-body line"
    entity = _spec_entity(spec_id, title, content)

    rec = FSRecord(type=RecordType.SPEC, id=spec_id)
    ar = rec.compute_asset_ref(tmp_path, entity)
    assert ar is not None, "SPEC must declare main_subdir/main_layout"
    object.__setattr__(rec, "_asset_ref", ar)

    # 1. owns_main_ref writes specs/<safe>/spec.md (folder + main_file).
    rec.upsert_main_ref(entity)
    md = ar._path
    assert md.name == "spec.md", f"expected inner spec.md, got {md}"
    assert md.parent.parent.name == "specs", f"expected specs/<name>/spec.md, got {md}"
    assert md.exists()
    written = md.read_text(encoding="utf-8")
    assert written.startswith("---")
    assert spec_id in written
    assert "SENTINEL-body line" in written

    # 2. extract_spec returns body-only content (frontmatter stripped).
    recs = extract_spec(FSRef(md))
    assert len(recs) == 1
    out = recs[0]
    assert out.id == spec_id
    assert out.spec_type == "plan"
    assert getattr(out, "title", None) == title
    assert "SENTINEL-body line" in out.content
    assert not out.content.lstrip().startswith("---"), "frontmatter leaked into content"
    assert spec_id not in out.content, "id frontmatter leaked into content"

    # 3. WRITE-ONCE / "user data is user data": a manual edit to the existing
    #    file must survive a subsequent save — upsert_main_ref must NOT
    #    re-render an existing file (owns_main_ref is False).
    md.write_text(written + "\nUSER-EDITED-LINE\n", encoding="utf-8")
    entity2 = _spec_entity(out.id, "Renamed Title", "totally different body", out.spec_type)
    rec.upsert_main_ref(entity2)  # file exists -> no-op, user data preserved
    after = md.read_text(encoding="utf-8")
    assert "USER-EDITED-LINE" in after, "user edit to the file was clobbered"
    assert "totally different body" not in after, "save re-rendered the user's file"
    # And extraction still reflects the file (the source of truth), not entity2.
    recs2 = extract_spec(FSRef(md))
    assert "USER-EDITED-LINE" in recs2[0].content
    assert recs2[0].title == title
