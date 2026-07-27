"""FlowMessage deletion purges its staging data + MessageAttachment rows.

Installed copies are the user's assets and must survive — only the message's
record-data dir (download/ + unpacked/) and its MA rows go.
"""
from __future__ import annotations

import json
import uuid
import zipfile
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401

from flow_sdk.app.actions import message_attachment_action as ma_action
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.fs_store.operations import flow_message as fm_data_ops
from flow_sdk.fs_store.operations.flow_message import purge_flow_message_local_data
from flow_sdk.responses.response import ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


async def _stage_skill(tmp_path: Path) -> tuple[str, MessageAttachment, str]:
    fm_id, skill_id = str(uuid.uuid4()), str(uuid.uuid4())
    leaf = f"purge-skill-{skill_id[:8]}"
    zip_path = tmp_path / "bundle.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("header.json", json.dumps({
            "id": fm_id, "type": "flow_message", "text": "carrier",
            "attachment": [{"attachment_type": "type_id", "data": f"skill-{skill_id}"}],
        }))
        zf.writestr(
            f"attachment/skill-{skill_id}/.claude/skills/{leaf}/SKILL.md",
            f"---\nid: {skill_id}\nname: {leaf}\n---\n\n# purge me\n",
        )
    await unpack_bundle(zip_path, "local-user-id")
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(fm_id, f"skill-{skill_id}")}
    )
    assert ma is not None
    return fm_id, ma, leaf


async def test_purge_removes_staging_and_ma_rows(tmp_path):
    fm_id, ma, _leaf = await _stage_skill(tmp_path)
    assert fm_data_ops.default_data_dir(fm_id).exists()

    await purge_flow_message_local_data(fm_id)

    assert not fm_data_ops.default_data_dir(fm_id).exists(), "staging dir survived the purge"
    assert await MessageAttachment.get_one({"id": ma.id}) is None, "MA row survived the purge"


async def test_purge_keeps_installed_copy(tmp_path, monkeypatch):
    fm_id, ma, leaf = await _stage_skill(tmp_path)
    user_root = tmp_path / "home"
    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: user_root)
    res = await handle_attachment_install(ma.id, "user", None)
    assert isinstance(res, ApiSuccessResponse)
    installed = user_root / ".claude" / "skills" / leaf / "SKILL.md"
    assert installed.exists()

    await purge_flow_message_local_data(fm_id)

    # The user's installed asset is NOT the message's data — it stays.
    assert installed.exists(), "purge must never remove installed copies"
    assert not fm_data_ops.default_data_dir(fm_id).exists()
