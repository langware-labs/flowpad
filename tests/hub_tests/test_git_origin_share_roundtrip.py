"""Live-hub GitOrigin share round-trip.

This is the hub transport counterpart to ``tests/unit/test_git_origin_e2e_roundtrip.py``:
the sender packs a git-backed skill, uploads the ``body.flowmsg`` through the
real local hub, then the receiver-side download path pulls that same bundle and
materializes the asset into a mapped project at the sender's repo-relative path.
"""
from __future__ import annotations

import subprocess
import time
import uuid
from pathlib import Path

import httpx
import pytest

# Wire the full entity registry. Pytest does not run the server startup path.
import flow_sdk.models.entities  # noqa: F401

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import (
    AttachmentType,
    BODY_FILENAME,
    BodyStatus,
    FlowMessage,
)
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.schema.types import EntityType


pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]

REL_PATH = "tools/kit/.claude/skills/hubgit"


def _login(hub_login_payload):
    from tests.hub_tests._local_login import login_as

    return login_as(hub_login_payload)


def _init_repo(root: Path) -> None:
    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)

    git("init", "-q")
    git("remote", "add", "origin", "https://github.com/Acme/HubGit.git")
    git("checkout", "-q", "-b", "feature/share")
    git("config", "user.email", "qa@example.test")
    git("config", "user.name", "QA")
    git("add", "-A")
    git("commit", "-qm", "init")


async def test_git_origin_asset_body_round_trips_through_live_hub(
    tmp_path: Path,
    hub_base_url,
    hub_login_payload,
    isolated_hub_keyring,
) -> None:
    api_key = _login(hub_login_payload)

    skill_id = str(uuid.uuid4())
    sender_repo = tmp_path / "sender_repo"
    skill_dir = sender_repo / REL_PATH
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nid: {skill_id}\nname: hubgit\n---\n\n# hub git skill\n",
        encoding="utf-8",
    )
    _init_repo(sender_repo)

    sender_skill = Skill(id=skill_id, name="hubgit", asset_ref=str(skill_dir))
    await sender_skill.save(notify=False)

    conv = Conversation(title=f"hub-git-origin-{int(time.time())}")
    await conv.share()
    assert conv.remote is True

    data = await conv.add_message(
        "git-backed skill",
        attachments=[
            {
                "attachment_type": AttachmentType.TYPE_ID.value,
                "data": f"{EntityType.SKILL.value}-{skill_id}",
            }
        ],
    )
    assert data.get("body_status") == BodyStatus.UPLOADING.value, data

    fm = FlowMessage.model_validate(data)
    assert fm.has_body() is True
    await fm.upload_body()
    assert fm.body_status == BodyStatus.READY

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/flow_message/{fm.id}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
    assert r.status_code == 200, r.text
    on_hub = r.json()["data"]
    assert on_hub["body_status"] == BodyStatus.READY.value
    assert on_hub["attachment_filename"] == BODY_FILENAME

    receiver_project_root = tmp_path / "receiver_project"
    receiver_project_root.mkdir()
    project = Project(name="hub-git-receiver", fs_storage_mount_path=str(receiver_project_root))
    await project.save(notify=False)
    conv.project_id = project.id
    await conv.save(notify=False)

    await sender_skill.delete()

    await fm.download_body()

    expected = receiver_project_root / REL_PATH / "SKILL.md"
    assert expected.exists(), (
        f"downloaded hub body did not restore the skill at {expected}; "
        f"found: {[str(p) for p in receiver_project_root.rglob('SKILL.md')]}"
    )

    received_skill = await Skill.get_one({"id": skill_id})
    assert received_skill is not None, "receiver did not materialize the shared skill"
    git_origin = received_skill.git_origin
    assert git_origin and git_origin.get("rel_path") == REL_PATH
    assert git_origin.get("owner") == "Acme"
    assert git_origin.get("name") == "HubGit"
    assert git_origin.get("branch") == "feature/share"
