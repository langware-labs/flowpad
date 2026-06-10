"""GitBranch bundle roundtrip: pack → wipe local rows → unpack re-materializes
the snapshot AND re-mints its deterministic GitRemote parent from the plain
fields (the parent is deliberately never packed). Real test DB, no mocks."""

from __future__ import annotations

import json
import zipfile

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.git_branch import GitBranch
from flow_sdk.builtin.git_remote import GitRemote
from flow_sdk.utils.git_identity import mint_git_remote_id

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FM_ID = "f5f5f5f5-0000-4000-8000-000000000001"


async def test_pack_unpack_reminted_parent(tmp_path):
    remote = await GitRemote.ensure("github", "BundleOrg", "BundleRepo")
    branch = GitBranch(
        branch="release/v1",
        head_commit="abc123",
        taken_at="2026-06-10T00:00:00+00:00",
        provider="github",
        owner="BundleOrg",
        name="BundleRepo",
        parent_type_id=f"git_remote-{remote.id}",
    )
    await branch.save(notify=False)

    fm = FlowMessage(
        text="check out this branch",
        sender_name="Alice",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"git_branch-{branch.id}")],
    )
    fm.id = FM_ID

    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        header_name = f"attachment/git_branch-@{branch.id}/header.json"
        assert header_name in names
        header = json.loads(zf.read(header_name))
        assert header["provider"] == "github"
        assert header["owner"] == "BundleOrg"
        assert header["name"] == "BundleRepo"
        # the registry row itself never travels
        assert not any("git_remote" in n for n in names)

    # Simulate a clean receiver: wipe both local rows.
    await branch.delete()
    await remote.delete()
    assert await GitBranch.get_one({"id": branch.id}) is None
    assert await GitRemote.get_one({"id": remote.id}) is None

    await unpack_bundle(zip_path, local_user_id="receiver")

    restored = await GitBranch.get_one({"id": branch.id})
    assert restored is not None
    assert restored.branch == "release/v1"
    expected_remote_id = mint_git_remote_id("github", "BundleOrg", "BundleRepo")
    assert restored.parent_type_id == f"git_remote-{expected_remote_id}"
    reminted = await GitRemote.get_one({"id": expected_remote_id})
    assert reminted is not None
    assert reminted.full_name == "BundleOrg/BundleRepo"
