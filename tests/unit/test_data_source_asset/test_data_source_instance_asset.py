"""A configured ``DataSource`` is an asset: ``agentic-assets/data_source/<name>/data_source.json``.

The file holds what a person authors; the row adds what the engine learns while it runs. These pin
the seams between the two — the file shape, a poll that never touches the file, a copied folder that
arrives parked, one account watched once per owner, and rows with no file going with their children.
"""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.api.api_types.api_field import Persist
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import (
    RECEIVED_SETUP_DETAIL,
    RUNTIME_FIELDS,
    DataSource,
    SourceStatus,
    prune_fileless_data_sources,
)
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.fs_store.orphan_removal import remove_orphan_row
from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec
from flow_sdk.sources.base import Source
from tests.fixtures.identity import index_path

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Mailbox(Source):
    provider = "asset-mailbox-test"
    identity_config_key = "address"


@pytest.fixture
def scope(folder_db, fresh_user_scope):
    DataDriver.register(DataDriver.for_class(_Mailbox, kind="datasource.test.asset"))
    return fresh_user_scope


def _folder(source: DataSource):
    from pathlib import Path

    return Path(source.asset_ref)


def _document(source: DataSource) -> dict:
    return json.loads((_folder(source) / "data_source.json").read_text(encoding="utf-8"))


async def _saved(name: str = "work mail", **config) -> DataSource:
    source = DataSource(name=name, provider=_Mailbox.provider, config={"address": "me@x.test", **config})
    await source.save()
    return source


async def test_the_file_holds_the_authored_fields_and_nothing_the_engine_writes(scope):
    source = await _saved()

    assert _folder(source) == (scope / "agentic-assets" / "data_source" / "work_mail").resolve()
    document = _document(source)
    assert (document["type"], document["id"]) == ("data_source", str(source.id))
    assert (document["name"], document["data_driver_name"]) == ("work mail", _Mailbox.provider)
    assert document["data_driver_config"] == {"address": "me@x.test"}
    assert not set(document) & set(RUNTIME_FIELDS)


async def test_runtime_fields_are_row_only_and_never_authored():
    spec_fields = set(DataSourceSpec.model_fields)
    assert RUNTIME_FIELDS and not spec_fields & set(RUNTIME_FIELDS)
    for name in RUNTIME_FIELDS:
        assert DataSource.model_fields[name].json_schema_extra["persist"] == Persist.FALSE.value, name


async def test_a_poll_writes_the_row_and_leaves_the_file_alone(scope):
    source = await _saved()
    main = _folder(source) / "data_source.json"
    before = (main.read_bytes(), main.stat().st_mtime_ns)

    source.health = "ok"
    source.cursor = "c3"
    await source.save_runtime()

    assert (main.read_bytes(), main.stat().st_mtime_ns) == before
    stored = await DataSource.get_by_id(source.id)
    assert (stored.health, stored.cursor) == ("ok", "c3")


async def test_a_copied_folder_arrives_parked_until_its_owner_verifies(scope):
    folder = scope / "agentic-assets" / "data_source" / "received"
    folder.mkdir(parents=True)
    document = {"type": "data_source", "id": str(uuid.uuid4()), "name": "received",
                "data_driver_name": _Mailbox.provider, "data_driver_config": {"address": "them@x.test"}}
    (folder / "data_source.json").write_text(json.dumps(document), encoding="utf-8")

    await index_path("data_source", folder)

    row = await DataSource.get_by_id(document["id"])
    assert row.status == SourceStatus.SETUP.value
    assert row.setup_detail == RECEIVED_SETUP_DETAIL


async def test_one_owner_watches_an_account_once(scope):
    await _saved("first")

    with pytest.raises(ValueError, match="already watched"):
        await _saved("second")


async def test_a_file_that_is_a_driver_definition_is_refused_with_where_it_belongs():
    with pytest.raises(ValueError, match="data_driver.json"):
        DataSourceSpec.model_validate({"schema": 1, "name": "rss", "title": "RSS / Atom"})


async def test_a_secret_in_the_config_is_refused():
    with pytest.raises(ValueError, match="value-free"):
        DataSourceSpec.model_validate({"data_driver_name": "telegram", "data_driver_config": {"bot": {"value": "123:abc"}}})


async def test_boot_prunes_rows_with_no_file_and_keeps_the_rest(scope):
    kept = await _saved("kept")
    # A row from before sources were files: written straight to the table, with no folder.
    fileless = DataSource(name="legacy", provider=_Mailbox.provider, config={"address": "old@x.test"})
    await DBEntity.save(fileless)

    assert await prune_fileless_data_sources() >= 1

    assert await DataSource.get_by_id(kept.id) is not None
    assert await DataSource.get_by_id(fileless.id) is None


async def test_deleting_a_source_removes_its_folder_so_no_index_brings_it_back(scope):
    source = await _saved()
    folder = _folder(source)

    await source.delete()

    assert not folder.exists()
    again = await _saved()  # the name is free again
    await DataSource.delete_by_id(str(again.id))
    assert not _folder(again).exists()


async def test_a_hand_edit_is_indexed_and_the_rows_runtime_survives_it(scope):
    source = await _saved()
    source.status, source.health = SourceStatus.DISABLED.value, "ok"
    await source.save_runtime()
    main = _folder(source) / "data_source.json"
    main.write_text(main.read_text(encoding="utf-8").replace('"work mail"', '"renamed"'), encoding="utf-8")

    await index_path("data_source", _folder(source))

    row = await DataSource.get_by_id(source.id)
    assert row.name == "renamed"
    assert (row.status, row.health) == (SourceStatus.DISABLED.value, "ok")
