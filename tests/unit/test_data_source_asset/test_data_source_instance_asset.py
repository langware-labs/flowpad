"""A configured ``DataSource`` is an asset: ``agentic-assets/data_source/<name>/data_source.json``.

The file holds what a person authors; the row adds what the engine learns while it runs. These pin
the seams between the two — the file shape, a poll that never touches the file, a copied folder that
arrives parked, one account watched once per owner, and rows with no file going with their children.
"""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.api.api_types.api_field import Persist, Sharing
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
from flow_sdk.sources.config import SourceConfig, config_field
from flow_sdk.sources.families import RecordSource
from tests.fixtures.identity import index_path

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Mailbox(RecordSource):
    provider = "asset-mailbox-test"
    identity_config_key = "address"


class _OwnAccountConfig(SourceConfig):
    address: str = config_field("", sharing=Sharing.PRIVATE)
    label: str = ""


class _OwnAccountMailbox(_Mailbox):
    """A mailbox whose address is whose it is — private to the machine — while its label is shared."""

    provider = "asset-mailbox-private-test"
    Config = _OwnAccountConfig


@pytest.fixture
def scope(folder_db, fresh_user_scope):
    DataDriver.register(DataDriver.for_class(_Mailbox, kind="datasource.test.asset"))
    DataDriver.register(DataDriver.for_class(_OwnAccountMailbox, kind="datasource.test.asset"))
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


async def test_private_fields_stay_on_the_row_and_never_reach_the_file(scope):
    """The file travels with the project, so it holds what is shared: not the config fields a driver
    declares private, not a user owner. A re-read of the file — a teammate's edit pulled in — changes
    the shared part and leaves this machine's own values alone."""
    owner = await _local_owner()
    source = DataSource(name="own", provider=_OwnAccountMailbox.provider, config={"address": "me@x.test", "label": "INBOX"})
    await source.save()

    document = _document(source)
    assert document["data_driver_config"] == {"label": "INBOX"} and "owner" not in document

    main = _folder(source) / "data_source.json"
    main.write_text(main.read_text(encoding="utf-8").replace("INBOX", "Archive"), encoding="utf-8")
    await index_path("data_source", _folder(source))

    row = await DataSource.get_by_id(source.id)
    assert row.config == {"address": "me@x.test", "label": "Archive"} and str(row.owner) == owner


async def test_a_file_from_before_the_split_never_gives_its_authors_account_away(scope):
    """An old file still names its author's address and user. Received, it parks without the address —
    this machine signs in as its own account; saved by its author, the file loses both."""
    received = await _indexed(scope, "theirs", provider=_OwnAccountMailbox.provider, owner=f"user-{uuid.uuid4()}")
    assert (received.status, received.config) == (SourceStatus.SETUP.value, {})

    mine = await _indexed(scope, "mine", provider=_OwnAccountMailbox.provider, owner=await _local_owner())
    assert mine.config == {"address": "mine@x.test"}
    mine.poll_interval_seconds = 60
    await mine.save()
    document = _document(mine)
    assert "data_driver_config" not in document and "owner" not in document
    assert (await DataSource.get_by_id(mine.id)).config == {"address": "mine@x.test"}


async def test_the_upgrade_clears_the_private_config_a_received_source_adopted(scope, tmp_path):
    """Before the split a received row took its author's address from the file. The one-time pass empties
    it on a row another user owns, and leaves this machine's own source alone — on a real sqlite file."""
    import sqlite3

    from flow_sdk.migrations.migration_2026_11_received_source_private_config import migrate

    def _source(owner: str) -> str:
        return json.dumps({"provider": _OwnAccountMailbox.provider, "owner": owner, "config": {"address": "a@x.test", "label": "INBOX"}})

    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, uname TEXT, data TEXT)")
    conn.executemany("INSERT INTO entities VALUES (?, ?, ?, ?)", [
        ("me", "user", "local", "{}"),
        ("mine", "data_source", None, _source("user-me")),
        ("theirs", "data_source", None, _source("user-author")),
    ])
    conn.commit()

    assert migrate(dry_run=False, db=db).fields == [f"theirs: {_OwnAccountMailbox.provider}.address"]

    held = {row_id: json.loads(data)["config"] for row_id, data in conn.execute("SELECT id, data FROM entities WHERE type = 'data_source'")}
    assert held == {"mine": {"address": "a@x.test", "label": "INBOX"}, "theirs": {"label": "INBOX"}}
    assert migrate(dry_run=False, db=db).fields == [], "a second run finds nothing"


