"""A share carries BOTH the git pointer and the bytes; each receiver picks.

One message, three receivers:
- a project that is a checkout of the shared repo opens it by git, in that project;
- anywhere else (another project, the receiver's own folder) opens the copy;
- a checkout whose git cannot reach the shared commit opens the copy and says why.
"""

from __future__ import annotations

import json
import shutil
import uuid
import zipfile
from pathlib import Path

import pytest

from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiSuccessResponse
from tests.unit.git_share._world import git
from tests.unit.git_share.test_html_file_share import REL, _seed

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _share(tmp_path: Path) -> tuple[Path, Path, str, str, str]:
    """Pack the page in ``both`` mode; the sender's row is gone before unpack."""
    token = f"both{uuid.uuid4().hex[:10]}"
    remote, sender = _seed(tmp_path, token)
    art = await Artifact.for_shared_file(str(sender / REL))
    key = f"artifact-{art.id}"
    fm = FlowMessage(
        text="mock",
        sender_name="s",
        conversation_id=str(uuid.uuid4()),
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=key)],
    )
    fm.id = str(uuid.uuid4())
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="both")
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert any(n.endswith(".html") for n in names), "the page's bytes did not ride"
        origins = json.loads(zf.read("fs_origins.json"))
        transfers = json.loads(zf.read("git_transfers.json"))
    assert origins.get(key, {}).get("head_commit"), "the git pointer did not ride"
    assert transfers[key]["transfer_mode"] == "both"
    await art.delete()
    await Conversation(id=fm.conversation_id, title="share").save(notify=False)
    await unpack_bundle(zip_path, local_user_id="receiver")
    return remote, sender, token, art.id, MessageAttachment.allocate_deterministic_id(fm.id, key)


async def _project(root: Path) -> Project:
    project = Project(name=f"recv-{uuid.uuid4().hex[:8]}", fs_storage_mount_path=str(root))
    await project.save(notify=False)
    return project


