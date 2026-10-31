"""A standalone .html file in a repo travels as a git pointer, not a copy.

The file is registered as an artifact (``Artifact.for_shared_file``) that
names it; packed in git mode it rides as metadata + origin (zero bytes);
installing it brings the shared commit into the receiver's own checkout (a
cherry-pick on another branch) — the shared version, even after the sender
moved on — and the receiver finds it by name.
"""

from __future__ import annotations

import uuid
import zipfile
from pathlib import Path

import pytest

from flow_sdk.app.actions.git_share_preflight_action import git_share_preflight
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.core import Entity
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.builtin.drivers.git_driver import share_consent
from flow_sdk.builtin.project import Project
from tests.unit.git_share._world import BRANCH, git

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

REL = "platform/docs/nudge_backoffice_mock.html"


def _seed(tmp_path: Path, token: str) -> tuple[Path, Path]:
    remote, sender = tmp_path / "remote.git", tmp_path / "sender" / "repo"
    git(tmp_path, "init", "--bare", "-q", "-b", "main", str(remote))
    sender.parent.mkdir(parents=True)
    git(tmp_path, "clone", "-q", remote.as_uri(), str(sender))
    git(sender, "config", "user.email", "s@t.co")
    git(sender, "config", "user.name", "s")
    (sender / "README.md").write_text("seed\n", encoding="utf-8")
    git(sender, "add", "-A")
    git(sender, "commit", "-qm", "seed")
    git(sender, "push", "-q", "-u", "origin", "HEAD:main")
    git(sender, "checkout", "-q", "-b", BRANCH)
    page = sender / REL
    page.parent.mkdir(parents=True)
    page.write_text(f"<html><body>{token}</body></html>\n", encoding="utf-8")
    git(sender, "add", "-A")
    git(sender, "commit", "-qm", "mock")
    git(sender, "push", "-q", "-u", "origin", BRANCH)
    return remote, sender


async def test_html_file_rides_as_a_git_pointer_into_my_checkout(tmp_path):
    token = f"nudge{uuid.uuid4().hex[:10]}"
    remote, sender = _seed(tmp_path, token)
    pinned = git(sender, "rev-parse", "HEAD")

    art = await Artifact.for_shared_file(str(sender / REL))
    again = await Artifact.for_shared_file(str(sender / REL))
    assert again.id == art.id, "one file must map to one artifact"
    pre = await git_share_preflight("artifact", art.id)
    assert pre["available"], pre

    key = f"artifact-{art.id}"
    fm = FlowMessage(
        text="mock",
        sender_name="s",
        conversation_id=str(uuid.uuid4()),
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=key)],
    )
    fm.id = str(uuid.uuid4())
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")
    with zipfile.ZipFile(zip_path) as zf:
        assert not any(n.endswith(".html") for n in zf.namelist()), "the page's bytes rode the bundle"
    await art.delete()

    # The sender moves on before the receiver opens it.
    (sender / REL).write_text("<html>newer</html>\n", encoding="utf-8")
    git(sender, "commit", "-qam", "newer")
    git(sender, "push", "-q", "origin", BRANCH)

    mine = tmp_path / "receiver" / "repo"
    mine.parent.mkdir(parents=True, exist_ok=True)
    git(tmp_path, "clone", "-q", "--branch", "main", remote.as_uri(), str(mine))
    project = Project(name=f"recv-{uuid.uuid4().hex[:8]}", fs_storage_mount_path=str(mine))
    await project.save(notify=False)

    await Conversation(id=fm.conversation_id, title="share").save(notify=False)
    await unpack_bundle(zip_path, local_user_id="receiver")
    ma_id = MessageAttachment.allocate_deterministic_id(fm.id, key)
    asked = await handle_attachment_install(ma_id, "project", project.id)
    assert (asked.data or {}).get("needs") == "apply", getattr(asked, "data", asked)
    assert (asked.data or {})["plan"]["commits"] == [pinned]
    with share_consent(True):
        res = await handle_attachment_install(ma_id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    show = (res.data or {}).get("show") or {}
    assert show.get("kind") != "entity", f"a shared page must open as the file, not the artifact: {show}"

    got = await Artifact.get_one({"id": art.id})
    assert got is not None and got.asset_ref, "the receiver cannot open the shared page"
    opened = Path(got.asset_ref)
    assert opened.resolve() == (mine / REL).resolve(), "the page is not in the receiver's checkout"
    assert token in opened.read_text(encoding="utf-8"), "the receiver did not get the shared version"
    assert git(mine, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert f"cherry picked from commit {pinned}" in git(mine, "log", "-1", "--format=%B")
    found = await Artifact.shared_file_at(str(opened))
    assert found is not None and found.id == art.id, "the page viewer cannot find the shared page by its path"
    hits = await Entity.search("nudge_backoffice_mock", record_type="artifact")
    assert any(h.id == art.id for h in hits), "the shared page is not findable by name"

