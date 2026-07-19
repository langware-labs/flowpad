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

import json
import subprocess
import zipfile
from pathlib import Path

import pytest

# Wire the FULL entity registry (pytest does not run the server's startup
# registration) so get_entity_cls('skill') resolves and the reindex materializes.
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.artifact import Artifact, ArtifactReferenceType, ArtifactType
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import _resolve_git_checkout, pack_bundle, unpack_bundle
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.core import Entity
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    """Unpack persists the bundle + staging tree under the records-data root —
    keep it off the developer's real instance dir."""
    return tmp_records_root


async def _install_staged(fm_id: str, key: str, *, scope: str, project_id: str | None = None) -> MessageAttachment:
    """Reception is now two-phase: unpack STAGES (MessageAttachment, scope=None)
    and the user explicitly installs. This drives the install half the way the
    review modal does, asserting the staged row existed first."""
    ma_id = MessageAttachment.allocate_deterministic_id(fm_id, key)
    ma = await MessageAttachment.get_one({"id": ma_id})
    assert ma is not None, f"unpack did not stage {key}"
    assert ma.scope is None, f"staged attachment must start uninstalled: {ma.scope}"
    res = await handle_attachment_install(ma_id, scope, project_id, someone_typeid=None)
    assert isinstance(res, ApiSuccessResponse), f"install failed: {getattr(res, 'message', res)!r}"
    return ma


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
GIT_ARTIFACT_ID = "a1a1a1a1-0000-4000-8000-000000001111"
GIT_ARTIFACT_CONV_ID = "c1c1c1c1-0000-4000-8000-000000001222"
GIT_ARTIFACT_FM_ID = "f1f1f1f1-0000-4000-8000-000000001333"
GIT_ARTIFACT_TOKEN = "gitartifactwebappgamma"
GIT_MARKDOWN_ID = "a1a1a1a1-0000-4000-8000-000000001444"
GIT_MARKDOWN_CONV_ID = "c1c1c1c1-0000-4000-8000-000000001555"
GIT_MARKDOWN_FM_ID = "f1f1f1f1-0000-4000-8000-000000001666"
GIT_MARKDOWN_TOKEN = "gitmarkdownsearchdelta"
GIT_MARKDOWN_CLONE_ID = "a1a1a1a1-0000-4000-8000-000000001777"
GIT_MARKDOWN_CLONE_CONV_ID = "c1c1c1c1-0000-4000-8000-000000001888"
GIT_MARKDOWN_CLONE_FM_ID = "f1f1f1f1-0000-4000-8000-000000001999"
GIT_MARKDOWN_CLONE_TOKEN = "gitmarkdowncloneepsilon"
GIT_FOLDER_CONV_ID = "c1c1c1c1-0000-4000-8000-000000002222"
GIT_FOLDER_FM_ID = "f1f1f1f1-0000-4000-8000-000000002333"


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
    (skill_dir / "SKILL.md").write_text(f"---\nid: {SKILL_ID}\nname: foo\n---\n\n# foo skill\n", encoding="utf-8")
    _init_repo(sender_repo)

    sender_skill = Skill(id=SKILL_ID, name="foo", asset_ref=str(skill_dir))
    await sender_skill.save(notify=False)

    fm = FlowMessage(
        text="here is the skill",
        sender_name="gx7",
        conversation_id=CONV_ID,
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.SKILL.value}-{SKILL_ID}")],
    )
    fm.id = FM_ID

    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    # --- Receiver: a mapped project; the conversation points at it ------------
    recv_proj = tmp_path / "recv_proj"
    recv_proj.mkdir()
    project = Project(name="reflect-dst", fs_storage_mount_path=str(recv_proj))
    await project.save(notify=False)
    # Local conversation mapped to the receiver project (what the UI's project
    # selection on an incoming share produces); install targets it explicitly.
    conv = Conversation(id=CONV_ID, title="reflect", project_id=project.id)
    await conv.save(notify=False)

    # Wipe the sender's local skill row so the receiver materializes fresh from
    # the unpacked bundle (mirrors a clean receiver).
    await sender_skill.delete()

    # --- Unpack stages; explicit install places + reindexes + stamps ----------
    await unpack_bundle(zip_path, local_user_id="gx8")
    await _install_staged(FM_ID, f"{EntityType.SKILL.value}-{SKILL_ID}", scope="project", project_id=project.id)

    # 1) The skill reconstructed at the SAME repo-relative path (not flattened).
    expected = recv_proj / REL_PATH / "SKILL.md"
    assert expected.exists(), (
        f"skill did not reconstruct at {expected}; found: {[str(p) for p in recv_proj.rglob('SKILL.md')]}"
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
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.SKILL.value}-{GIT_ONLY_SKILL_ID}")
        ],
    )
    fm.id = GIT_ONLY_FM_ID

    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        key = f"{EntityType.SKILL.value}-{GIT_ONLY_SKILL_ID}"
        assert "git_transfers.json" in names
        assert f"metadata/{key}/metadata.json" in names
        assert not any(name.endswith("/SKILL.md") for name in names)

    project = Project(name="reflect-git-dst", fs_storage_mount_path=str(recv_repo))
    await project.save(notify=False)
    conv = Conversation(id=GIT_ONLY_CONV_ID, title="reflect git", project_id=project.id)
    await conv.save(notify=False)

    await sender_skill.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")
    await _install_staged(
        GIT_ONLY_FM_ID, f"{EntityType.SKILL.value}-{GIT_ONLY_SKILL_ID}", scope="project", project_id=project.id
    )

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
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.SKILL.value}-{GIT_CLONE_SKILL_ID}")
        ],
    )
    fm.id = GIT_CLONE_FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")

    conv = Conversation(id=GIT_CLONE_CONV_ID, title="reflect git clone")
    await conv.save(notify=False)

    await sender_skill.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")

    # Consent boundary: NOTHING cloned at download time.
    cloned_root = workspace / "clone-origin"
    expected = cloned_root / REL_PATH / "SKILL.md"
    assert not expected.exists(), "unpack must not clone anymore — install does"

    # No project mapped → the user installs into the user scope; the git-mode
    # restore resolves its own checkout (clones into the agent workspace).
    await _install_staged(GIT_CLONE_FM_ID, f"{EntityType.SKILL.value}-{GIT_CLONE_SKILL_ID}", scope="user")
    assert expected.exists(), f"receiver did not clone/index git transfer into {expected}"
    recv_skill = await Skill.get_one({"id": GIT_CLONE_SKILL_ID})
    assert recv_skill is not None
    assert Path(recv_skill.asset_ref).resolve() == (cloned_root / REL_PATH).resolve()
    assert recv_skill.git_origin and recv_skill.git_origin.get("provider") == "file"
    results = await Entity.search(GIT_CLONE_SEARCH_TOKEN, record_type=EntityType.SKILL.value)
    assert any(result.id == GIT_CLONE_SKILL_ID for result in results), (
        "cloned git-transfer skill materialized but was not searchable via FTS"
    )