async def test_a_checkout_of_the_repo_opens_it_by_git_in_that_project(tmp_path):
    remote, sender, token, art_id, ma_id = await _share(tmp_path)
    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", remote.as_uri(), str(mine))
    project = await _project(mine)

    res = await handle_attachment_install(ma_id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert "git_share_error" not in (res.data or {})
    got = await Artifact.get_one({"id": art_id})
    assert got.project_id == project.id, "the page did not open in the receiver's project"
    assert token in Path(got.asset_ref).read_text(encoding="utf-8")
    assert git(Path(got.asset_ref).parent, "rev-parse", "HEAD") == git(sender, "rev-parse", "HEAD")


async def test_anywhere_else_opens_the_copy_never_a_hidden_clone(tmp_path):
    _remote, _sender, token, art_id, ma_id = await _share(tmp_path)
    other = tmp_path / "receiver" / "other"
    other.mkdir(parents=True)
    project = await _project(other)

    res = await handle_attachment_install(ma_id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    got = await Artifact.get_one({"id": art_id})
    opened = Path(got.asset_ref)
    assert opened.is_relative_to(other), f"the copy did not land in the chosen project: {opened}"
    assert ".shared" not in opened.parts
    assert token in opened.read_text(encoding="utf-8")


async def test_git_that_cannot_reach_the_commit_opens_the_copy_and_says_why(tmp_path):
    remote, _sender, token, art_id, ma_id = await _share(tmp_path)
    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", "--single-branch", "--branch", "main", remote.as_uri(), str(mine))
    shutil.rmtree(remote)  # the receiver's git can no longer reach the shared commit
    project = await _project(mine)

    res = await handle_attachment_install(ma_id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert (res.data or {}).get("git_share_error"), "the receiver is not told why git did not open it"
    got = await Artifact.get_one({"id": art_id})
    assert token in Path(got.asset_ref).read_text(encoding="utf-8"), "the copy did not open"


@pytest.mark.parametrize("family", ["markdown", "skill"])
async def test_a_file_backed_asset_opens_by_git_in_a_checkout_and_as_a_copy_elsewhere(tmp_path, family):
    from tests.unit.git_share._world import FAMILIES, World

    world = World(tmp_path, FAMILIES[family])
    world.seed()
    mine = world.receiver_clone()
    res, row = await world.share(project_root=mine, transfer_mode="both")
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert row is not None and Path(row.asset_ref).is_relative_to(mine), "not opened in the receiver's checkout"

    elsewhere = tmp_path / "receiver" / "plain"
    elsewhere.mkdir()
    world2 = World(tmp_path / "w2", FAMILIES[family])
    world2.seed()
    res, row = await world2.share(project_root=elsewhere, transfer_mode="both")
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    copied = world2.family.main_file(elsewhere)
    assert world2.token in copied.read_text(encoding="utf-8"), "the copy did not land in the chosen project"


async def _open(ma_id: str, **kw):
    from flow_sdk.app.actions.message_attachment_action import handle_open_shared

    res = await handle_open_shared(ma_id, **kw)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    return res.data or {}


async def test_one_checkout_opens_there_without_asking_and_binds_the_conversation(tmp_path):
    remote, _sender, _token, art_id, ma_id = await _share(tmp_path)
    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", remote.as_uri(), str(mine))
    project = await _project(mine)

    data = await _open(ma_id)
    assert "needs" not in data and data["project_id"] == project.id
    ma = await MessageAttachment.get_one({"id": ma_id})
    conv = await Conversation.get_one({"id": ma.conversation_id})
    assert conv.project_id == project.id, "the answer was not kept on the conversation"


async def test_two_checkouts_ask_once_then_remember(tmp_path):
    remote, _sender, _token, _art_id, ma_id = await _share(tmp_path)
    for name in ("a", "b"):
        dst = tmp_path / "receiver" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        git(tmp_path, "clone", "-q", remote.as_uri(), str(dst))
        await _project(dst)

    data = await _open(ma_id)
    assert data.get("needs") == "choice" and len(data["candidates"]) == 2
    picked = data["candidates"][1]["id"]
    assert (await _open(ma_id, project_id=picked))["project_id"] == picked
    ma = await MessageAttachment.get_one({"id": ma_id})
    conv = await Conversation.get_one({"id": ma.conversation_id})
    assert conv.project_id == picked


async def test_no_checkout_asks_for_placement_and_copy_opens_in_my_folder(tmp_path):
    _remote, _sender, token, art_id, ma_id = await _share(tmp_path)
    data = await _open(ma_id)
    assert data.get("needs") == "placement" and data["candidates"] == []
    await _open(ma_id, choice="copy")
    got = await Artifact.get_one({"id": art_id})
    assert token in Path(got.asset_ref).read_text(encoding="utf-8")
    assert ".shared" not in Path(got.asset_ref).parts


async def test_a_conversation_bound_elsewhere_warns_of_the_mismatch(tmp_path):
    remote, _sender, _token, _art_id, ma_id = await _share(tmp_path)
    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", remote.as_uri(), str(mine))
    await _project(mine)
    other = tmp_path / "receiver" / "other"
    other.mkdir()
    bound = await _project(other)
    ma = await MessageAttachment.get_one({"id": ma_id})
    conv = await Conversation.get_one({"id": ma.conversation_id})
    conv.project_id = bound.id
    await conv.save(notify=False)

    data = await _open(ma_id)
    assert data["project_id"] == bound.id and data["mismatch"] is True


async def test_no_git_access_sends_the_sharer_a_structured_git_request_access(tmp_path):
    import json as _json

    from flow_sdk.app.actions.message_attachment_action import GIT_ACCESS_REQUEST_KEY, handle_share_reply

    _remote, _sender, _token, _art_id, ma_id = await _share(tmp_path)
    res = await handle_share_reply(ma_id, GIT_ACCESS_REQUEST_KEY)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    ma = await MessageAttachment.get_one({"id": ma_id})
    msgs = await FlowMessage.get_all({"match": {"conversation_id": ma.conversation_id}})
    req = [m for m in msgs if (m.text or "").startswith("Git request access:")]
    assert len(req) == 1, [m.text for m in msgs]
    carrier = next(a for a in req[0].attachment if a.prompt_preview)
    marker = _json.loads(carrier.prompt_preview)[GIT_ACCESS_REQUEST_KEY]
    assert marker["repo_url"] and marker["path"] == REL


async def test_the_sender_project_travels_and_the_receiver_remembers_it(tmp_path):
    from flow_sdk.app.actions.notification_action import _load_project_mapping

    token = f"proj{uuid.uuid4().hex[:8]}"
    remote, sender = _seed(tmp_path, token)
    sender_project = await _project(sender)
    art = await Artifact.for_shared_file(str(sender / REL))
    conv_id = str(uuid.uuid4())
    await Conversation(id=conv_id, title="share", project_id=sender_project.id).save(notify=False)
    key = f"artifact-{art.id}"
    fm = FlowMessage(
        text="m",
        sender_name="s",
        conversation_id=conv_id,
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=key)],
    )
    fm.id = str(uuid.uuid4())
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="both")
    await art.delete()
    conv = await Conversation.get_one({"id": conv_id})
    conv.project_id = None  # the receiver's own row: no project of theirs yet
    await conv.save(notify=False)
    await unpack_bundle(zip_path, local_user_id="receiver")
    assert (await Conversation.get_one({"id": conv_id})).remote_project_id == sender_project.id

    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", remote.as_uri(), str(mine))
    project = await _project(mine)
    # One DB plays both sides, so the sender's clone is a checkout too: pick ours.
    await _open(MessageAttachment.allocate_deterministic_id(fm.id, key), project_id=project.id)
    assert _load_project_mapping().get(sender_project.id) == project.id


