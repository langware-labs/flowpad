"""A shared project rides its invite message as a git reference (FLOWPAD-2194).

Every other shared entity travels in the message bundle and is staged as a
MessageAttachment on arrival; a project used to travel as a bare ``project-<id>``
reference that packed nothing, so the recipient had nothing to install from
unless a separate hub fetch happened to run. The project now declares
the git-reference config (``TypeInfo.receive_transfer``) the artifact and folder
use: its row plus its git origin ride, no repository bytes — in BOTH transfer
modes, since the work lives in the repository and the recipient clones it at
install. ``Project``'s reference hooks hold what is particular to a project.

On arrival the reference is staged like any other attachment, and the row is
written only at install, through the hub membership mirror.

The bundle round trip is real (``pack_bundle`` → zip → ``unpack_bundle``); the
local DB is real; the hub is offline (a recipient may not reach it).
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from uuid import uuid4

import pytest

import flow_sdk.builtin.agentic_process.agentic_process as agentic_process
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.drivers.git_driver import GitOriginDriver
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.cloud_client.transport import hub_http
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.responses.response import ApiSuccessResponse


@pytest.fixture(autouse=True)
def _records(tmp_records_root):
    return tmp_records_root


@pytest.fixture(autouse=True)
def _hub_offline(monkeypatch):
    async def _offline(*args, **kwargs):
        raise HubError(0, "no hub in this test")

    monkeypatch.setattr(hub_http, "hub_get_or_raise", _offline)


def _origin() -> GitOrigin:
    return GitOrigin(rel_path=".", provider="github", owner="langware-labs", name="ai-course", branch="main")


async def _shared_project(tmp_path: Path, *, origin: GitOrigin | None) -> Project:
    mount = tmp_path / "sender-checkout"
    mount.mkdir()
    # Project names are unique per desktop, and the test DB keeps rows across tests.
    pid = str(uuid4())
    project = Project(id=pid, name=f"ai-course-{pid[:8]}", origin=origin, fs_storage_mount_path=str(mount), locale="he")
    return await project.save(notify=False)


async def _send_invite(project: Project, dest: Path, *, transfer_mode: str = "copy") -> tuple[FlowMessage, Path]:
    fm = FlowMessage(id=str(uuid4()), text="I shared a project with you")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"project-{project.id}")]
    return fm, await pack_bundle(fm, dest_dir=dest, transfer_mode=transfer_mode)


async def _pack_invite(project: Project, dest: Path, *, transfer_mode: str) -> zipfile.ZipFile:
    _, zip_path = await _send_invite(project, dest, transfer_mode=transfer_mode)
    return zipfile.ZipFile(zip_path)


async def _receive(project: Project, tmp_path: Path, *, recipient_has_row: bool = False) -> MessageAttachment:
    """Pack the invite, make this DB the recipient's, unpack; the staged row."""
    fm, zip_path = await _send_invite(project, tmp_path / "out")
    if not recipient_has_row:
        await (await Project.get_one({"id": project.id})).destroy()
    await unpack_bundle(zip_path, "local-user-id")
    ma_id = MessageAttachment.allocate_deterministic_id(fm.id, f"project-{project.id}")
    return await MessageAttachment.get_one({"id": ma_id})


@pytest.mark.parametrize("transfer_mode", ["copy", "git"])
async def test_the_project_packs_as_a_git_reference_in_either_mode(tmp_path, transfer_mode):
    project = await _shared_project(tmp_path, origin=_origin())
    key = f"project-{project.id}"

    with await _pack_invite(project, tmp_path / "out", transfer_mode=transfer_mode) as zf:
        transfers = json.loads(zf.read("git_transfers.json"))
        origins = json.loads(zf.read("fs_origins.json"))
        metadata = json.loads(zf.read(transfers[key]["metadata_path"]))

    assert transfers[key]["transfer_mode"] == "git"
    assert origins[key]["owner"] == "langware-labs" and origins[key]["name"] == "ai-course"
    assert (metadata["type"], metadata["id"]) == ("project", project.id)
    assert metadata["name"] == project.name and metadata["locale"] == "he"


async def test_the_senders_checkout_stays_on_the_senders_machine(tmp_path):
    project = await _shared_project(tmp_path, origin=_origin())
    git_folder, local_folder = f"folder-{uuid4()}", f"folder-{uuid4()}"
    project.shared_context_entities = [git_folder, local_folder]
    project.shared_context_origins = {
        git_folder: _origin().model_dump(mode="json"),
        local_folder: {"kind": "local", "base": str(tmp_path / "sender-notes"), "rel_path": "."},
    }
    await project.save(notify=False)

    with await _pack_invite(project, tmp_path / "out", transfer_mode="copy") as zf:
        transfers = json.loads(zf.read("git_transfers.json"))
        metadata_text = zf.read(transfers[f"project-{project.id}"]["metadata_path"]).decode()

    metadata = json.loads(metadata_text)
    assert "fs_storage_mount_path" not in metadata
    assert "sender-checkout" not in metadata_text and "sender-notes" not in metadata_text
    # A git context folder can be resolved on the recipient's machine; a local
    # one is a path on this machine only.
    assert list(metadata["shared_context_origins"]) == [git_folder]


