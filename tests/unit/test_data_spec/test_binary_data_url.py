"""A ``binary`` field travels over JSON as a ``data:`` URL and lands on disk as the real file.

A page (the mockify feedback panel) saves a screenshot through the row-write route: the value
arrives as ``data:image/png;base64,…``. It must be decoded to the PNG bytes, written as
``<field>.png`` — a file a person or an agent can open — and handed back as the same URL on a
JSON read, so the page round-trips it unchanged.
"""

from __future__ import annotations

import base64
import copy
import pickle
from typing import ClassVar, Optional

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec, RowSpec
from flow_sdk.schema.data_spec.io import Binary
from flow_sdk.schema.data_spec.spec import DataSpec

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000000000200015e2fd4e00000000049454e44ae426082"
)
PNG_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


class Shot(DataSpec):
    spec_kind: ClassVar[str] = "unittest.binary.shot"
    text: str
    screenshot: Optional[Binary] = None


class Shots(DatasetSpec[RowSpec[Shot, DataSpec, DataSpec]]):
    spec_kind: ClassVar[str] = "unittest.binary.dataset"


def shot(screenshot=PNG_URL) -> Shot:
    return Shot.model_validate({"text": "t", "screenshot": screenshot})


def test_a_data_url_decodes_to_the_bytes_and_names_its_extension():
    s = shot()
    assert bytes(s.screenshot) == PNG
    assert s.screenshot.media_type == "image/png" and s.screenshot.ext == ".png"


def test_a_json_read_hands_back_the_same_data_url():
    s = shot()
    assert s.model_dump(mode="json")["screenshot"] == PNG_URL
    # Python mode stays bytes: only the wire form is a URL.
    assert isinstance(s.model_dump()["screenshot"], bytes)


def test_it_is_written_as_a_real_png_and_read_back_as_one(tmp_path):
    shot().save(tmp_path)
    files = {p.name for p in tmp_path.iterdir() if p.is_file()}
    assert "screenshot.png" in files and "screenshot.bin" not in files
    assert (tmp_path / "screenshot.png").read_bytes() == PNG
    back = Shot.load(tmp_path)
    assert bytes(back.screenshot) == PNG and back.screenshot.ext == ".png"
    assert back.model_dump(mode="json")["screenshot"] == PNG_URL


def test_replacing_the_image_with_another_type_leaves_one_file(tmp_path):
    shot().save(tmp_path)
    shot("data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0jpeg").decode()).save(tmp_path)
    assert sorted(p.name for p in tmp_path.glob("screenshot.*")) == ["screenshot.jpg"]


def test_clearing_it_removes_the_file_whatever_its_extension(tmp_path):
    shot().save(tmp_path)
    shot(None).save(tmp_path)
    assert not list(tmp_path.glob("screenshot.*"))


def test_plain_bytes_keep_bin():
    assert shot(b"\x00\x01").screenshot.ext == ".bin"


def test_a_copy_keeps_what_the_bytes_are():
    original = shot().screenshot
    for clone in (copy.copy(original), copy.deepcopy(original), pickle.loads(pickle.dumps(original))):
        assert bytes(clone) == PNG and clone.media_type == "image/png"


@pytest.mark.parametrize("bad", ["data:image/png,notbase64", "data:image/png;base64,***"])
def test_a_data_url_that_does_not_decode_is_refused(bad):
    with pytest.raises(ValidationError):
        shot(bad)


@pytest.mark.asyncio
async def test_a_page_saves_a_screenshot_and_reads_it_back_over_http(tmp_path):
    """What the browser's Dataset client calls: ``put-row`` with a data URL, then ``rows``."""
    from flow_sdk.builtin.dataset import Dataset
    from tests.unit._graph_client import call_local

    d = Dataset(id="7e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b", name="feedback", asset_ref=str(tmp_path),
                data_layout="io_folder", spec="unittest.binary.dataset")
    await d.save()
    base = f"dataset/{d.id}"
    resp = await call_local("POST", f"{base}/put-row",
                            {"key": "m-setup-1", "row": {"input": {"text": "too small", "screenshot": PNG_URL}}})
    assert resp.status_code == 200, resp.text
    on_disk = list(tmp_path.rglob("screenshot.*"))
    assert [p.name for p in on_disk] == ["screenshot.png"] and on_disk[0].read_bytes() == PNG
    rows = (await call_local("GET", f"{base}/rows")).json()["data"]["rows"]
    assert rows[0]["input"]["screenshot"] == PNG_URL