async def test_an_agent_owner_is_shared_and_written_to_the_file(scope):
    """An agent is a project asset, so the source it owns says so in the file — a deploy box starts it from there."""
    from flow_sdk.builtin.agent import Agent

    agent = Agent(name=f"owner {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.")
    await agent.save()
    source = DataSource(name="agents", provider=_Mailbox.provider, config={"address": "a@x.test"}, owner=agent)
    await source.save()

    assert _document(source)["owner"] == f"agent-{agent.id}"


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


async def _indexed(scope, name: str, provider: str = _Mailbox.provider, **fields) -> DataSource:
    """A ``data_source.json`` that exists BEFORE its row — what the indexer meets after a folder was
    copied in, an agent or the CLI wrote the file, or the DB was rebuilt."""
    folder = scope / "agentic-assets" / "data_source" / name
    folder.mkdir(parents=True)
    document = {"type": "data_source", "id": str(uuid.uuid4()), "name": name, "data_driver_name": provider,
                "data_driver_config": {"address": f"{name}@x.test"}, **fields}
    (folder / "data_source.json").write_text(json.dumps(document), encoding="utf-8")
    await index_path("data_source", folder)
    return await DataSource.get_by_id(document["id"])


async def test_a_copied_folder_arrives_parked_until_its_owner_verifies(scope):
    row = await _indexed(scope, "received")

    assert (row.status, row.setup_detail) == (SourceStatus.SETUP.value, RECEIVED_SETUP_DETAIL)


async def _local_owner() -> str:
    """This machine's user as an owner typeid — bootstrapped when the test DB has none yet."""
    from flow_sdk.builtin.user import User
    from flow_sdk.stream_inbox.projection import default_owner

    if await User.get_local() is None:
        await User(uname="local", name="local").save(notify=False)
    return str(await default_owner())


async def test_a_file_the_local_user_authored_is_not_parked_on_index(scope):
    """Only a file that names nobody, or someone this machine does not know, is a received share. One
    naming this machine's own user runs by the create rules — a driver with no setup step is ACTIVE."""
    row = await _indexed(scope, "mine", owner=await _local_owner())

    assert (row.status, row.setup_detail) == (SourceStatus.ACTIVE.value, "")


async def test_a_file_a_local_agent_authored_is_not_parked_on_index(scope):
    from flow_sdk.builtin.agent import Agent

    agent = Agent(name=f"author {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.")
    await agent.save()

    row = await _indexed(scope, "agents", owner=f"agent-{agent.id}")

    assert (row.status, row.setup_detail) == (SourceStatus.ACTIVE.value, "")


async def test_a_file_naming_an_owner_this_machine_does_not_know_arrives_parked(scope):
    row = await _indexed(scope, "theirs", owner=f"user-{uuid.uuid4()}")

    assert (row.status, row.setup_detail) == (SourceStatus.SETUP.value, RECEIVED_SETUP_DETAIL)


async def test_a_file_authored_here_for_a_driver_with_a_setup_step_starts_in_setup(scope):
    from flow_sdk.sources.protocols import Verdict

    class _Invited(_Mailbox):
        provider = "asset-mailbox-invited-test"

        async def verify(self) -> Verdict:
            return Verdict(ready=False, detail="Invite the bot.")

    DataDriver.register(DataDriver.for_class(_Invited, kind="datasource.test.invited"))

    row = await _indexed(scope, "invited", _Invited.provider, owner=await _local_owner())

    assert (row.status, row.setup_detail) == (SourceStatus.SETUP.value, "Finish setup, then press Verify.")