async def test_git_checkout_resolution_skips_matching_remote_on_wrong_branch(tmp_path, monkeypatch):
    workspace = tmp_path / "flowpad-workspace"
    monkeypatch.setattr("flow_sdk.config.AGENT_MOUNT_FOLDER", str(workspace))

    origin = tmp_path / "branch-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)

    sender_repo = tmp_path / "sender_branch_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "feature/expected")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    (sender_repo / "expected.txt").write_text("expected branch\n", encoding="utf-8")
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "expected")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/expected")

    _git(sender_repo, "checkout", "-q", "-b", "feature/other")
    (sender_repo / "other.txt").write_text("other branch\n", encoding="utf-8")
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "other")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/other")

    wrong_branch_repo = tmp_path / "wrong_branch_repo"
    _git(tmp_path, "clone", "-q", "--branch", "feature/other", origin.resolve().as_uri(), str(wrong_branch_repo))

    git_origin = GitOrigin.from_url(origin.resolve().as_uri(), branch="feature/expected", rel_path=".")
    assert git_origin is not None

    checkout_root, _ = await _resolve_git_checkout(
        git_origin,
        preferred_root=wrong_branch_repo,
        preferred_project_id=None,
    )

    assert checkout_root.resolve() != wrong_branch_repo.resolve()
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=checkout_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert branch == "feature/expected"


