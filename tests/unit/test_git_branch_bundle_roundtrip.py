"""GitBranch bundle roundtrip: pack → wipe local rows → unpack re-materializes
the snapshot AND re-mints its deterministic GitRemote parent from the plain
fields (the parent is deliberately never packed). Real test DB, no mocks."""

from __future__ import annotations

import json
import zipfile

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import (
    _pack_git_branch_attachment,
    pack_bundle,
    unpack_bundle,
)
from flow_sdk.schema.types import EntityType
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


async def test_pack_git_branch_header_is_exact_whitelist(tmp_path):
    """[PACK-GITBRANCH] header.json carries EXACTLY the whitelisted keys: the
    sender-local ``parent_type_id`` is omitted while ``head_commit`` /
    ``taken_at`` ride along. Also covers the branch-missing no-op path."""
    remote = await GitRemote.ensure("github", "WhitelistOrg", "WhitelistRepo")
    branch = GitBranch(
        branch="feature/whitelist",
        head_commit="deadbeef",
        taken_at="2026-06-20T00:00:00+00:00",
        provider="github",
        owner="WhitelistOrg",
        name="WhitelistRepo",
        parent_type_id=f"git_remote-{remote.id}",
    )
    await branch.save(notify=False)

    attachment_dir = tmp_path / "attachment"
    attachment_dir.mkdir(parents=True, exist_ok=True)
    await _pack_git_branch_attachment(branch.id, attachment_dir)

    header_path = (
        attachment_dir
        / f"{EntityType.GIT_BRANCH.value}-@{branch.id}"
        / "header.json"
    )
    assert header_path.exists()
    header = json.loads(header_path.read_text(encoding="utf-8"))

    expected_keys = {
        "id", "type", "name", "branch", "head_commit", "taken_at",
        "provider", "owner",
    }
    assert set(header.keys()) == expected_keys
    # sender-local parent is deliberately never packed
    assert "parent_type_id" not in header
    # the two snapshot-pin fields ARE present and non-null
    assert header["head_commit"] == "deadbeef"
    assert header["taken_at"] == "2026-06-20T00:00:00+00:00"

    # branch-missing (get_one None) → no entry, pure no-op.
    missing_dir = tmp_path / "missing"
    missing_dir.mkdir(parents=True, exist_ok=True)
    missing_id = "f5f5f5f5-0000-4000-8000-0000000009ff"
    assert await GitBranch.get_one({"id": missing_id}) is None
    await _pack_git_branch_attachment(missing_id, missing_dir)
    assert list(missing_dir.iterdir()) == []

    await branch.delete()
    await remote.delete()
