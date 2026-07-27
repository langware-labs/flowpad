"""POST /api/v1/tags/context — the `flow tag get` join, three modes.

Fixture: a markdown doc bound via frontmatter `tags:` (indexed through the
normal single-file index path) + a `.py` file carrying a `tag` capsule under
a scan root. Covers descendant inclusion, mode shaping, anonymous degradation,
and mentions for blessed tags.
"""

import pytest

from flow_sdk.capsules import AssetCapsule
from flow_sdk.capsules.data import CapsuleData

pytestmark = pytest.mark.asyncio

DOC = """---
title: Flow run budgets
tags: [qa.ctx.runs.budgets]
description: Budgets cap tokens per run; never raise a cap to mask overruns.
---
# Flow run budgets

Budgets cap tokens per run. Never raise a cap to mask an overrun.
"""


@pytest.fixture()
async def tag_root(tmp_path, client):
    docs = tmp_path / "docs"
    docs.mkdir()
    doc_path = docs / "flow-run-budgets.md"
    doc_path.write_text(DOC)

    code_path = tmp_path / "runner.py"
    code_path.write_text("def run():\n    return 1\n")
    AssetCapsule.from_path(code_path).write(
        "tag",
        CapsuleData(1, {"tags": {"qa.ctx.runs": "Run loop entry point"}}),
    )
    return tmp_path, doc_path, code_path


async def test_context_modes_and_descendants(client, tag_root, tmp_path):
    root, doc_path, code_path = tag_root

    # Index the doc through the markdown extractor (single-file path).
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown  # noqa: PLC0415

    records = extract_markdown(FSRef(doc_path), FSRecord.resolve_id_for_path(doc_path)
                               if hasattr(FSRecord, "resolve_id_for_path") else "")
    assert records, "doc should index"
    rec = records[0]
    assert rec.tags == ["qa.ctx.runs.budgets"]
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    entity = await Entity.from_record(rec)
    assert entity is not None

    # line mode — asking the PARENT tag includes the descendant-tagged doc.
    resp = await client.post(
        "/api/v1/tags/context",
        json={"name": "qa.ctx.runs", "mode": "line", "root": str(root)},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["tag"]["name"] == "qa.ctx.runs"
    assert data["tag"]["blessed"] is False  # anonymous degrades gracefully
    titles = [d["title"] for d in data["docs"]]
    assert "Flow run budgets" in titles
    doc_item = next(d for d in data["docs"] if d["title"] == "Flow run budgets")
    assert "Budgets cap tokens" in doc_item["line"]
    assert "body" not in doc_item and "block" not in doc_item

    # code capsule found under root
    assert any(site["path"].endswith("runner.py") for site in data["code"])
    site = next(s for s in data["code"] if s["path"].endswith("runner.py"))
    assert site["tags"] == {"qa.ctx.runs": "Run loop entry point"}

    # block mode adds block summaries, still no bodies
    resp = await client.post(
        "/api/v1/tags/context",
        json={"name": "qa.ctx.runs", "mode": "block", "root": str(root)},
    )
    doc_item = next(d for d in resp.json()["data"]["docs"] if d["title"] == "Flow run budgets")
    assert doc_item["block"] and "body" not in doc_item

    # full mode returns the body
    resp = await client.post(
        "/api/v1/tags/context",
        json={"name": "qa.ctx.runs.budgets", "mode": "full", "root": str(root)},
    )
    doc_item = next(d for d in resp.json()["data"]["docs"] if d["title"] == "Flow run budgets")
    assert "Never raise a cap" in doc_item["body"]
    assert doc_item["truncated"] is False


async def test_blessed_header_and_invalid_inputs(client):
    from flow_sdk.builtin.tag import Tag  # noqa: PLC0415

    await Tag(name="--qa--.ctx.header", title="QA header", description="desc").save()
    resp = await client.post(
        "/api/v1/tags/context", json={"name": "--qa--.ctx.header", "mode": "line"})
    header = resp.json()["data"]["tag"]
    assert header["blessed"] is True and header["title"] == "QA header"

    bad = await client.post("/api/v1/tags/context", json={"name": "not a tag!"})
    assert bad.json()["status"] == "FAIL"
    bad_mode = await client.post(
        "/api/v1/tags/context", json={"name": "qa.ctx", "mode": "huge"})
    assert bad_mode.json()["status"] == "FAIL"
