"""A received ``.zip`` stages as the folder it holds, never as the archive.

Real test DB + real ``unpack_bundle`` + real install — the path the review
dialog drives:

* an untyped zip stages as a ``file`` row whose staged copy is the extracted
  folder; "Copy to project" lands ``<project>/<stem>/…`` (no ``.zip``);
* a zipped skill folder stages as a ``skill`` and installs at the skill's
  canonical place, and the row adopts the id the indexer minted for it;
* ``safe_extract_zip`` refuses zip-slip and size-capped archives, skips symlinks;
* ``extract_preview`` extracts once, reuses, and re-extracts once wiped.
"""
from __future__ import annotations

import io
import json
import shutil
import stat
import uuid
import zipfile
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — full registry (skill resolves)
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install, handle_staged_files
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.utils import archive
from flow_sdk.utils.archive import UnsafeArchiveError, extract_preview, safe_extract_zip
from tests.unit._project_names import unique_project_name

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


def _zip_bytes(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, body in members.items():
            zf.writestr(name, body)
    return buf.getvalue()


def _bundle_with_file(tmp_path: Path, fm_id: str, fname: str, payload: bytes) -> Path:
    fm_data = {
        "id": fm_id,
        "type": "flow_message",
        "text": "logs attached",
        "attachment": [{"attachment_type": "file", "data": f"attachment/files/{fname}"}],
    }
    path = tmp_path / f"{fm_id}.flowmsg"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("header.json", json.dumps(fm_data))
        zf.writestr(f"attachment/files/{fname}", payload)
    return path


async def _stage(tmp_path: Path, fname: str, payload: bytes) -> MessageAttachment:
    from flow_sdk.api.api_types.identifier import mint_uuid

    fm_id = str(uuid.uuid4())
    await unpack_bundle(_bundle_with_file(tmp_path, fm_id, fname, payload), "local-user-id")
    asset_id = mint_uuid(f"flow_message_file:{fm_id}:{fname}")
    ma = await MessageAttachment.get_one({"id": MessageAttachment.allocate_deterministic_id(fm_id, f"file-{asset_id}")})
    assert ma is not None, "unpack did not stage the zip"
    return ma


async def _project(tmp_path: Path) -> tuple[Project, Path]:
    root = tmp_path / "proj"
    root.mkdir()
    project = Project(name=unique_project_name("zip"), fs_storage_mount_path=str(root))
    await project.save(notify=False)
    return project, root


@pytest.mark.asyncio
async def test_untyped_zip_stages_extracted_and_copies_its_folder(tmp_path):
    payload = _zip_bytes({"SUMMARY.txt": "tz: IDT\n", "logs/server.log": "ERROR boom\n"})
    ma = await _stage(tmp_path, "flowpad-logs.zip", payload)
    assert ma.asset_type == "file" and ma.name == "flowpad-logs.zip"

    listing = await handle_staged_files(ma.id)
    assert isinstance(listing, ApiSuccessResponse)
    assert {f["path"] for f in listing.data["files"]} == {
        "flowpad-logs/SUMMARY.txt",
        "flowpad-logs/logs/server.log",
    }, "the staged copy must be the extracted folder, not the archive"

    project, root = await _project(tmp_path)
    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert (root / "flowpad-logs" / "logs" / "server.log").read_text() == "ERROR boom\n"
    assert not list(root.rglob("*.zip")), "the archive itself must not land in the project"


@pytest.mark.asyncio
async def test_zipped_skill_installs_as_a_skill(tmp_path):
    leaf = f"zipped-skill-{uuid.uuid4().hex[:8]}"
    payload = _zip_bytes(
        {
            f"{leaf}/SKILL.md": f"---\nname: {leaf}\ndescription: a zipped skill\n---\n\n# zipped\n",
            f"{leaf}/helper.py": "print('hi')\n",
        }
    )
    ma = await _stage(tmp_path, f"{leaf}.zip", payload)
    assert ma.asset_type == "skill", "a zip whose folder is a skill stages as a skill"

    project, root = await _project(tmp_path)
    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    skill_dir = root / ".claude" / "skills" / leaf
    assert (skill_dir / "SKILL.md").is_file() and (skill_dir / "helper.py").is_file()

    updated = await MessageAttachment.get_one({"id": ma.id})
    skill = await Skill.get_one({"id": updated.asset_id})
    assert skill is not None, "the row must point at the skill the install indexed"


def _write_zip(path: Path, members: dict[str, str]) -> Path:
    path.write_bytes(_zip_bytes(members))
    return path


def test_safe_extract_refuses_zip_slip(tmp_path):
    z = _write_zip(tmp_path / "evil.zip", {"ok.txt": "x", "../escape.txt": "pwned"})
    with pytest.raises(UnsafeArchiveError):
        safe_extract_zip(z, tmp_path / "out")
    assert not (tmp_path / "escape.txt").exists()
    assert not (tmp_path / "out").exists(), "a refused archive writes nothing"


def test_safe_extract_refuses_over_cap(tmp_path):
    z = _write_zip(tmp_path / "big.zip", {"a.txt": "x" * 1000})
    with pytest.raises(UnsafeArchiveError):
        safe_extract_zip(z, tmp_path / "out", max_bytes=100)


def test_safe_extract_skips_symlinks(tmp_path):
    z = tmp_path / "link.zip"
    with zipfile.ZipFile(z, "w") as zf:
        info = zipfile.ZipInfo("link")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "/etc/passwd")
        zf.writestr("real.txt", "ok")
    safe_extract_zip(z, tmp_path / "out")
    assert [p.name for p in (tmp_path / "out").iterdir()] == ["real.txt"]


def test_extract_preview_reuses_then_reextracts(tmp_path, monkeypatch):
    monkeypatch.setattr(archive, "preview_root", lambda: tmp_path / "preview")
    z = _write_zip(tmp_path / "logs.zip", {"a/b.txt": "hello", "c.txt": "top"})
    out = extract_preview(z)
    assert out.name == "logs" and (out / "a" / "b.txt").read_text() == "hello"
    (out / "a" / "b.txt").write_text("touched")
    assert extract_preview(z) == out and (out / "a" / "b.txt").read_text() == "touched", "a repeat preview reuses"
    shutil.rmtree(tmp_path / "preview")  # the OS wiped temp
    assert (extract_preview(z) / "a" / "b.txt").read_text() == "hello"


def test_extract_preview_unwraps_a_single_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(archive, "preview_root", lambda: tmp_path / "preview")
    z = _write_zip(tmp_path / "logs.zip", {"logs/SUMMARY.txt": "s", "__MACOSX/._x": ""})
    out = extract_preview(z)
    assert out.name == "logs" and (out / "SUMMARY.txt").is_file() and out.parent.name == "logs"