async def test_a_file_whose_driver_is_not_loaded_waits_new_and_the_poller_tick_settles_it(scope):
    """The indexer may not import a driver, so a file whose driver is not loaded yet cannot be decided
    there — deciding without the class would skip the setup step of a driver that owes one. It stays
    NEW (reported as "not evaluated yet"), and the poller's next tick loads the driver and decides."""
    from flow_sdk.ingest import poller
    from flow_sdk.sources.protocols import Verdict

    class _Late(_Mailbox):
        provider = "asset-mailbox-late-test"

        async def verify(self) -> Verdict:
            return Verdict(ready=False, detail="Invite the bot.")

    row = await _indexed(scope, "late", _Late.provider, owner=await _local_owner())
    assert row.status == SourceStatus.NEW.value

    DataDriver.register(DataDriver.for_class(_Late, kind="datasource.test.late"))  # the driver loads
    await poller.dispatch_due_sources(spawn=lambda coro: coro.close())

    row = await DataSource.get_by_id(row.id)
    assert (row.status, row.setup_detail) == (SourceStatus.SETUP.value, "Finish setup, then press Verify.")


async def test_a_file_for_a_provider_nothing_answers_is_settled_active_so_the_poll_can_say_why(scope):
    from flow_sdk.ingest import poller

    row = await _indexed(scope, "nobody", "asset-no-such-driver-test", owner=await _local_owner())
    assert row.status == SourceStatus.NEW.value

    await poller.dispatch_due_sources(spawn=lambda coro: coro.close())

    assert (await DataSource.get_by_id(row.id)).status == SourceStatus.ACTIVE.value


async def test_a_source_holds_its_project_up_only_while_it_owes_a_setup(scope):
    """The setup tree's Verify check and the footer ask the source: what it owes, in its own words. A
    source just indexed (``new``) or paused by a person owes nothing; the poller makes the first active."""
    from flow_sdk.sources.protocols import Verdict

    class _Checked(_Mailbox):
        provider = "asset-mailbox-checked-test"

        async def verify(self) -> Verdict:
            return Verdict(ready=False, detail="Invite the bot.")

    DataDriver.register(DataDriver.for_class(_Checked, kind="datasource.test.checked"))
    plain = DataSource(name="plain", provider=_Mailbox.provider)
    checked = DataSource(name="checked", provider=_Checked.provider)
    unloaded = DataSource(name="unloaded", provider="asset-no-such-driver-test")

    owed = {}
    for status in SourceStatus:
        plain.status = checked.status = unloaded.status = status.value
        plain.setup_detail = "Received — connect your own account." if status is SourceStatus.SETUP else ""
        owed[status.value] = (plain.setup_owed(), checked.setup_owed(), unloaded.setup_owed())

    assert owed == {
        "new": ("", "not verified", ""),
        "setup": ("Received — connect your own account.", "not verified", "not verified"),
        "active": ("", "", ""),
        "disabled": ("", "", ""),
    }
    plain.status = SourceStatus.NEW.value
    assert (await plain._verify_step(check=True)).ok, "the tree's check passes: nothing is owed"
    plain.status, plain.setup_detail = SourceStatus.SETUP.value, "Invite the bot."
    held = await plain._verify_step(check=True)
    assert not held.ok and held.detail == "Invite the bot."


async def test_a_source_changing_status_drops_its_projects_load_verdict(scope, monkeypatch):
    """A project's load verdict is checked against its sources' status once and kept; a source that
    turns active later must not leave "requires setup" standing."""
    from types import SimpleNamespace

    from flow_sdk.core.setup import load

    source = await _saved("watched")
    forgotten: list[str] = []

    async def project_of(self):
        return SimpleNamespace(id="p-1")

    monkeypatch.setattr(DataSource, "setup_project", project_of)
    monkeypatch.setattr(load, "forget", forgotten.append)

    source.cursor = "c-1"
    await source.save_runtime()
    assert forgotten == [], "a poll's bookkeeping changes nothing a load checked"

    source.status = SourceStatus.SETUP.value
    await source.save_runtime()
    assert forgotten == ["p-1"]


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


async def test_what_the_caller_set_wins_on_adoption(scope):
    """An identity stamped on a new row (a verify before its first save) survives the row being adopted:
    what the caller set wins, what it left alone stays the adopted row's."""
    first = await _saved("first")
    first.account_key = "old-key"
    first.cursor = "c-7"
    await first.save_runtime()

    second = DataSource(name="second", provider=_Mailbox.provider, config={"address": "me@x.test"})
    second.account_key, second.account_identities = "new-key", ["new-key"]
    await second.save_runtime()

    assert str(second.id) == str(first.id)
    assert (second.account_key, second.account_identities) == ("new-key", ["new-key"])
    assert second.cursor == "c-7"


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