async def test_a_newer_version_git_cannot_reach_opens_its_copy_over_the_older_one(tmp_path):
    remote, sender, token, art_id, ma_id = await _share(tmp_path)
    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", "--single-branch", "--branch", "main", remote.as_uri(), str(mine))
    project = await _project(mine)
    assert isinstance(await handle_attachment_install(ma_id, "project", project.id), ApiSuccessResponse)

    # v2 of the same file, shared after the receiver opened v1; then git loses it.
    (sender / REL).write_text("<html>v2</html>\n", encoding="utf-8")
    git(sender, "commit", "-qam", "v2")
    git(sender, "push", "-q", "origin", "HEAD")
    from flow_sdk.builtin.artifact import SHARED_FILE_KIND

    # One DB plays both machines: the sender's row (same id) stands in while it packs.
    received = await Artifact.get_one({"id": art_id})
    art = Artifact(
        id=art_id,
        name="nudge_backoffice_mock.html",
        kind=SHARED_FILE_KIND,
        path=str(sender / REL),
        asset_ref=str(sender / REL),
    )
    await art.save(notify=False)
    key = f"artifact-{art.id}"
    fm = FlowMessage(
        text="v2",
        sender_name="s",
        conversation_id=str(uuid.uuid4()),
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=key)],
    )
    fm.id = str(uuid.uuid4())
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="both")
    await art.delete()
    await received.save(notify=False)
    shutil.rmtree(remote)
    await Conversation(id=fm.conversation_id, title="v2").save(notify=False)
    await unpack_bundle(zip_path, local_user_id="receiver")

    res = await handle_attachment_install(
        MessageAttachment.allocate_deterministic_id(fm.id, key), "project", project.id
    )
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert (res.data or {}).get("git_share_error")
    got = await Artifact.get_one({"id": art_id})
    assert "v2" in Path(got.asset_ref).read_text(encoding="utf-8"), "the older version is still what opens"