async def test_the_project_row_never_rides_as_an_overlay_envelope(tmp_path):
    """The install overlay applies every entities.json envelope whose row
    exists, so a project envelope would write the sender's copy over the
    recipient's hub-mirrored row. The row travels only as the reference."""
    project = await _shared_project(tmp_path, origin=_origin())

    with await _pack_invite(project, tmp_path / "out", transfer_mode="copy") as zf:
        entities = json.loads(zf.read("entities.json")) if "entities.json" in zf.namelist() else {}

    assert f"project-{project.id}" not in entities


async def test_a_project_with_no_git_origin_packs_no_reference(tmp_path):
    project = await _shared_project(tmp_path, origin=None)

    with await _pack_invite(project, tmp_path / "out", transfer_mode="copy") as zf:
        names = zf.namelist()
        transfers = json.loads(zf.read("git_transfers.json")) if "git_transfers.json" in names else {}

    assert f"project-{project.id}" not in transfers


async def test_the_invite_stages_the_project_for_review(tmp_path):
    project = await _shared_project(tmp_path, origin=_origin())

    ma = await _receive(project, tmp_path)

    assert ma is not None, "the invite staged no attachment for the project"
    assert (ma.asset_type, ma.asset_id) == ("project", project.id)
    assert ma.transfer_mode == "git" and ma.origin.name == "ai-course"
    assert not ma.scope, "a received project waits for the recipient to install it"
    assert await Project.get_one({"id": project.id}) is None, "staging writes no row"


@pytest.fixture
def git_clone(tmp_path, monkeypatch):
    """Stub the clone at the origin driver; the install path above it is real.
    ``clones`` counts calls; set ``fail`` to make the clone raise."""
    state = {"clones": 0, "fail": None, "checkout": tmp_path / "recipient-checkout"}

    async def _materialize(_self, _origin, **_kwargs):
        state["clones"] += 1
        if state["fail"]:
            raise RuntimeError(state["fail"])
        state["checkout"].mkdir(exist_ok=True)
        return state["checkout"], None

    async def _index(_path, **_kwargs):
        return None

    async def _token():
        return None

    monkeypatch.setattr(GitOriginDriver, "materialize", _materialize)
    monkeypatch.setattr(agentic_process, "_index_additional_dir", _index)
    monkeypatch.setattr("flow_sdk.app.actions.oauth_action._get_github_token_for_current_user", _token)
    return state


async def test_install_clones_the_project_and_records_it_on_the_attachment(tmp_path, git_clone):
    project = await _shared_project(tmp_path, origin=_origin())
    ma = await _receive(project, tmp_path)

    res = await handle_attachment_install(ma.id, "user", None)

    assert isinstance(res, ApiSuccessResponse), res.message
    # The row lands through the hub membership mirror, from the reference alone.
    row = await Project.get_one({"id": project.id})
    assert row is not None and row.name == project.name and row.locale == "he"
    assert row.origin.owner == "langware-labs" and row.remote is True
    # The recipient's checkout is its own clone, never the sender's path.
    assert row.fs_storage_mount_path == canonical_posix_path(str(git_clone["checkout"]))
    installed = await MessageAttachment.get_one({"id": ma.id})
    # Installed like any git download: globally, the checkout is where it lives.
    assert installed.scope == "user" and installed.project_id is None


async def test_installing_a_project_already_set_up_here_does_not_clone_again(tmp_path, git_clone):
    """The hub mirror owns an existing row; a message bundle is a snapshot from
    when it was sent and must not roll a newer row back."""
    project = await _shared_project(tmp_path, origin=_origin())
    ma = await _receive(project, tmp_path, recipient_has_row=True)
    row = await Project.get_one({"id": project.id})
    renamed = f"{project.name} (renamed since)"
    row.name = renamed
    await row.save(notify=False)

    res = await handle_attachment_install(ma.id, "user", None)

    assert isinstance(res, ApiSuccessResponse), res.message
    assert (await Project.get_one({"id": project.id})).name == renamed
    assert git_clone["clones"] == 0
    assert (await MessageAttachment.get_one({"id": ma.id})).scope == "user"


async def test_a_failed_clone_surfaces_and_leaves_the_project_to_retry(tmp_path, git_clone):
    project = await _shared_project(tmp_path, origin=_origin())
    ma = await _receive(project, tmp_path)
    git_clone["fail"] = "Repository not found"

    with pytest.raises(RuntimeError, match="Repository not found"):
        await handle_attachment_install(ma.id, "user", None)

    assert not (await MessageAttachment.get_one({"id": ma.id})).scope, "still staged, so Install can retry"
