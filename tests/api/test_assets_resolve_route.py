"""``GET /api/v1/assets/resolve?path=`` — THE path → asset resolver the
asset loader calls with a path and nothing else.

The client never names a type: the registry classifies the path, the id is
settled by the indexer's reconcile, and the row is indexed on a miss so a
``(type, id)`` fetch always succeeds afterwards. Real FastAPI app, real
filesystem, real DB; no mocks.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio

ENVELOPE_KEYS = {"type", "id", "root", "body", "editor", "entity"}


async def _resolve(client, path: Path):
    return await client.get("/api/v1/assets/resolve", params={"path": str(path)})


def _skill(root: Path, name: str) -> Path:
    folder = root / ".claude" / "skills" / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: a skill\n---\n# {name}\n", encoding="utf-8")
    return folder


async def test_a_source_file_is_not_an_asset(bootstrapped_client, tmp_path: Path):
    py = tmp_path / "server.py"
    py.write_text("print('hi')\n", encoding="utf-8")

    resp = await _resolve(bootstrapped_client, py)

    assert resp.status_code == 404
    assert resp.json()["status"] != "SUCCESS"
    assert py.read_text(encoding="utf-8") == "print('hi')\n", "a refusal never touches the bytes"


async def test_a_missing_path_is_not_an_asset(bootstrapped_client, tmp_path: Path):
    resp = await _resolve(bootstrapped_client, tmp_path / "docs" / "nope.md")
    assert resp.status_code == 404


async def test_skill_folder_and_main_file_resolve_to_one_id(bootstrapped_client, tmp_path: Path):
    """A folder asset is one asset whichever spelling arrives; the first
    resolve indexes the row so the second answers the same entity."""
    folder = _skill(tmp_path, "api_skill")

    by_folder = (await _resolve(bootstrapped_client, folder)).json()["data"]
    by_main = (await _resolve(bootstrapped_client, folder / "SKILL.md")).json()["data"]

    assert set(by_folder) == ENVELOPE_KEYS
    assert by_folder["type"] == "skill"
    assert by_folder["editor"] == "skill"
    assert Path(by_folder["root"]) == folder.resolve()
    assert Path(by_folder["body"]) == (folder / "SKILL.md").resolve()
    assert by_main["id"] == by_folder["id"]
    assert by_main["type"] == "skill"
    assert by_folder["entity"] is not None and by_folder["entity"]["id"] == by_folder["id"]
    assert by_main["entity"]["id"] == by_folder["id"]


async def test_one_typeid_per_path_across_calls(bootstrapped_client, tmp_path: Path):
    doc = tmp_path / "notes.md"
    doc.write_text("# notes\n", encoding="utf-8")

    first = (await _resolve(bootstrapped_client, doc)).json()["data"]
    second = (await _resolve(bootstrapped_client, doc)).json()["data"]

    assert first["type"] == "markdown"
    assert first["id"] == second["id"]
    assert first["entity"]["id"] == first["id"]


async def test_spec_is_named_by_its_placement(bootstrapped_client, tmp_path: Path):
    folder = tmp_path / "agentic-assets" / "spec" / "x"
    folder.mkdir(parents=True)
    spec = folder / "spec.md"
    spec.write_text("---\nname: x\n---\n# x\n", encoding="utf-8")

    data = (await _resolve(bootstrapped_client, spec)).json()["data"]

    assert data["type"] == "spec"
    assert Path(data["root"]) == folder.resolve()
    assert data["entity"] is not None


async def test_the_row_exists_by_typeid_after_resolve(bootstrapped_client, tmp_path: Path):
    """The client's fallback: with ``entity`` in hand or not, a GET by
    ``(type, id)`` must find the row the resolver named."""
    from flow_sdk.db import get_db_driver  # noqa: PLC0415

    doc = tmp_path / "by-id.md"
    doc.write_text("# by id\n", encoding="utf-8")

    data = (await _resolve(bootstrapped_client, doc)).json()["data"]

    assert await get_db_driver().get_by_id(data["id"], data["type"]) is not None
