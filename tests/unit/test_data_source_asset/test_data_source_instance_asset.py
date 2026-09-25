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
from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec
from flow_sdk.sources.families import RecordSource
from tests.fixtures.identity import index_path

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Mailbox(RecordSource):
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
    assert "allowed_senders" in RUNTIME_FIELDS, "third parties' addresses: the row's, never the file's"
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
    """A second source for an account the owner already watches is saved ONTO the first — what it
    authored is written there, the row (id, cursor, health) stays: no twin, no error."""
    first = await _saved("first")
    first.cursor = "c-42"
    await first.save_runtime()

    second = await _saved("second", folder="archive")

    assert str(second.id) == str(first.id)
    assert second.name == "second" and second.config == {"address": "me@x.test", "folder": "archive"}
    assert second.cursor == "c-42"
    assert len(await DataSource.get_all({"provider": _Mailbox.provider})) == 1


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


async def test_the_thread_timeout_is_authored_in_the_file(scope):
    source = await _saved()
    source.thread_timeout_seconds = 1800
    await source.save()
    assert _document(source)["thread_timeout_seconds"] == 1800

    main = _folder(source) / "data_source.json"
    main.write_text(main.read_text(encoding="utf-8").replace("1800", "600"), encoding="utf-8")
    await index_path("data_source", _folder(source))

    assert (await DataSource.get_by_id(source.id)).thread_timeout_seconds == 600


async def test_the_allowlist_is_the_rows_never_the_files(scope):
    """``allowed_senders`` lands on the row whichever way it is passed — a driver's form sends it in
    ``config`` — and never reaches the shareable ``data_source.json``."""
    direct = await _saved("direct", allowed_senders=["+972501234567", " "])
    assert direct.allowed_senders == ["+972501234567"] and "allowed_senders" not in direct.config
    assert "allowed_senders" not in _document(direct) and "allowed_senders" not in _document(direct)["data_driver_config"]

    legacy = DataSource.model_validate({"name": "old", "provider": _Mailbox.provider, "inbound_allowed_senders": ["U1"]})
    assert legacy.allowed_senders == ["U1"], "a row written before the rename still reads"


async def test_the_owner_is_the_entity_itself(scope):
    from flow_sdk.builtin.agent import Agent

    agent = Agent(name=f"owner {uuid.uuid4().hex[:6]}", system_prompt="x")
    source = DataSource(name="owned", provider=_Mailbox.provider, config={"address": "own@x.test"}, owner=agent)
    assert source.owner == agent.typeid


async def test_a_reread_file_keeps_the_allowlist(scope):
    """The file does not hold the allowlist, so re-indexing the folder must not reset the row's."""
    source = await _saved("kept", allowed_senders=["+972501234567"])
    await index_path("data_source", _folder(source))

    row = await DataSource.get_by_id(str(source.id))
    assert row.allowed_senders == ["+972501234567"]