async def test_public_access_is_private_row_policy_preserved_on_reindex(scope):
    source = DataSource(name="public", provider=_Mailbox.provider, config={"address": "me@x.test"}, open_to_all=True)
    await source.save()
    assert "open_to_all" in RUNTIME_FIELDS
    assert "open_to_all" not in _document(source)
    await index_path("data_source", _folder(source))
    row = await DataSource.get_by_id(str(source.id))
    assert row.open_to_all is True
    await DataSource.update_by_id(source.id, {"open_to_all": False})
    assert (await DataSource.get_by_id(str(source.id))).open_to_all is False


class _OwesSetup(_Mailbox):
    """A driver with a setup check of its own, as Gmail's IMAP login is."""

    provider = "asset-mailbox-owes-setup-test"
    #: What the check answers, when a test wants something other than "ready": a Verdict, or an error to raise.
    answer: object = None

    async def verify(self):
        from flow_sdk.sources import Verdict

        if isinstance(_OwesSetup.answer, Exception):
            raise _OwesSetup.answer
        return _OwesSetup.answer or Verdict(ready=True, detail="")


async def test_an_update_carrying_new_does_not_park_an_active_source(scope):
    """A client save sends the whole entity, and the TS model defaults `status` to 'new'. On a row that
    exists, 'new' is no decision: an edit must not re-run the create rules and park it in setup."""
    DataDriver.register(DataDriver.for_class(_OwesSetup, kind="datasource.test.asset"))
    source = DataSource(name="mail", provider=_OwesSetup.provider, config={"address": "me@x.test"})
    await source.save()
    source.status, source.setup_detail, source.setup_needs = SourceStatus.ACTIVE.value, "", []  # what Verify writes
    await source.save_runtime()

    await DataSource.update_by_id(source.id, {"poll_interval_seconds": 600, "status": SourceStatus.NEW.value})

    row = await DataSource.get_by_id(str(source.id))
    assert (row.status, row.setup_detail) == (SourceStatus.ACTIVE.value, "")


@pytest.mark.parametrize(
    "verified, on_resume, lands",
    [
        (True, "ready", (SourceStatus.ACTIVE.value, "")),  # the Gmail case: verified, paused, resumed
        (True, "refused", (SourceStatus.SETUP.value, "Google refused the app password.")),
        (True, "silent", (SourceStatus.ACTIVE.value, "")),  # the provider did not answer: where it stood
        (False, "silent", (SourceStatus.SETUP.value, "Finish setup, then press Verify.")),
        (False, "ready", (SourceStatus.ACTIVE.value, "")),
    ],
)
async def test_resume_returns_a_source_to_where_it_stood_and_asks_its_driver(scope, monkeypatch, verified, on_resume, lands):
    """Pause then resume is not a fresh start: a source that passed its setup check does not owe it again."""
    from flow_sdk.sources import Verdict
    from flow_sdk.sources.errors import SourceUnavailable

    answers = {
        "ready": Verdict(ready=True, detail=""),
        "refused": Verdict(ready=False, detail="Google refused the app password."),
        "silent": SourceUnavailable("no answer"),
    }
    DataDriver.register(DataDriver.for_class(_OwesSetup, kind="datasource.test.asset"))
    source = DataSource(name="mail", provider=_OwesSetup.provider, config={"address": "me@x.test"})
    await source.save()
    assert source.status == SourceStatus.SETUP.value
    if verified:
        await source.verify()

    monkeypatch.setattr(_OwesSetup, "answer", answers[on_resume])
    for _ in range(2):  # pausing and resuming again changes nothing
        await source.set_enabled(False)
        assert (await DataSource.get_by_id(str(source.id))).status == SourceStatus.DISABLED.value
        await source.set_enabled(True)
        row = await DataSource.get_by_id(str(source.id))
        assert (row.status, row.setup_detail) == lands
