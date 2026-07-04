"""End-to-end git reflection through the REAL production code + REAL entity
registry (NOT stubbed): a Skill that lives at a NESTED git-repo path is packed
into a .flowmsg by ``pack_bundle`` and ``unpack_bundle``'d into a receiver's
mapped project — and must land at the SAME repo-relative path, with the
materialized receiver entity carrying ``git_origin``.

This is the hub-independent equivalent of the cross-instance share: it drives
the same backend functions the live server runs (the live ``gx7`` backend was
observed packing this bundle and setting body_status=READY), minus the hub
transport. Importing ``flow_sdk.models.entities`` wires the full registry so
``SchemaRegistry.get_entity_cls('skill')`` returns the real ``Skill`` class and
the unpack reindex materializes a real entity from disk.
"""
from __future__ import annotations

import subprocess
import zipfile
from pathlib import Path

import pytest

# Wire the FULL entity registry (pytest does not run the server's startup
# registration) so get_entity_cls('skill') resolves and the reindex materializes.
import flow_sdk.models.entities  # noqa: F401

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

REL_PATH = "tools/kit/.claude/skills/foo"
SKILL_ID = "a1a1a1a1-0000-4000-8000-000000000111"
CONV_ID = "c1c1c1c1-0000-4000-8000-000000000222"
FM_ID = "f1f1f1f1-0000-4000-8000-000000000333"
GIT_ONLY_SKILL_ID = "a1a1a1a1-0000-4000-8000-000000000444"
GIT_ONLY_CONV_ID = "c1c1c1c1-0000-4000-8000-000000000555"
GIT_ONLY_FM_ID = "f1f1f1f1-0000-4000-8000-000000000666"
GIT_ONLY_SEARCH_TOKEN = "gitsearchworktreealpha"
GIT_CLONE_SKILL_ID = "a1a1a1a1-0000-4000-8000-000000000777"
GIT_CLONE_CONV_ID = "c1c1c1c1-0000-4000-8000-000000000888"
GIT_CLONE_FM_ID = "f1f1f1f1-0000-4000-8000-000000000999"
GIT_CLONE_SEARCH_TOKEN = "gitsearchclonebeta"


def _init_repo(root: Path) -> None:
    def g(*a):
        subprocess.run(["git", *a], cwd=root, check=True, capture_output=True, text=True)
    g("init", "-q")
    g("remote", "add", "origin", "https://github.com/Acme/Reflect.git")
    g("checkout", "-q", "-b", "feature/demo")
    g("config", "user.email", "t@t.co")
    g("config", "user.name", "t")
    g("add", "-A")
    g("commit", "-qm", "init")


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


async def test_skill_reflects_same_repo_path_through_real_pack_unpack(tmp_path):
    # --- Sender: a Skill that lives at a NESTED path inside a git repo --------
    sender_repo = tmp_path / "sender_repo"
    skill_dir = sender_repo / REL_PATH
    skill_dir.mkdir(parents=True)
    # Pin the id into frontmatter so the receiver's gen_uuid adopts the SAME id.
    (skill_dir / "SKILL.md").write_text(
        f"---\nid: {SKILL_ID}\nname: foo\n---\n\n# foo skill\n", encoding="utf-8"
    )
    _init_repo(sender_repo)

    sender_skill = Skill(id=SKILL_ID, name="foo", asset_ref=str(skill_dir))
    await sender_skill.save(notify=False)

    fm = FlowMessage(
        text="here is the skill",
        sender_name="gx7",
        conversation_id=CONV_ID,
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID,
                               data=f"{EntityType.SKILL.value}-{SKILL_ID}")],
    )
    fm.id = FM_ID

    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    # --- Receiver: a mapped project; the conversation points at it ------------
    recv_proj = tmp_path / "recv_proj"
    recv_proj.mkdir()
    project = Project(name="reflect-dst", fs_storage_mount_path=str(recv_proj))
    await project.save(notify=False)
    # Local conversation mapped to the receiver project (what the UI's project
    # selection on an incoming share produces). _resolve_project_root_for_conv
    # reads conv.project_id → Project.fs_storage_mount_path.
    conv = Conversation(id=CONV_ID, title="reflect", project_id=project.id)
    await conv.save(notify=False)

    # Wipe the sender's local skill row so the receiver materializes fresh from
    # the unpacked bundle (mirrors a clean receiver).
    await sender_skill.delete()

    # --- Unpack: places the skill + reindexes + stamps git_origin -------------
    await unpack_bundle(zip_path, local_user_id="gx8")

    # 1) The skill reconstructed at the SAME repo-relative path (not flattened).
    expected = recv_proj / REL_PATH / "SKILL.md"
    assert expected.exists(), (
        f"skill did not reconstruct at {expected}; "
        f"found: {[str(p) for p in recv_proj.rglob('SKILL.md')]}"
    )

    # 2) The materialized receiver entity carries git_origin (same id, adopted).
    recv_skill = await Skill.get_one({"id": SKILL_ID})
    assert recv_skill is not None, "receiver never materialized the skill entity"
    go = recv_skill.git_origin
    assert go and go.get("rel_path") == REL_PATH, f"git_origin not stamped correctly: {go}"
    assert go.get("owner") == "Acme" and go.get("branch") == "feature/demo"


