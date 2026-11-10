"""An asset keeps ONE identity when its path changes or it crosses to another machine.

Each test pins one way a path or a name leaks into an id, or a path into a shared file:
a copy install, a moved project, a family-folder index, a LIKE over paths, a published manifest row, and two spellings of one folder.
"""

from __future__ import annotations

import json
import shutil
import unicodedata
import zipfile
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — full registry
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.message_attachment_action import (
    handle_attachment_install,
    handle_attachment_uninstall,
    handle_staged_files,
)
from flow_sdk.assets.project_manifest import make_entry, manifest_path, publish
from flow_sdk.assets.scanning import scan_repo_tree
from flow_sdk.builtin.bookmark import Bookmark
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.project_manifest import origin_for_asset
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.fs_store.reindex import sources_gone_under
from flow_sdk.fs_store.resolve import index_one, resolve_asset
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.responses.response import ApiSuccessResponse
from tests.unit._project_names import unique_project_name

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


async def _indexed(path: Path, type_name: str = "micro_app", project_id: str | None = None) -> Entity:
    """Index one asset the way `flow record index <path>` does."""
    await index_one(await resolve_asset(str(path), write=True, type_name=type_name), notify=False, project_id=project_id)
    entity = await Entity.get_by_asset_ref(path)
    assert entity is not None
    return entity


async def _staged_shared_webapp(tmp_path: Path, sender_id: str) -> MessageAttachment:
    """A received message whose attachment is a webapp the sender knew as ``sender_id``."""
    fm, key = mint_uuid(), f"micro_app-{sender_id}"
    bundle = tmp_path / "bundle.flowmsg"
    with zipfile.ZipFile(bundle, "w") as zf:
        header = {"id": fm, "type": "flow_message", "text": "x", "attachment": [{"attachment_type": "type_id", "data": key}]}
        zf.writestr("header.json", json.dumps(header))
        zf.writestr(f"attachment/{key}/agentic-assets/webapp/shop/webapp.json", json.dumps({"name": "shop", "build": "."}))
        zf.writestr(f"attachment/{key}/agentic-assets/webapp/shop/index.html", "<h1>shop</h1>")
    await unpack_bundle(bundle, "local-user-id")
    return await MessageAttachment.get_one({"id": MessageAttachment.allocate_deterministic_id(fm, key)})


@pytest.mark.asyncio
async def test_a_copy_installed_webapp_opens_by_the_id_it_has_here(tmp_path):
    sender_id = mint_uuid()
    ma = await _staged_shared_webapp(tmp_path, sender_id)
    app = tmp_path / "proj" / "agentic-assets" / "webapp" / "shop"
    project = Project(name=unique_project_name("dst"), fs_storage_mount_path=str(tmp_path / "proj"))
    (tmp_path / "proj").mkdir()
    await project.save(notify=False)

    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)

    installed = await Entity.get_by_asset_ref(app)
    ma = await MessageAttachment.get_one({"id": ma.id})
    assert ma.asset_id == sender_id, "the message's chip finds its attachment by this"
    assert installed is not None and ma.local_asset_id == str(installed.id), "Open / bookmark / setup open it by this"

    # Uninstall finds the app by its id here and takes the whole of it.
    assert isinstance(await handle_attachment_uninstall(ma.id), ApiSuccessResponse)
    assert not app.exists()
    assert await Entity.get_by_asset_ref(app, resolve_containing=False) is None


@pytest.mark.asyncio
async def test_a_share_installed_before_the_local_id_was_recorded_heals_and_uninstalls(tmp_path):
    ma = await _staged_shared_webapp(tmp_path, mint_uuid())
    app = tmp_path / "proj" / "agentic-assets" / "webapp" / "shop"
    (tmp_path / "proj").mkdir()
    project = Project(name=unique_project_name("old"), fs_storage_mount_path=str(tmp_path / "proj"))
    await project.save(notify=False)
    assert isinstance(await handle_attachment_install(ma.id, "project", project.id), ApiSuccessResponse)
    ma = await MessageAttachment.get_one({"id": ma.id})
    ma.installed_asset_id = ""  # the row as an install before the fix left it: only the sender's id
    await ma.save(notify=False)

    assert isinstance(await handle_staged_files(ma.id), ApiSuccessResponse)  # the review dialog opens
    installed = await Entity.get_by_asset_ref(app)
    assert (await MessageAttachment.get_one({"id": ma.id})).local_asset_id == str(installed.id)

    assert isinstance(await handle_attachment_uninstall(ma.id), ApiSuccessResponse)
    assert not app.exists()
    assert await Entity.get_by_asset_ref(app, resolve_containing=False) is None


