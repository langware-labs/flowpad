"""Conversation → project binding: install fan-out + reception auto-link.

Two behaviors, real test DB + real ``unpack_bundle`` staging + real FSIndexer —
the path the review modal's "Install in project" pick now drives:

1. ``handle_conversation_install_all`` — picking a project for one attachment
   binds the WHOLE conversation: every staged attachment tagged to that
   conversation installs into the project (idempotent; rows already in the
   project are skipped, not reinstalled).

2. Reception auto-link — when a conversation is ALREADY bound to a project
   (``conversation.project_id`` set), ``unpack_bundle`` auto-installs newly
   arriving attachments straight into that project instead of leaving them
   staged / user-scoped.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import uuid
import zipfile
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — full registry (skill/spec resolve)
from flow_sdk.app.actions.message_attachment_action import handle_conversation_install_all
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.responses.response import ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class Ids:
    """Fresh ids per test — the module shares one DB session, so a re-used FM
    id would trip the top-level FlowMessage exists-conflict on the 2nd unpack."""

    def __init__(self):
        self.fm = str(uuid.uuid4())
        self.conv = str(uuid.uuid4())
        self.skill = str(uuid.uuid4())
        self.spec = str(uuid.uuid4())
        self.skill_key = f"skill-{self.skill}"
        self.leaf = f"staged-skill-{self.skill[:8]}"
        self.spec_leaf = f"staged-spec-{self.spec[:8]}"


@pytest.fixture
def ids() -> Ids:
    return Ids()


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


def _write_bundle(tmp_path: Path, ids: Ids, *, conversation_id: str | None) -> Path:
    """A .flowmsg carrying one folder-layout skill + one spec, tagged (via the
    top-level header's ``conversation_id``) to a conversation so the staged
    MessageAttachment rows carry it."""
    fm_data = {
        "id": ids.fm,
        "type": "flow_message",
        "text": "carrier",
        "attachment": [
            {"attachment_type": "type_id", "data": f"skill-{ids.skill}"},
            {"attachment_type": "type_id", "data": f"spec-{ids.spec}"},
        ],
    }
    if conversation_id:
        fm_data["conversation_id"] = conversation_id
    zip_path = tmp_path / "bundle.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("header.json", json.dumps(fm_data))
        zf.writestr(
            f"attachment/{ids.skill_key}/.claude/skills/{ids.leaf}/SKILL.md",
            f"---\nid: {ids.skill}\nname: {ids.leaf}\ndescription: a staged skill\n---\n\n# staged\n",
        )
        zf.writestr(
            f"attachment/spec-{ids.spec}/agentic-assets/spec/{ids.spec_leaf}/spec.md",
            f"---\nid: {ids.spec}\ntitle: staged spec\nspec_type: plan\n---\n\n# spec\n",
        )
    return zip_path


async def _make_project(tmp_path: Path, name: str) -> Project:
    # ``tmp_records_root`` deliberately makes ``tmp_path`` the internal record
    # store for this test. A real project must not live inside that store, so
    # place its mount in a unique sibling directory.
    root = tmp_path.parent / f"{tmp_path.name}-{name}-project"
    root.mkdir()
    project = Project(name=name, fs_storage_mount_path=str(root))
    await project.save(notify=False)
    return project


async def test_install_all_fans_out_to_every_attachment(tmp_path, ids):
    # Stage a 2-attachment bundle tagged to a conversation. Nothing installed yet.
    await unpack_bundle(_write_bundle(tmp_path, ids, conversation_id=ids.conv), "local-user-id")
    staged = await MessageAttachment.get_all({"conversation_id": ids.conv})
    assert len(staged) == 2 and all(m.scope is None for m in staged)
    assert await Skill.get_one({"id": ids.skill}) is None, "nothing indexed pre-install"

    project = await _make_project(tmp_path, "proj")

    # One pick fans out to the whole conversation.
    res = await handle_conversation_install_all(ids.conv, project.id, someone_typeid=None)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert len(res.data["installed"]) == 2 and not res.data["failed"] and not res.data["skipped"]

    # Every attachment now project-scoped + stamped; entities materialized under
    # the project mount.
    for m in await MessageAttachment.get_all({"conversation_id": ids.conv}):
        assert m.scope == "project" and m.project_id == project.id
    skill = await Skill.get_one({"id": ids.skill})
    assert skill is not None and skill.project_id == project.id
    skill_md = Path(project.fs_storage_mount_path) / ".claude" / "skills" / ids.leaf / "SKILL.md"
    assert skill_md.exists(), "fan-out did not copy the skill into the project"

    # Idempotent: a second fan-out skips everything (already in this project).
    res2 = await handle_conversation_install_all(ids.conv, project.id, someone_typeid=None)
    assert isinstance(res2, ApiSuccessResponse)
    assert not res2.data["installed"] and len(res2.data["skipped"]) == 2


async def test_bound_conversation_auto_installs_on_receive(tmp_path, ids):
    # A conversation already bound to a local project (the user picked one for an
    # earlier attachment).
    project = await _make_project(tmp_path, "proj")
    conv = Conversation.model_validate({"id": ids.conv, "project_id": project.id})
    conv.id = ids.conv
    await conv.save(None)

    # Receiving a bundle tagged to that conversation auto-installs its attachments
    # into the bound project — no explicit install pick needed.
    await unpack_bundle(_write_bundle(tmp_path, ids, conversation_id=ids.conv), "local-user-id")

    mas = await MessageAttachment.get_all({"conversation_id": ids.conv})
    assert len(mas) == 2 and all(m.installed for m in mas), "attachments must not stay staged"
    for m in mas:
        assert m.scope == "project" and m.project_id == project.id
    skill = await Skill.get_one({"id": ids.skill})
    assert skill is not None and skill.project_id == project.id
    skill_md = Path(project.fs_storage_mount_path) / ".claude" / "skills" / ids.leaf / "SKILL.md"
    assert skill_md.exists(), "auto-install did not copy the skill into the project"

    # The binding survives receiving the payload (unpack must not wipe project_id).
    reloaded = await Conversation.get_one({"id": ids.conv})
    assert reloaded is not None and reloaded.project_id == project.id
