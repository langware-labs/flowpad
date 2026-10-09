"""Files git excludes never leave the machine by accident.

A person's own share (send into a conversation, download a ``.flowmsg``) is refused ONCE with the
list (``share_has_gitignored``) and goes through when they send again with ``include_gitignored``.
Copies nobody chose file by file (the hub push of an entity's folder, the zip a compute node is sent,
the hub-repo publish mirror) leave those files out silently.

Real send handler, real entities, real git — an offline local conversation, as in
``test_send_session_with_missing_transcript``.
"""
from __future__ import annotations

import subprocess
import uuid
import zipfile
from pathlib import Path

import pytest

from flow_sdk.app.actions.notification_action import handle_add_message
from flow_sdk.builtin import flow_message_bundle
from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval

_SENDER = f"user-{uuid.uuid4()}"


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def records_root(tmp_path):
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    try:
        yield tmp_path
    finally:
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)


async def _conversation() -> str:
    conv_id = str(uuid.uuid4())
    await Conversation.model_validate({"id": conv_id, "remote": False}).save(None)
    return conv_id


async def _ignored_session(tmp_path: Path) -> str:
    """A session whose transcript sits in a git repo that excludes it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / ".gitignore").write_text("*.jsonl\n")
    sid = str(uuid.uuid4())
    path = repo / f"{sid}.jsonl"
    path.write_text('{"type":"user","message":{"role":"user","content":"hi"}}\n', encoding="utf-8")
    row = ClaudeSession(name="shared", slug=f"s-{sid[:8]}", asset_ref=str(path))
    row.id = sid
    await row.save(notify=False)
    return sid


def _refused(resp) -> bool:
    return getattr(resp, "status", None) == "FAIL" or getattr(resp, "status_code", 200) >= 400


# ── a person's share: warned once, sent on confirm ────────────────────────────


async def test_a_copy_that_would_carry_excluded_files_is_refused_once_with_the_list(records_root):
    conv_id = await _conversation()
    sid = await _ignored_session(records_root)
    ref = f"claude_session-{sid}"

    resp = await handle_add_message({"conversation_id": conv_id, "message": "look", "asset_references": [ref]}, _SENDER)

    assert _refused(resp) and resp.status_code == 409
    assert resp.data["code"] == "share_has_gitignored"
    assert resp.data["gitignored"] == [{"type_id": ref, "paths": ["."]}]
    assert await FlowMessage.get_all({"conversation_id": conv_id}) == [], "nothing is written before they choose"


async def test_the_same_send_with_include_gitignored_goes_through(records_root):
    conv_id = await _conversation()
    sid = await _ignored_session(records_root)

    resp = await handle_add_message(
        {
            "conversation_id": conv_id,
            "message": "look",
            "asset_references": [f"claude_session-{sid}"],
            "share_config": {"transfer_mode": "copy", "include_gitignored": True},
        },
        _SENDER,
    )

    assert not _refused(resp), getattr(resp, "message", resp)
    assert len(await FlowMessage.get_all({"conversation_id": conv_id})) == 1


async def test_a_folder_reports_what_git_excludes_but_not_what_the_packer_drops_anyway(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    ds = repo / "ds"
    (ds / "examples" / "a").mkdir(parents=True)
    (ds / "examples" / "a" / "input.json").write_text("{}")
    (ds / "node_modules" / "x").mkdir(parents=True)
    (ds / "node_modules" / "x" / "i.js").write_text("")
    (ds / "dataset.json").write_text("{}")
    (ds / ".gitignore").write_text("/examples/\nnode_modules/\n")
    _git(repo, "init", "-q")

    async def _root(tid):
        return ds

    monkeypatch.setattr(flow_message_bundle, "_local_copy_root", _root)
    tid = flow_message_bundle.TypeId(f"dataset-{uuid.uuid4()}")
    assert await flow_message_bundle.attachments_holding_gitignored([tid]) == [(tid, ["examples"])]


async def test_an_export_asks_first_and_packs_whole_on_confirm(records_root):
    from flow_sdk.app.actions.flow_message_action import handle_export_flow_message

    sid = await _ignored_session(records_root)
    ref = f"claude_session-{sid}"

    refused = await handle_export_flow_message({"asset_references": [ref]})
    assert _refused(refused) and refused.data["code"] == "share_has_gitignored"

    exported = await handle_export_flow_message({"asset_references": [ref], "include_gitignored": True})
    with zipfile.ZipFile(exported.path) as zf:
        assert any(n.endswith(f"{sid}.jsonl") for n in zf.namelist())


# ── copies nobody chose: excluded files stay ──────────────────────────────────


def _asset_folder(tmp_path: Path) -> Path:
    root = tmp_path / "repo" / "asset"
    (root / "private").mkdir(parents=True)
    (root / "private" / "row.json").write_text("{}")
    (root / "main.md").write_text("# hi")
    (root / ".gitignore").write_text("/private/\n")
    _git(tmp_path / "repo", "init", "-q")
    return root


async def test_the_hub_push_of_an_entity_folder_leaves_excluded_files(tmp_path, monkeypatch):
    from flow_sdk.actions.fs import fs_actions
    from flow_sdk.utils import hub

    root = _asset_folder(tmp_path)
    sent: list[str] = []

    async def _upload(et, eid, name, content, sub_path="upload"):
        sent.append(f"{sub_path}/{name}")

    monkeypatch.setattr(hub, "hub_upload_entity_file", _upload)

    class _Ent:
        id, typeid = "e1", "skill-e1"

    await fs_actions._push_folder_to_hub("skill", _Ent(), root)

    assert sorted(sent) == ["upload/.gitignore", "upload/main.md"]


def test_the_folder_zip_for_a_compute_node_leaves_excluded_files(tmp_path):
    from flow_sdk.builtin.faas.compute_node import build_dir_zip

    root = _asset_folder(tmp_path)
    with zipfile.ZipFile(build_dir_zip(str(root))) as zf:
        assert sorted(zf.namelist()) == [".gitignore", "main.md"]


def test_the_publish_mirror_leaves_excluded_files(tmp_path):
    from flow_sdk.assets.hub_repo_sync import _replace

    root = _asset_folder(tmp_path)
    target = tmp_path / "mirror" / "asset"
    _replace(root, target, is_file=False)

    assert sorted(p.relative_to(target).as_posix() for p in target.rglob("*")) == [".gitignore", "main.md"]
