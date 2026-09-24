"""A shared single-file asset installed into a project is indexed by its own path.

index_attachments used to re-root the walk at <project>/<main_subdir>, so a
subagent/prompt landed on disk but never became a row (QA cycle 2026-09-23).
"""
from __future__ import annotations
import json, uuid, zipfile
from pathlib import Path
import pytest
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]

@pytest.fixture(autouse=True)
def _iso(tmp_records_root):
    return tmp_records_root

CASES = {
    "subagent": (".claude/agents/probe-agent-{s}.md", "---\nid: {id}\nname: probe-agent-{s}\nkind: harness\n---\n\n"),
    "prompt": ("agentic-assets/prompt/probe-prompt-{s}.md", "---\nid: {id}\nname: probe-prompt-{s}\n---\n\ndo the thing\n"),
    "markdown": ("docs/probe-md-{s}.md", "---\nid: {id}\ntitle: probe md\n---\n\nhi\n"),
}

@pytest.mark.parametrize("t", list(CASES))
async def test_an_installed_single_file_asset_is_indexed(tmp_path, t, monkeypatch):
    import flow_sdk.builtin.flow_message_bundle as fmb
    async def _boom(*a, **k): raise AssertionError("a single-file install must not fall back to the folder walk")
    monkeypatch.setattr(fmb, "_reindex_received_assets", _boom)
    fm, aid = str(uuid.uuid4()), str(uuid.uuid4()); s = aid[:8]
    rel, body = CASES[t]
    key = f"{t}-{aid}"
    zp = tmp_path / "b.flowmsg"
    with zipfile.ZipFile(zp, "w") as zf:
        zf.writestr("header.json", json.dumps({"id": fm, "type": "flow_message", "text": "c", "attachment": [{"attachment_type": "type_id", "data": key}]}))
        zf.writestr(f"attachment/{key}/{rel.format(s=s)}", body.format(id=aid, s=s))
    await unpack_bundle(zp, "local-user-id")
    ma = await MessageAttachment.get_one({"id": MessageAttachment.allocate_deterministic_id(fm, key)})
    pr = tmp_path / "proj"; pr.mkdir()
    p = Project(name="dst", fs_storage_mount_path=str(pr)); await p.save(notify=False)
    res = await handle_attachment_install(ma.id, "project", p.id)
    assert isinstance(res, ApiSuccessResponse), res
    assert (pr / rel.format(s=s)).exists()
    cls = SchemaRegistry.get(t).entity_cls
    assert await cls.get_one({"id": aid}) is not None, f"{t} not indexed"