async def test_git_transfer_packs_graph_artifact_metadata_without_copying_app_files(tmp_path):
    origin = tmp_path / "artifact-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)

    sender_repo = tmp_path / "sender_artifact_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "feature/artifact-git-transfer")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    app_dir = sender_repo / "apps" / "shared-webapp"
    app_dir.mkdir(parents=True)
    (app_dir / "index.html").write_text(
        f"<html><body>{GIT_ARTIFACT_TOKEN}</body></html>\n",
        encoding="utf-8",
    )
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "webapp")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/artifact-git-transfer")

    git_origin = GitOrigin.for_asset_path(str(app_dir))
    assert git_origin is not None
    artifact = Artifact(
        id=GIT_ARTIFACT_ID,
        name="shared webapp",
        ref_type=ArtifactReferenceType.FOLDER,
        path=str(app_dir),
        artifact_type=ArtifactType.WEBAPP,
        port="45678",
        git_origin=git_origin,
    )
    await artifact.save(notify=False)

    fm = FlowMessage(
        text="webapp by git",
        sender_name="gx7",
        conversation_id=GIT_ARTIFACT_CONV_ID,
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.ARTIFACT.value}-{GIT_ARTIFACT_ID}")
        ],
    )
    fm.id = GIT_ARTIFACT_FM_ID
    # create_bookmark=True: the receiver must mint a FAVORITE pointing at the
    # artifact when it installs (not at download).
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git", create_bookmark=True)

    key = f"{EntityType.ARTIFACT.value}-{GIT_ARTIFACT_ID}"
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert "git_origins.json" in names
        assert "git_transfers.json" in names
        metadata_name = f"metadata/{key}/metadata.json"
        assert metadata_name in names
        metadata = json.loads(zf.read(metadata_name).decode("utf-8"))
        assert metadata["id"] == GIT_ARTIFACT_ID
        assert metadata["path"] == str(app_dir)
        assert metadata["git_origin"]["rel_path"] == "apps/shared-webapp"
        assert not any(name.endswith("/index.html") for name in names), names

    await artifact.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")

    # STAGED, not materialized: the git-backed artifact now rides the staged→
    # install model like a file-backed asset. Download must NOT create the graph
    # row — a MessageAttachment stands in until the receiver explicitly installs.
    assert await Artifact.get_one({"id": GIT_ARTIFACT_ID}) is None, (
        "artifact must be STAGED at download, not materialized"
    )
    staged = await MessageAttachment.get_one({"asset_id": GIT_ARTIFACT_ID})
    assert staged is not None, "receiver never staged the git-backed artifact"
    assert staged.asset_type == EntityType.ARTIFACT.value
    assert staged.transfer_mode == "git"
    assert staged.create_bookmark is True, "create_bookmark flag lost through staging"
    assert not staged.scope, "staged attachment must not be installed yet"

    # No favorite before install — mint is gated on the explicit install.
    from flow_sdk.builtin.bookmark import Bookmark, BookmarkType  # noqa: PLC0415

    async def _artifact_favorite():
        for b in await Bookmark.get_all({"bookmark_type": BookmarkType.FAVORITE.value}):
            if (b.data or {}).get("entity_id") == GIT_ARTIFACT_ID:
                return b
        return None

    assert await _artifact_favorite() is None

    # INSTALL: materialize the graph row (path='' — checkout resolves at open).
    resp = await handle_attachment_install(str(staged.id), scope="user", project_id=None)
    assert isinstance(resp, ApiSuccessResponse), resp

    fav = await _artifact_favorite()
    assert fav is not None, "install did not mint the artifact favorite"
    assert (fav.data or {}).get("entity_type") == EntityType.ARTIFACT.value
    # The checkout isn't resolved yet, so asset_ref is empty — the favorite
    # navigates by id and the artifact-open path resolves the git checkout.
    assert (fav.data or {}).get("nav", {}).get("asset_ref") == ""

    received = await Artifact.get_one({"id": GIT_ARTIFACT_ID})
    assert received is not None, "install never materialized the git-backed artifact declaration"
    assert received.path == "", "receiver must not trust the sender's local filesystem path"
    assert received.port == "45678"
    received_origin = (
        received.git_origin.model_dump(mode="python")
        if hasattr(received.git_origin, "model_dump")
        else received.git_origin
    )
    assert received_origin and received_origin.get("provider") == "file"
    assert received_origin.get("rel_path") == "apps/shared-webapp"


