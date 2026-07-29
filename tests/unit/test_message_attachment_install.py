"""Install/uninstall lifecycle of a STAGED MessageAttachment (copy mode).

Real test DB + real FSIndexer + real ``unpack_bundle`` staging — the same path
the review modal drives:

  unpack (stage, scope=None) → install(project|user) → files + entity row +
  scope stamped → uninstall → files removed, entity destroyed, staged copy
  intact → re-install works.

Also: user-scope 400 for project-anchored types, 409 conflict + overwrite
retry, and re-download idempotency (deterministic MA id preserves scope).
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — full registry (skill/spec resolve)

from flow_sdk.app.actions import message_attachment_action as ma_action
from flow_sdk.app.actions.message_attachment_action import (
    handle_attachment_install,
    handle_attachment_uninstall,
    handle_staged_file_content,
    handle_staged_files,
)
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.fs_store.operations import flow_message as fm_data_ops
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SENTINEL = "SENTINEL-staged-skill-body"


class Ids:
    """Fresh ids per test — the module shares one DB session, so a re-used FM
    id would trip the top-level FlowMessage exists-conflict on the 2nd unpack."""

    def __init__(self):
        import uuid
        self.fm = str(uuid.uuid4())
        self.skill = str(uuid.uuid4())
        self.spec = str(uuid.uuid4())
        self.skill_key = f"skill-{self.skill}"
        # Unique leaf name too — skill ids are also derivable from the name.
        self.leaf = f"staged-skill-{self.skill[:8]}"


@pytest.fixture
def ids() -> Ids:
    return Ids()


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


def _write_bundle(tmp_path: Path, ids: Ids, *, body: str = SENTINEL) -> Path:
    """A .flowmsg carrying one folder-layout skill + one spec (project-only)."""
    fm_data = {
        "id": ids.fm,
        "type": "flow_message",
        "text": "carrier",
        "attachment": [
            {"attachment_type": "type_id", "data": f"skill-{ids.skill}"},
            {"attachment_type": "type_id", "data": f"spec-{ids.spec}"},
        ],
    }
    zip_path = tmp_path / "bundle.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("header.json", json.dumps(fm_data))
        zf.writestr(
            f"attachment/{ids.skill_key}/.claude/skills/{ids.leaf}/SKILL.md",
            f"---\nid: {ids.skill}\nname: {ids.leaf}\ndescription: a staged skill\n---\n\n# staged\n\n{body}\n",
        )
        zf.writestr(
            f"attachment/{ids.skill_key}/.claude/skills/{ids.leaf}/helper.py",
            "print('helper')\n",
        )
        zf.writestr(
            f"attachment/spec-{ids.spec}/agentic-assets/spec/staged-spec/spec.md",
            f"---\nid: {ids.spec}\ntitle: staged spec\nspec_type: plan\n---\n\n# spec\n",
        )
    return zip_path


async def _stage(tmp_path: Path, ids: Ids, **kw) -> MessageAttachment:
    await unpack_bundle(_write_bundle(tmp_path, ids, **kw), "local-user-id")
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(ids.fm, ids.skill_key)}
    )
    assert ma is not None, "unpack did not stage the skill"
    return ma


async def test_install_project_scope_copies_indexes_and_stamps(tmp_path, ids):
    ma = await _stage(tmp_path, ids)
    assert ma.scope is None and ma.name == ids.leaf and ma.description == "a staged skill"
    # Nothing indexed pre-install.
    assert await Skill.get_one({"id": ids.skill}) is None

    project_root = tmp_path / "proj"
    project_root.mkdir()
    project = Project(name="dst", fs_storage_mount_path=str(project_root))
    await project.save(notify=False)

    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)

    # Files at the canonical project path; entity row materialized with project_id.
    skill_md = project_root / ".claude" / "skills" / ids.leaf / "SKILL.md"
    assert skill_md.exists() and SENTINEL in skill_md.read_text(encoding="utf-8")
    skill = await Skill.get_one({"id": ids.skill})
    assert skill is not None, "install did not index the skill"
    assert skill.project_id == project.id

    updated = await MessageAttachment.get_one({"id": ma.id})
    assert updated.scope == "project"
    assert updated.project_id == project.id
    assert updated.installed_root == str(project_root)

    # Idempotent re-install (byte-identical) succeeds as a no-op.
    res2 = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res2, ApiSuccessResponse)

    # --- uninstall: files removed, entity destroyed, staged copy intact -------
    res3 = await handle_attachment_uninstall(ma.id)
    assert isinstance(res3, ApiSuccessResponse), getattr(res3, "message", res3)
    assert not skill_md.exists(), "uninstall left the installed file behind"
    assert not (project_root / ".claude" / "skills" / ids.leaf).exists()
    assert await Skill.get_one({"id": ids.skill}) is None, "uninstall left the entity row"
    reset = await MessageAttachment.get_one({"id": ma.id})
    # Cleared form is '' (exclude-none saves can't null a field) — falsy = staged.
    assert not reset.scope and not reset.project_id and not reset.installed_root
    assert not reset.installed
    assert fm_data_ops.staged_entry_dir(ids.fm, ids.skill_key).exists(), "staged copy must persist"

    # --- re-install after uninstall works ------------------------------------
    res4 = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res4, ApiSuccessResponse)
    assert skill_md.exists()
    assert await Skill.get_one({"id": ids.skill}) is not None


async def test_install_user_scope_lands_under_claude_home_root(tmp_path, ids, monkeypatch):
    ma = await _stage(tmp_path, ids)
    user_root = tmp_path / "home"
    user_root.mkdir()
    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: user_root)

    res = await handle_attachment_install(ma.id, "user", None)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert (user_root / ".claude" / "skills" / ids.leaf / "SKILL.md").exists()
    updated = await MessageAttachment.get_one({"id": ma.id})
    assert updated.scope == "user" and updated.project_id is None
    assert updated.installed_root == str(user_root)
    skill = await Skill.get_one({"id": ids.skill})
    assert skill is not None, "user-scope install did not index the skill"


async def test_install_user_scope_allowed_for_repo_type(tmp_path, ids, monkeypatch):
    # spec is a REPO type (agentic-assets/spec) — user+project scope, so a
    # user-scope install is NOT rejected (the old project-anchored 400 applied
    # when spec was INTERNAL). The user-scope policy itself is unit-covered in
    # test_placement_matrix's support cross-product.
    import flow_sdk.app.actions.message_attachment_action as ma_action

    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: tmp_path / "home")
    await _stage(tmp_path, ids)
    spec_ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(ids.fm, f"spec-{ids.spec}")}
    )
    assert spec_ma is not None
    res = await handle_attachment_install(spec_ma.id, "user", None)
    assert not (isinstance(res, ApiFailResponse) and res.status_code == 400)


async def test_install_conflict_409_then_overwrite_replaces(tmp_path, ids):
    ma = await _stage(tmp_path, ids)
    project_root = tmp_path / "proj"
    project = Project(name="dst2", fs_storage_mount_path=str(project_root))
    await project.save(notify=False)

    # A DIFFERENT skill already occupies the destination path.
    dest = project_root / ".claude" / "skills" / ids.leaf / "SKILL.md"
    dest.parent.mkdir(parents=True)
    dest.write_text("---\nname: local\n---\n# LOCAL — do not clobber\n", encoding="utf-8")

    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiFailResponse) and res.status_code == 409
    assert res.data["asset_conflict"] is True
    assert "LOCAL" in dest.read_text(encoding="utf-8"), "conflict must not clobber local bytes"
    # Scope untouched on failure.
    assert (await MessageAttachment.get_one({"id": ma.id})).scope is None

    res2 = await handle_attachment_install(ma.id, "project", project.id, overwrite=True)
    assert isinstance(res2, ApiSuccessResponse)
    assert SENTINEL in dest.read_text(encoding="utf-8")


async def test_redownload_refreshes_staging_and_preserves_install_state(tmp_path, ids, monkeypatch):
    ma = await _stage(tmp_path, ids)
    user_root = tmp_path / "home"
    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: user_root)
    await handle_attachment_install(ma.id, "user", None)

    # Second unpack of an updated bundle: same deterministic MA id, staging
    # refreshed, install state PRESERVED. (overwrite=True — the top-level FM
    # already exists locally, which is exactly the re-download situation.)
    (tmp_path / "bundle.flowmsg").unlink()
    await unpack_bundle(_write_bundle(tmp_path, ids, body="SENTINEL-v2"), "local-user-id", overwrite=True)

    again = await MessageAttachment.get_one({"id": ma.id})
    assert again is not None, "re-download must upsert the same MA row"
    assert again.scope == "user", "re-download must not reset install state"
    staged_md = fm_data_ops.staged_entry_dir(ids.fm, ids.skill_key) / f".claude/skills/{ids.leaf}/SKILL.md"
    assert "SENTINEL-v2" in staged_md.read_text(encoding="utf-8"), "staging not refreshed"


def _write_raw_file_bundle(tmp_path: Path, fm_id: str, fname: str, body: str) -> Path:
    """A .flowmsg carrying one raw FILE attachment (the OS-file-picker lane)."""
    fm_data = {
        "id": fm_id,
        "type": "flow_message",
        "text": "Please see the Spec attached.",
        "attachment": [{"attachment_type": "file", "data": f"attachment/files/{fname}"}],
    }
    zip_path = tmp_path / "file-bundle.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("header.json", json.dumps(fm_data))
        zf.writestr(f"attachment/files/{fname}", body)
    return zip_path


async def _stage_raw_file(tmp_path: Path, fm_id: str, fname: str, body: str) -> MessageAttachment:
    from flow_sdk.api.api_types.identifier import mint_uuid

    await unpack_bundle(_write_raw_file_bundle(tmp_path, fm_id, fname, body), "local-user-id")
    asset_id = mint_uuid(f"flow_message_file:{fm_id}:{fname}")
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(fm_id, f"file-{asset_id}")}
    )
    assert ma is not None, "unpack did not stage the raw file"
    return ma


async def test_raw_file_install_project_then_user_then_uninstall(tmp_path, monkeypatch):
    """A raw markdown file rides the full staged→install→uninstall lifecycle:
    project scope copies to <project>/docs/<name> and indexes it as a
    MARKDOWN record; user scope copies to <home>/docs/<name>; uninstall
    removes the file and reverts to staged. Regression for SAPAK-DEMO-SPEC.md."""
    import uuid

    from flow_sdk.builtin.claude_memory_entities import Markdown

    fm_id = str(uuid.uuid4())
    fname = "SAPAK-DEMO-SPEC.md"
    body = "# SAPAK Demo Spec\n\nStaged raw-file body.\n"
    ma = await _stage_raw_file(tmp_path, fm_id, fname, body)
    assert not ma.scope and ma.asset_type == "file" and ma.name == fname
    assert ma.user_scope_allowed is True

    # --- project scope --------------------------------------------------------
    project_root = tmp_path / "proj"
    project_root.mkdir()
    project = Project(name="dst", fs_storage_mount_path=str(project_root))
    await project.save(notify=False)

    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    installed = project_root / "docs" / fname
    assert installed.exists() and "Staged raw-file body." in installed.read_text(encoding="utf-8")
    # Markdown record materialized under the project (the docs walker
    # emits it as a Docs/Markdown row stamped with the project).
    md_rows = await Markdown.get_all({"project_id": project.id})
    stem = fname.rsplit(".", 1)[0]
    assert any(
        stem in (getattr(m, "name", "") or getattr(m, "title", "") or "") for m in md_rows
    ), f"install did not index the markdown ({[getattr(m, 'name', None) for m in md_rows]})"
    updated = await MessageAttachment.get_one({"id": ma.id})
    assert updated.scope == "project" and updated.project_id == project.id
    assert updated.installed_root == str(project_root)

    # --- uninstall reverts to staged -----------------------------------------
    res2 = await handle_attachment_uninstall(ma.id)
    assert isinstance(res2, ApiSuccessResponse), getattr(res2, "message", res2)
    assert not installed.exists(), "uninstall left the installed file behind"
    reset = await MessageAttachment.get_one({"id": ma.id})
    assert not reset.scope and not reset.installed
    assert fm_data_ops.staged_entry_dir(fm_id, ma.unpacked_path.split("/")[-1]).exists()

    # --- user scope (install for me) ------------------------------------------
    user_root = tmp_path / "home"
    user_root.mkdir()
    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: user_root)
    res3 = await handle_attachment_install(ma.id, "user", None)
    assert isinstance(res3, ApiSuccessResponse), getattr(res3, "message", res3)
    assert (user_root / "docs" / fname).exists()
    again = await MessageAttachment.get_one({"id": ma.id})
    assert again.scope == "user" and again.installed_root == str(user_root)


async def test_staged_read_surface_lists_and_reads(tmp_path, ids):
    ma = await _stage(tmp_path, ids)

    res = await handle_staged_files(ma.id)
    assert isinstance(res, ApiSuccessResponse)
    paths = {f["path"] for f in res.data["files"]}
    assert f".claude/skills/{ids.leaf}/SKILL.md" in paths
    assert f".claude/skills/{ids.leaf}/helper.py" in paths
    assert res.data["main_file"] == f".claude/skills/{ids.leaf}/SKILL.md"
    assert Path(res.data["abs_root"]).is_dir()

    content = await handle_staged_file_content(ma.id, f".claude/skills/{ids.leaf}/SKILL.md")
    assert isinstance(content, ApiSuccessResponse)
    assert SENTINEL in content.data["content"] and content.data["truncated"] is False

    # Path traversal is refused.
    bad = await handle_staged_file_content(ma.id, "../../../etc/passwd")
    assert isinstance(bad, ApiFailResponse) and bad.status_code == 400