async def test_git_transfer_indexes_existing_receiver_worktree_without_copying_bundle_data(tmp_path):
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)

    sender_repo = tmp_path / "sender_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "feature/git-transfer")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    sender_skill_dir = sender_repo / REL_PATH
    sender_skill_dir.mkdir(parents=True)
    (sender_skill_dir / "SKILL.md").write_text(
        f"---\nid: {GIT_ONLY_SKILL_ID}\nname: foo\n---\n\n# foo from git\n\n{GIT_ONLY_SEARCH_TOKEN}\n",
        encoding="utf-8",
    )
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "skill")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/git-transfer")

    recv_repo = tmp_path / "recv_repo"
    _git(tmp_path, "clone", "-q", "--branch", "feature/git-transfer", origin.resolve().as_uri(), str(recv_repo))

    sender_skill = Skill(id=GIT_ONLY_SKILL_ID, name="foo", asset_ref=str(sender_skill_dir))
    await sender_skill.save(notify=False)

    fm = FlowMessage(
        text="here is the skill by git",
        sender_name="gx7",
        conversation_id=GIT_ONLY_CONV_ID,
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID,
                               data=f"{EntityType.SKILL.value}-{GIT_ONLY_SKILL_ID}")],
    )
    fm.id = GIT_ONLY_FM_ID

    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        key = f"{EntityType.SKILL.value}-@{GIT_ONLY_SKILL_ID}"
        assert "git_transfers.json" in names
        assert f"metadata/{key}/metadata.json" in names
        assert not any(name.endswith("/SKILL.md") for name in names)

    project = Project(name="reflect-git-dst", fs_storage_mount_path=str(recv_repo))
    await project.save(notify=False)
    conv = Conversation(id=GIT_ONLY_CONV_ID, title="reflect git", project_id=project.id)
    await conv.save(notify=False)

    await sender_skill.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")

    recv_skill = await Skill.get_one({"id": GIT_ONLY_SKILL_ID})
    assert recv_skill is not None, "receiver never materialized the git-backed skill"
    assert Path(recv_skill.asset_ref).resolve() == (recv_repo / REL_PATH).resolve()
    assert GIT_ONLY_SEARCH_TOKEN in (recv_repo / REL_PATH / "SKILL.md").read_text(encoding="utf-8")
    assert recv_skill.git_origin and recv_skill.git_origin.get("provider") == "file"
    assert recv_skill.git_origin.get("rel_path") == REL_PATH

    results = await Entity.search(GIT_ONLY_SEARCH_TOKEN, record_type=EntityType.SKILL.value)
    assert any(result.id == GIT_ONLY_SKILL_ID for result in results), (
        "git-transferred skill materialized but was not searchable via FTS"
    )


async def test_git_transfer_clones_remote_when_receiver_has_no_checkout(tmp_path, monkeypatch):
    workspace = tmp_path / "flowpad-workspace"
    monkeypatch.setattr("flow_sdk.config.AGENT_MOUNT_FOLDER", str(workspace))

    origin = tmp_path / "clone-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)

    sender_repo = tmp_path / "sender_clone_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "feature/git-clone-transfer")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    sender_skill_dir = sender_repo / REL_PATH
    sender_skill_dir.mkdir(parents=True)
    (sender_skill_dir / "SKILL.md").write_text(
        f"---\nid: {GIT_CLONE_SKILL_ID}\nname: cloned\n---\n\n# cloned from git\n\n{GIT_CLONE_SEARCH_TOKEN}\n",
        encoding="utf-8",
    )
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "skill")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/git-clone-transfer")

    sender_skill = Skill(id=GIT_CLONE_SKILL_ID, name="cloned", asset_ref=str(sender_skill_dir))
    await sender_skill.save(notify=False)

    fm = FlowMessage(
        text="clone the skill by git",
        sender_name="gx7",
        conversation_id=GIT_CLONE_CONV_ID,
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID,
                               data=f"{EntityType.SKILL.value}-{GIT_CLONE_SKILL_ID}")],
    )
    fm.id = GIT_CLONE_FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")

    conv = Conversation(id=GIT_CLONE_CONV_ID, title="reflect git clone")
    await conv.save(notify=False)

    await sender_skill.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")

    cloned_root = workspace / "clone-origin"
    expected = cloned_root / REL_PATH / "SKILL.md"
    assert expected.exists(), f"receiver did not clone/index git transfer into {expected}"
    recv_skill = await Skill.get_one({"id": GIT_CLONE_SKILL_ID})
    assert recv_skill is not None
    assert Path(recv_skill.asset_ref).resolve() == (cloned_root / REL_PATH).resolve()
    assert recv_skill.git_origin and recv_skill.git_origin.get("provider") == "file"
    results = await Entity.search(GIT_CLONE_SEARCH_TOKEN, record_type=EntityType.SKILL.value)
    assert any(result.id == GIT_CLONE_SKILL_ID for result in results), (
        "cloned git-transfer skill materialized but was not searchable via FTS"
    )