async def test_git_transfer_markdown_doc_indexes_from_receiver_worktree_and_is_searchable(tmp_path):
    origin = tmp_path / "markdown-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)

    sender_repo = tmp_path / "sender_markdown_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "feature/markdown-git-transfer")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    rel_path = "product/docs/shared-git-doc.md"
    sender_doc = sender_repo / rel_path
    sender_doc.parent.mkdir(parents=True)
    sender_doc.write_text(
        (
            "---\n"
            f"id: {GIT_MARKDOWN_ID}\n"
            "title: Shared Git Markdown\n"
            "---\n\n"
            "# Shared Git Markdown\n\n"
            f"{GIT_MARKDOWN_TOKEN}\n"
        ),
        encoding="utf-8",
    )
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "markdown")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/markdown-git-transfer")

    recv_repo = tmp_path / "recv_markdown_repo"
    _git(
        tmp_path, "clone", "-q", "--branch", "feature/markdown-git-transfer", origin.resolve().as_uri(), str(recv_repo)
    )

    sender_doc_entity = Docs(
        id=GIT_MARKDOWN_ID,
        title="Shared Git Markdown",
        name="Shared Git Markdown",
        asset_ref=str(sender_doc),
    )
    await sender_doc_entity.save(notify=False)

    fm = FlowMessage(
        text="markdown by git",
        sender_name="gx7",
        conversation_id=GIT_MARKDOWN_CONV_ID,
        attachment=[
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.MARKDOWN.value}-{GIT_MARKDOWN_ID}")
        ],
    )
    fm.id = GIT_MARKDOWN_FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")

    key = f"{EntityType.MARKDOWN.value}-{GIT_MARKDOWN_ID}"
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert "git_origins.json" in names
        assert "git_transfers.json" in names
        assert f"metadata/{key}/metadata.json" in names
        assert not any(name.endswith("shared-git-doc.md") for name in names), names

    project = Project(name="reflect-markdown-git-dst", fs_storage_mount_path=str(recv_repo))
    await project.save(notify=False)
    conv = Conversation(id=GIT_MARKDOWN_CONV_ID, title="reflect markdown git", project_id=project.id)
    await conv.save(notify=False)

    await sender_doc_entity.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")
    await _install_staged(
        GIT_MARKDOWN_FM_ID, f"{EntityType.MARKDOWN.value}-{GIT_MARKDOWN_ID}", scope="project", project_id=project.id
    )

    received_doc = await Docs.get_one({"id": GIT_MARKDOWN_ID})
    assert received_doc is not None, "receiver never materialized the git-backed markdown doc"
    assert Path(received_doc.asset_ref).resolve() == (recv_repo / rel_path).resolve()
    assert received_doc.title == "Shared Git Markdown"
    assert GIT_MARKDOWN_TOKEN in (recv_repo / rel_path).read_text(encoding="utf-8")
    assert received_doc.git_origin and received_doc.git_origin.get("provider") == "file"
    assert received_doc.git_origin.get("rel_path") == rel_path

    results = await Entity.search(GIT_MARKDOWN_TOKEN, record_type=EntityType.MARKDOWN.value)
    assert any(result.id == GIT_MARKDOWN_ID for result in results), (
        "git-transferred markdown materialized but was not searchable via FTS"
    )


async def test_git_transfer_markdown_doc_clones_remote_and_is_searchable(tmp_path, monkeypatch):
    workspace = tmp_path / "flowpad-workspace"
    monkeypatch.setattr("flow_sdk.config.AGENT_MOUNT_FOLDER", str(workspace))

    origin = tmp_path / "markdown-clone-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)

    sender_repo = tmp_path / "sender_markdown_clone_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "feature/markdown-clone-transfer")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    rel_path = "research/docs/cloned-git-doc.md"
    sender_doc = sender_repo / rel_path
    sender_doc.parent.mkdir(parents=True)
    sender_doc.write_text(
        (
            "---\n"
            f"id: {GIT_MARKDOWN_CLONE_ID}\n"
            "title: Cloned Git Markdown\n"
            "---\n\n"
            "# Cloned Git Markdown\n\n"
            f"{GIT_MARKDOWN_CLONE_TOKEN}\n"
        ),
        encoding="utf-8",
    )
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "markdown")
    _git(sender_repo, "push", "-q", "-u", "origin", "feature/markdown-clone-transfer")

    sender_doc_entity = Docs(
        id=GIT_MARKDOWN_CLONE_ID,
        title="Cloned Git Markdown",
        name="Cloned Git Markdown",
        asset_ref=str(sender_doc),
    )
    await sender_doc_entity.save(notify=False)

    fm = FlowMessage(
        text="clone markdown by git",
        sender_name="gx7",
        conversation_id=GIT_MARKDOWN_CLONE_CONV_ID,
        attachment=[
            Attachment(
                attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.MARKDOWN.value}-{GIT_MARKDOWN_CLONE_ID}"
            )
        ],
    )
    fm.id = GIT_MARKDOWN_CLONE_FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")

    conv = Conversation(id=GIT_MARKDOWN_CLONE_CONV_ID, title="reflect markdown git clone")
    await conv.save(notify=False)

    await sender_doc_entity.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")

    cloned_root = workspace / "markdown-clone-origin"
    expected = cloned_root / rel_path
    assert not expected.exists(), "unpack must not clone anymore — install does"

    # Git-mode user-scope install: the checkout resolves itself (no .claude
    # layout gate — the root is only a clone preference in git mode).
    await _install_staged(
        GIT_MARKDOWN_CLONE_FM_ID, f"{EntityType.MARKDOWN.value}-{GIT_MARKDOWN_CLONE_ID}", scope="user"
    )
    assert expected.exists(), f"receiver did not clone/index git markdown transfer into {expected}"
    received_doc = await Docs.get_one({"id": GIT_MARKDOWN_CLONE_ID})
    assert received_doc is not None
    assert Path(received_doc.asset_ref).resolve() == expected.resolve()
    assert received_doc.git_origin and received_doc.git_origin.get("provider") == "file"
    assert received_doc.git_origin.get("rel_path") == rel_path

    results = await Entity.search(GIT_MARKDOWN_CLONE_TOKEN, record_type=EntityType.MARKDOWN.value)
    assert any(result.id == GIT_MARKDOWN_CLONE_ID for result in results), (
        "cloned git-transferred markdown materialized but was not searchable via FTS"
    )


