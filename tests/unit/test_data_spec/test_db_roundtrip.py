"""``DbSerializer`` — every non-file field survives the entity table; a field
declared as bytes-on-disk RAISES rather than vanishing from the row."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.dataset import ARTIFACT_ROW, Dataset
from flow_sdk.builtin.db_origin import DbOrigin
from flow_sdk.builtin.subagent import SubAgent
from flow_sdk.fs_store.serializer import UnsupportedFieldError
from flow_sdk.fs_store.serializer.db import DbSerializer, db_persisted_fields
from flow_sdk.schema.data_spec.dataset_spec import FileRef
from tests.unit.test_data_spec._roundtrip import populate
from tests.unit.test_fs_store.conftest import sync_db  # noqa: F401 — fixture

pytestmark = pytest.mark.timeout(10)  # do not increase without approval


@pytest.mark.parametrize("cls", [SubAgent, Agent])
@pytest.mark.asyncio
async def test_every_db_persisted_field_survives_the_row(cls: type, sync_db, tmp_records_root) -> None:  # noqa: F811
    original = populate(cls)
    await original.save(notify=False)
    rows = await cls.get_all({"id": original.id})
    assert len(rows) == 1
    back = rows[0]
    for name in db_persisted_fields(cls):
        want, got = getattr(original, name), getattr(back, name)
        assert got == want, f"{cls.__name__}.{name}: wrote {want!r}, read {got!r}"


def test_the_data_column_is_a_pydantic_dump_not_a_lossy_walk() -> None:
    a = Agent(name="q", input={"text": "string"}, cli_options={"chrome": True, "nested": {"a": 1}})
    data = DbSerializer().data(a)
    assert data["input"] == {"text": "string"}            # a shape class → its authoring form
    assert data["cli_options"] == {"chrome": True, "nested": {"a": 1}}
    assert "examples" not in DbSerializer().data(Dataset(name="d"))   # NoDBAPIField ⇒ excluded


def test_a_dataset_with_rows_never_reaches_the_row_check() -> None:
    """``examples`` is DB-excluded, so a dataset with FileRef rows stores fine —
    the rows live on disk only. The refusal is for a field that DECLARES bytes
    and is NOT excluded."""
    ds = Dataset(name="d", examples=[ARTIFACT_ROW(input=FileRef(path="in.txt"))])
    assert "examples" not in DbSerializer().data(ds)


def test_a_disk_only_field_that_is_not_excluded_raises() -> None:
    from typing import Optional

    from flow_sdk.api.api_types.api_field import APIField
    from flow_sdk.core.entity.entity_model import Entity

    class _WithFile(Entity):
        type: str = APIField(default="probe_with_file")
        scan: Optional[FileRef] = APIField(default=None)

    with pytest.raises(UnsupportedFieldError, match="file_ref"):
        DbSerializer().data(_WithFile(scan=FileRef(path="a.pdf")))


def test_store_returns_the_origin_with_the_row_key() -> None:
    a = Agent(name="q")
    assert DbSerializer().store(a, DbOrigin()).id == a.id
