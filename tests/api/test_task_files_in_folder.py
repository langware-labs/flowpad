"""A task's files live in its own folder (``TypeInfo.files_in_asset_folder``).

Through the real graph/FS dispatcher: an upload lands under the task's
``agentic-assets/task/<name>/`` folder (so a shared task's .flowmsg carries it),
and files attached before that — still in ``records_data/.../embedded`` — keep
listing and downloading from there (read fallback, no migration).
"""
from pathlib import Path

import pytest

from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.storage import get_entity_embedded_storage
from tests.unit._project_names import unique_project_name

pytestmark = pytest.mark.asyncio

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


async def _task_in_project(client, tmp_path) -> dict:
    project = await client.post(
        "/api/v1/graph/project",
        json={"name": unique_project_name("task-files"), "fs_storage_mount_path": str(tmp_path)},
    )
    assert project.status_code == 200, project.text
    pid = project.json()["data"]["id"]
    task = await client.post(f"/api/v1/graph/project/{pid}/task", json={"title": "Needs a screenshot"})
    assert task.status_code == 200, task.text
    row = task.json()["data"]
    assert row["asset_ref"] and (Path(row["asset_ref"]) / "task.md").is_file()
    return row


async def test_upload_lands_in_the_task_folder(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    row = await _task_in_project(client, tmp_path)
    base = f"/api/v1/graph/task/{row['id']}/fs"

    up = await client.post(f"{base}/upload/attachments", files={"file_0": ("shot.png", PNG, "image/png")})
    assert up.status_code == 200, up.text

    on_disk = Path(row["asset_ref"]) / "attachments" / "shot.png"
    assert on_disk.read_bytes() == PNG
    embedded = Path(get_entity_embedded_storage(TypeId(type="task", id=row["id"])).mount_path)
    assert not any(embedded.rglob("shot.png")), "upload still went to embedded storage"

    listed = await client.get(f"{base}/browse/attachments")
    assert listed.status_code == 200, listed.text
    item = next(i for i in listed.json()["data"] if i["display_name"] == "shot.png")
    assert Path(item["local_path"]).resolve() == on_disk.resolve()

    got = await client.get(f"{base}/download/attachments/shot.png")
    assert got.status_code == 200 and got.content == PNG


async def test_files_attached_before_the_move_still_resolve(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    row = await _task_in_project(client, tmp_path)
    base = f"/api/v1/graph/task/{row['id']}/fs"

    # A file attached under the old layout: bare name in embedded storage.
    legacy_root = Path(get_entity_embedded_storage(TypeId(type="task", id=row["id"])).mount_path)
    legacy_root.mkdir(parents=True, exist_ok=True)
    (legacy_root / "old.png").write_bytes(PNG)

    listed = await client.get(f"{base}/browse/")
    assert listed.status_code == 200, listed.text
    names = {i["display_name"]: i for i in listed.json()["data"]}
    assert "task.md" in names, "the folder itself is listed"
    assert Path(names["old.png"]["local_path"]).resolve() == (legacy_root / "old.png").resolve()

    got = await client.get(f"{base}/download/old.png")
    assert got.status_code == 200 and got.content == PNG
    # Read-only fallback: nothing was copied into the folder.
    assert not (Path(row["asset_ref"]) / "old.png").exists()
