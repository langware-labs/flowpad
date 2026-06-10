"""parent_share_on_default: registry flag, share-side expansion, receive-side
deterministic parent materialization (GitBranch → GitRemote)."""

from __future__ import annotations

import pytest

from flow_sdk.builtin.git_branch import GitBranch
from flow_sdk.builtin.git_remote import GitRemote
from flow_sdk.core.entity.parent_share import collect_parent_share_typeids
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.type_info import register_all
from flow_sdk.utils.git_identity import mint_git_remote_id


@pytest.fixture(autouse=True)
def _registered_types():
    register_all()


def test_registry_flag_set_for_git_branch_only():
    assert SchemaRegistry.get("git_branch").parent_share_on_default is True
    assert SchemaRegistry.get("git_remote").parent_share_on_default is False
    assert SchemaRegistry.get("git_repo").parent_share_on_default is False


@pytest.mark.asyncio
async def test_receive_materializes_deterministic_parent():
    payload = {
        "id": "0b8f8f44-7c2a-4f3e-9a64-aaaaaaaaaaaa",
        "type": "git_branch",
        "branch": "main",
        "provider": "github",
        "owner": "ShareOrg",
        "name": "ShareRepo",
    }
    branch = await GitBranch.upsert_from_hub_child(payload, parent_ref=None, notify=False)
    expected_remote_id = mint_git_remote_id("github", "ShareOrg", "ShareRepo")
    assert branch.parent_type_id == f"git_remote-{expected_remote_id}"
    remote = await GitRemote.get_one({"id": expected_remote_id})
    assert remote is not None and remote.full_name == "ShareOrg/ShareRepo"


@pytest.mark.asyncio
async def test_receive_overrides_bogus_wire_parent_and_never_clobbers():
    pre = await GitRemote.ensure("github", "ClobberOrg", "ClobberRepo")
    payload = {
        "id": "0b8f8f44-7c2a-4f3e-9a64-bbbbbbbbbbbb",
        "type": "git_branch",
        "branch": "dev",
        "provider": "github",
        "owner": "ClobberOrg",
        "name": "ClobberRepo",
        "parent_type_id": "git_remote-00000000-0000-4000-8000-000000000000",  # bogus claim
    }
    branch = await GitBranch.upsert_from_hub_child(payload, parent_ref=None, notify=False)
    assert branch.parent_type_id == f"git_remote-{pre.id}"  # mint wins over the wire
    rows = await GitRemote.get_all({"id": pre.id})
    assert len(rows) == 1 and rows[0].owner == "ClobberOrg"  # converged, untouched


@pytest.mark.asyncio
async def test_collect_parent_share_typeids_expands_flagged_types():
    remote = await GitRemote.ensure("github", "ExpandOrg", "ExpandRepo")
    branch = GitBranch(
        branch="main", provider="github", owner="ExpandOrg", name="ExpandRepo",
        parent_type_id=f"git_remote-{remote.id}",
    )
    await branch.save(notify=False)
    tids = [TypeId(f"git_branch-{branch.id}")]
    parents = await collect_parent_share_typeids(tids)
    assert [str(t) for t in parents] == [f"git_remote-{remote.id}"]
    # already-present parent is not duplicated
    parents2 = await collect_parent_share_typeids([*tids, TypeId(f"git_remote-{remote.id}")])
    assert parents2 == []
    # unflagged types contribute nothing
    assert await collect_parent_share_typeids([TypeId(f"git_remote-{remote.id}")]) == []
