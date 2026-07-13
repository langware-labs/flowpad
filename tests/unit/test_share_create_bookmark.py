"""The "create bookmark" share opt-in: when the sender checks it, install mints
a FAVORITE Bookmark on the receiver pointing at the just-installed entity.

Real DB + real ``unpack_bundle`` staging + real ``handle_attachment_install`` —
the flag rides ``share_options.json`` in the bundle, is stamped onto the staged
MessageAttachment at unpack, and consumed at install. Default OFF: no
share_options.json ⇒ no favorite.
"""
from __future__ import annotations

import json
import uuid
import zipfile
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — full registry

from flow_sdk.app.actions import message_attachment_action as ma_action
from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.bookmark import Bookmark, BookmarkType
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.skill import Skill
from flow_sdk.responses.response import ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class Ids:
    def __init__(self):
        self.fm = str(uuid.uuid4())
        self.skill = str(uuid.uuid4())
        self.skill_key = f"skill-@{self.skill}"
        self.leaf = f"bm-skill-{self.skill[:8]}"


@pytest.fixture
def ids() -> Ids:
    return Ids()


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


def _write_bundle(tmp_path: Path, ids: Ids, *, create_bookmark: bool) -> Path:
    fm_data = {
        "id": ids.fm,
        "type": "flow_message",
        "text": "carrier",
        "attachment": [{"attachment_type": "type_id", "data": f"skill-{ids.skill}"}],
    }
    zip_path = tmp_path / "bundle.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("header.json", json.dumps(fm_data))
        zf.writestr(
            f"attachment/{ids.skill_key}/.claude/skills/{ids.leaf}/SKILL.md",
            f"---\nid: {ids.skill}\nname: {ids.leaf}\ndescription: bm skill\n---\n\n# bm\n",
        )
        if create_bookmark:
            zf.writestr("share_options.json", json.dumps({"create_bookmark": True}))
    return zip_path


async def _favorite_for(entity_type: str, entity_id: str) -> Bookmark | None:
    favs = await Bookmark.get_all({"bookmark_type": BookmarkType.FAVORITE.value})
    for b in favs:
        data = b.data or {}
        if data.get("entity_type") == entity_type and data.get("entity_id") == entity_id:
            return b
    return None


async def _stage(tmp_path: Path, ids: Ids, *, create_bookmark: bool) -> MessageAttachment:
    await unpack_bundle(_write_bundle(tmp_path, ids, create_bookmark=create_bookmark), "local-user")
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(ids.fm, ids.skill_key)}
    )
    assert ma is not None
    return ma


async def test_flag_on_mints_favorite_at_install(tmp_path, ids, monkeypatch):
    ma = await _stage(tmp_path, ids, create_bookmark=True)
    assert ma.create_bookmark is True, "flag must be stamped on the staged MA at unpack"
    # No favorite before install — mint is gated on the explicit install.
    assert await _favorite_for("skill", ids.skill) is None

    user_root = tmp_path / "home"
    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: user_root)
    res = await handle_attachment_install(ma.id, "user", None)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert await Skill.get_one({"id": ids.skill}) is not None

    fav = await _favorite_for("skill", ids.skill)
    assert fav is not None, "install did not mint the favorite"
    assert fav.bookmark_type == BookmarkType.FAVORITE.value
    assert (fav.data or {}).get("entity_type") == "skill"
    assert (fav.data or {}).get("entity_id") == ids.skill
    # asset_ref resolved from the installed entity so the favorite navigates.
    assert (fav.data or {}).get("nav", {}).get("asset_ref")

    # Idempotent: re-install does not create a second favorite.
    await handle_attachment_install(ma.id, "user", None)
    favs = await Bookmark.get_all({"bookmark_type": BookmarkType.FAVORITE.value})
    matching = [b for b in favs if (b.data or {}).get("entity_id") == ids.skill]
    assert len(matching) == 1, "mint must be idempotent"


async def test_flag_off_mints_no_favorite(tmp_path, ids, monkeypatch):
    ma = await _stage(tmp_path, ids, create_bookmark=False)
    assert ma.create_bookmark is False
    user_root = tmp_path / "home"
    monkeypatch.setattr(ma_action, "_user_scope_root", lambda: user_root)
    res = await handle_attachment_install(ma.id, "user", None)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert await Skill.get_one({"id": ids.skill}) is not None
    assert await _favorite_for("skill", ids.skill) is None, "no flag ⇒ no favorite"
