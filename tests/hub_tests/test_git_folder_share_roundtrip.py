"""Live-hub Git share of a CONTEXT FOLDER.

The folder counterpart to ``test_git_origin_share_roundtrip.py``. A folder always
travels as a Git origin the receiver clones — never as copied bytes — and unlike a
file-backed asset it has no ``asset_ref`` (a Folder deliberately never owns the
directory it points at), so it packs through the git-REFERENCE path instead.

Covers the wire contract that no eyeball on the sender's screen can check:
  * preflight resolves a FOLDER at all and reports it shareable;
  * the bundle carries ``transfer_mode='git'`` + a GitOrigin and ZERO repo bytes;
  * install materializes the row from that metadata (the clone is a later,
    explicit step — ``Folder.resolve_location``);
  * a folder with no transportable origin FAILS the share instead of silently
    delivering an empty chip.

Sender and receiver share one process/DB here, so this pins the BUNDLE contract.
The actual clone-on-the-other-side (resolve-location → pull → index across two
instances) is ``ui/tests/hub/git_folder_share_two_client.test.ts``.

The origin is a local bare repo over ``file://`` — a first-class GitOrigin
provider — so no GitHub and no auth are involved.
"""
from __future__ import annotations

import subprocess
import time
import uuid
from pathlib import Path

import pytest

# Wire the full entity registry. Pytest does not run the server startup path.
import flow_sdk.models.entities  # noqa: F401

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, BodyStatus, FlowMessage
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(60)]


def _login(hub_login_payload):
    from tests.hub_tests._local_login import login_as

    return login_as(hub_login_payload)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _make_pushed_worktree(tmp_path: Path, token: str) -> tuple[Path, Path]:
    """A bare `file://` remote + a clean, fully pushed worktree — the only state
    a folder share is eligible in."""
    origin = tmp_path / "folder-origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True, capture_output=True)
    worktree = tmp_path / "sender_folder_repo"
    _git(tmp_path, "clone", "-q", origin.resolve().as_uri(), str(worktree))
    _git(worktree, "checkout", "-q", "-b", "main")
    _git(worktree, "config", "user.email", "qa@example.test")
    _git(worktree, "config", "user.name", "QA")
    (worktree / "notes.md").write_text(f"# shared notes\n\n{token}\n", encoding="utf-8")
    _git(worktree, "add", "-A")
    _git(worktree, "commit", "-qm", "notes")
    _git(worktree, "push", "-q", "-u", "origin", "main")
    return origin, worktree


async def test_git_folder_share_round_trips_through_live_hub(
    tmp_path: Path,
    hub_base_url,  # noqa: ARG001 — the live hub fixture must run
    hub_login_payload,
    isolated_hub_keyring,  # noqa: ARG001
) -> None:
    _login(hub_login_payload)
    token = f"folder{uuid.uuid4().hex}"
    _origin, worktree = _make_pushed_worktree(tmp_path, token)

    # A context folder on the sender: minted from the on-disk dir, so its origin
    # is derived from the real repo.
    folder = await Folder.mint_for_path(str(worktree))
    assert folder is not None
    assert folder.origin is not None and folder.origin.transportable, (
        "precondition: a pushed worktree must mint a transportable (git) origin"
    )

    # Preflight agrees this folder is shareable — the same gate the UI runs.
    from flow_sdk.app.actions.git_share_preflight_action import git_share_preflight

    pre = await git_share_preflight(EntityType.FOLDER.value, str(folder.id))
    assert pre["available"] is True, pre
    assert pre["git_origin"]["provider"] == "file"

    conv = Conversation(title=f"hub-git-folder-{int(time.time())}")
    await conv.share()
    assert conv.remote is True

    data = await conv.add_message(
        "a folder for you",
        attachments=[
            {
                "attachment_type": AttachmentType.TYPE_ID.value,
                "data": f"{EntityType.FOLDER.value}-{folder.id}",
            }
        ],
    )
    fm = FlowMessage.model_validate(data)
    await fm.upload_body(transfer_mode="git")
    assert fm.body_status == BodyStatus.READY

    # Receive: download STAGES, an explicit install materializes the row.
    receiver_root = tmp_path / "receiver_project"
    receiver_root.mkdir()
    project = Project(name="hub-git-folder-receiver", fs_storage_mount_path=str(receiver_root))
    await project.save(notify=False)
    conv.project_id = project.id
    await conv.save(notify=False)

    await fm.download_body()

    from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
    from flow_sdk.builtin.message_attachment import MessageAttachment
    from flow_sdk.responses.response import ApiSuccessResponse

    entry_key = f"{EntityType.FOLDER.value}-{folder.id}"
    ma_id = MessageAttachment.allocate_deterministic_id(fm.id, entry_key)
    ma = await MessageAttachment.get_one({"id": ma_id})
    assert ma is not None, "download did not stage the folder"
    # The ORIGIN travelled; the repository bytes did not.
    assert ma.transfer_mode == "git", ma.transfer_mode
    assert ma.origin is not None and ma.origin.provider == "file", ma.origin

    res = await handle_attachment_install(ma_id, "user", None, someone_typeid=None)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)

    received = await Folder.get_one({"id": str(folder.id)})
    assert received is not None, "receiver did not materialize the shared folder"
    assert received.origin is not None and received.origin.kind == "git"


async def test_git_folder_share_without_origin_fails_closed(tmp_path: Path) -> None:
    """A folder with no transportable origin must RAISE under git mode.

    The silent-drop this guards is invisible on the sender's screen: packing used
    to return False, and nothing else packs a FOLDER (it has no main_subdir), so
    the receiver got a chip with no origin and no bytes.
    """
    from flow_sdk.builtin.flow_message_bundle import (
        GitShareOriginError,
        _pack_git_reference_attachment,
    )

    plain = tmp_path / "plain_folder"
    plain.mkdir()
    (plain / "notes.md").write_text("# local only\n", encoding="utf-8")
    folder = await Folder.mint_for_path(str(plain))
    assert folder is not None
    assert folder.origin is not None and not folder.origin.transportable

    attachment_dir = tmp_path / "bundle" / "attachment"
    attachment_dir.mkdir(parents=True)
    with pytest.raises(GitShareOriginError):
        await _pack_git_reference_attachment(
            EntityType.FOLDER.value,
            str(folder.id),
            attachment_dir,
            {},
            None,
            transfers={},
            transfer_mode="git",
        )