@pytest.mark.asyncio
async def test_a_favorite_follows_a_document_a_project_move_re_keyed(tmp_path):
    old, new = tmp_path / "a" / "proj", tmp_path / "b" / "proj"
    (old / "docs").mkdir(parents=True)
    (old / "docs" / "report.txt").write_text("report")  # a file that cannot hold an id: keyed on its path
    project = Project(name=unique_project_name("moved"), fs_storage_mount_path=str(old))
    await project.save(notify=False)
    before = await _indexed(old / "docs" / "report.txt", "document_file", str(project.id))
    favorite = Bookmark(bookmark_type="favorite", data={"entity_type": "document_file", "entity_id": str(before.id)})
    await favorite.save()

    moved: dict = {}  # the move's own steps, in its order
    await project.unindex_folder(str(old), path_keyed=moved)
    new.parent.mkdir()
    shutil.move(old, new)
    after = await _indexed(new / "docs" / "report.txt", "document_file", str(project.id))
    await project._repoint_path_keyed(moved, canonical_posix_path(new))

    assert str(after.id) != str(before.id)
    assert (await Bookmark.get_one({"id": favorite.id})).data["entity_id"] == str(after.id)


def test_indexing_a_family_folder_finds_the_assets_in_it(tmp_path):
    family = tmp_path / "agentic-assets" / "dataset"
    for name in ("mocks", "feedback"):
        (family / name).mkdir(parents=True)
        spec = {"metadata": {"title": name, "data_layout": "io_folder", "spec": {"rows": [{"input": "string"}]}}, "data": {}}
        (family / name / "dataset.json").write_text(json.dumps(spec))
    families = SchemaRegistry.repo_family_to_info()
    assert len(scan_repo_tree(tmp_path, families).candidates) == 2  # from the project root: found

    found = scan_repo_tree(family, families).candidates
    assert len(found) == 2, "`flow record index <family folder>` indexes 0"
    assert {c.traversal_parent for c in found} == {family}, "the indexer hangs each asset under the root it named"


@pytest.mark.asyncio
async def test_cleaning_one_project_does_not_reach_a_sibling_whose_name_matches_as_a_pattern(tmp_path):
    mine, sibling = tmp_path / "my_proj", tmp_path / "myXproj"
    mine.mkdir()
    app = sibling / "agentic-assets" / "webapp" / "shop"
    app.mkdir(parents=True)
    (app / "webapp.json").write_text(json.dumps({"name": "shop", "build": "."}))
    await _indexed(app)
    shutil.rmtree(app)  # the sibling's source is gone; it is the sibling's to reconcile

    assert await sources_gone_under(mine) == []


@pytest.mark.asyncio
async def test_a_published_row_holds_no_path_of_this_machine(tmp_path):
    skill = tmp_path / "proj" / ".claude" / "skills" / "deploy"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(f"---\nid: {mint_uuid()}\nname: deploy\n---\n")

    rel = ".claude/skills/deploy"
    origin = await origin_for_asset(str(skill), rel)  # no git remote here
    publish(tmp_path / "proj", make_entry(typeid=f"skill-{mint_uuid()}", rel_path=rel, origin=origin))

    assert str(tmp_path.resolve()) not in manifest_path(tmp_path / "proj").read_text()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "respell",
    [lambda s: unicodedata.normalize("NFD", s), str.upper],
    ids=["unicode form", "letter case"],
)
async def test_one_file_is_one_asset_however_its_path_is_spelled(tmp_path, respell):
    doc = tmp_path / "café" / "docs" / "report.txt"  # a document's id is keyed on its path
    doc.parent.mkdir(parents=True)
    doc.write_text("report")
    other = tmp_path / respell("café") / "docs" / "report.txt"
    if not other.exists() or not other.samefile(doc):
        pytest.skip("this filesystem treats the two spellings as two folders")

    ids = [(await resolve_asset(str(p), write=False, type_name="document_file")).id for p in (doc, other)]
    assert ids[0] == ids[1]