async def test_git_transfer_packs_folder_chip_metadata_only_and_install_never_clones(tmp_path):
    """A git context-folder chip (push-notify): pack ships ONLY name + origin —
    no repo bytes, no sender-local path — and install mints the receiver Folder
    from the origin WITHOUT touching the filesystem (the wizard clones/pulls
    later, on the receiver's explicit chip click)."""
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

    origin_bare = tmp_path / "ctx-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin_bare)], check=True, capture_output=True)
    sender_repo = tmp_path / "sender_ctx_repo"
    _git(tmp_path, "clone", "-q", origin_bare.resolve().as_uri(), str(sender_repo))
    _git(sender_repo, "checkout", "-q", "-b", "main")
    _git(sender_repo, "config", "user.email", "t@t.co")
    _git(sender_repo, "config", "user.name", "t")
    (sender_repo / "notes.md").write_text("class notes\n", encoding="utf-8")
    _git(sender_repo, "add", "-A")
    _git(sender_repo, "commit", "-qm", "notes")
    _git(sender_repo, "push", "-q", "-u", "origin", "main")

    folder = await Folder.mint_for_path(str(sender_repo))
    assert folder.origin is not None and folder.origin.transportable, "sender folder must be git-backed"
    folder_id = folder.id

    fm = FlowMessage(
        text="pushed my-class",
        sender_name="gx7",
        conversation_id=GIT_FOLDER_CONV_ID,
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{EntityType.FOLDER.value}-{folder_id}")],
    )
    fm.id = GIT_FOLDER_FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path, transfer_mode="git")

    key = f"{EntityType.FOLDER.value}-{folder_id}"
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert "git_origins.json" in names and "git_transfers.json" in names
        metadata_name = f"metadata/{key}/metadata.json"
        assert metadata_name in names
        metadata = json.loads(zf.read(metadata_name).decode("utf-8"))
        assert metadata["id"] == folder_id
        # The sender-local resolved path must NOT travel.
        assert "path" not in metadata, metadata
        # Repo-root folders must carry a human name (never the "." degenerate).
        assert metadata.get("name") not in (None, "", "."), metadata
        origins = json.loads(zf.read("git_origins.json").decode("utf-8"))
        assert origins[key]["kind"] == "git"
        # Repo bytes never ride the bundle.
        assert not any(name.endswith("notes.md") for name in names), names

    await folder.delete()
    await unpack_bundle(zip_path, local_user_id="gx8")

    # STAGED at download — no Folder row, and certainly no clone.
    assert await Folder.get_one({"id": folder_id}) is None, "folder must be staged, not materialized"
    staged = await MessageAttachment.get_one({"asset_id": folder_id})
    assert staged is not None, "receiver never staged the git folder chip"
    assert staged.asset_type == EntityType.FOLDER.value
    assert staged.transfer_mode == "git"
    assert not staged.scope

    # INSTALL: metadata-only mint — Folder row exists, origin intact, local
    # path UNSET (no clone ran; the chip's wizard resolves a checkout later).
    resp = await handle_attachment_install(str(staged.id), scope="user", project_id=None)
    assert isinstance(resp, ApiSuccessResponse), resp
    received = await Folder.get_one({"id": folder_id})
    assert received is not None, "install never minted the receiver Folder"
    assert not received.path, "install must not clone or set a local path"
    assert received.origin is not None and received.origin.key() == folder.origin.key()
