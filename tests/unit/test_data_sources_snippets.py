"""``docs/snippets/data-sources.md``, section by section, run as written.

Sections are addressed by heading so a snippet inserted above does not re-point a pin. The
names a fence uses but does not define — ``FEED_URL``, ``KEY``, ``WATCHED``, ``DESTINATION``,
``src`` — are what a reader would have in scope, and are supplied through the namespace.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from tests.unit._ingest_helpers import fixture_bytes, local_http_server
from tests.utils.snippets import doc, fence_under, point_driver_at, run_fence

# Doc snippets name their sources for a reader, so each runs in its own user scope.
pytestmark = [pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

DOC = "data-sources.md"
REPO = Path(__file__).resolve().parents[2]


def _fresh_feed():
    """The atom fixture, re-dated to now.

    The page says a first run takes only items inside ``window_days``; the fixture's entries
    are months old, so served as-is the snippet's sync would honestly create nothing.
    """
    from flow_sdk.ingest.testing import fresh_timestamps

    body = fresh_timestamps(fixture_bytes("atom.xml"))

    def respond(_path, _headers):
        return 200, body, {"Content-Type": "application/xml"}

    return respond


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(_fresh_feed()) as url:
        yield url


async def _section(heading: str, ns: dict | None = None, *, nth: int = 0) -> dict:
    return await run_fence(fence_under(doc(DOC), heading, nth=nth), ns, filename=f"{DOC} § {heading}")


async def test_1_connect_a_feed_and_sync_it_once(feed_server):
    ns = await _section("1.", {"FEED_URL": f"{feed_server}/atom"})
    # Re-dated to now, all three fixture entries fall inside the window.
    assert ns["outcome"].created == 3
    assert {"First atom entry", "Second atom entry"} <= {r.name for r in ns["rows"]}
    # The contract the prose states: a second sync on an unchanged feed writes nothing.
    again = await ns["src"].sync()
    assert (again.created, again.updated) == (0, 0)


async def test_2_reuse_instead_of_duplicate():
    ns = await _section("2.")
    first = ns["src"]
    ns = await _section("2.")
    assert ns["src"].id == first.id, "the second run must find the row, not mint a twin"


async def test_3_search_what_landed(feed_server):
    src = (await _section("1.", {"FEED_URL": f"{feed_server}/atom"}))["src"]
    ns = await _section("3.")
    assert any(h.data_source_id == str(src.id) for h in ns["hits"]), "the atom fixture's zebrafish entry is found"


async def test_4_watch_a_folder_and_mirror_it(tmp_path):
    watched, dest = tmp_path / "watched", tmp_path / "dest"
    watched.mkdir()
    (watched / "note.md").write_text("# Note\n\nhello\n")
    ns = await _section("4.", {"WATCHED": str(watched), "DESTINATION": str(dest)})
    assert (dest / "note.md").exists()
    assert ns["src"].reflect == "copy"


async def test_5_subscribe_to_arrivals(feed_server, capsys):
    ns = await _section("1.", {"FEED_URL": f"{feed_server}/atom"})
    await ns["src"].purge_items()          # so the subscribed sync has something to announce
    await ns["src"].reset()
    ns = await _section("5.", ns)
    assert "ingest.rss.item.created" in capsys.readouterr().out


async def _watched_source(tmp_path) -> DataSource:
    """A folder source of its own name — what §6 and §7 name as ``SOURCE``."""
    import uuid

    from flow_sdk.builtin.data_driver import DataDriver

    (tmp_path / "w").mkdir()
    folder = await DataDriver.get("folder")
    src = folder.create_source(folder.create_config(root=str(tmp_path / "w")), name=f"notes {uuid.uuid4().hex[:8]}")
    await src.save()
    return src


async def test_6_write_items_in_from_outside_a_driver(tmp_path):
    src = await _watched_source(tmp_path)
    ns = await _section("6.", {"SOURCE": src.name})
    assert [o.status for o in ns["report"].outcomes] == ["created"]
    ns = await _section("6.", {"SOURCE": src.name})
    assert [o.status for o in ns["report"].outcomes] == ["unchanged"], "a re-run converges, never duplicates"


async def test_7_operate_a_source(tmp_path):
    src = await _watched_source(tmp_path)
    await _section("7.", {"SOURCE": src.name})   # verify, poll_now, replay, reset, purge_items, delete
    assert await DataSource.get_one({"id": src.id}) is None, "delete() cascades"


async def test_7_read_the_row_first(tmp_path):
    watched, dest = tmp_path / "w", tmp_path / "d"
    watched.mkdir()
    ns = await _section("4.", {"WATCHED": str(watched), "DESTINATION": str(dest)})
    ns = await _section("7.", ns, nth=1)
    assert ns["src"].status in {"new", "setup", "active"}


async def test_11_consume_a_source_yourself(tmp_path):
    watched, dest = tmp_path / "w", tmp_path / "d"
    (watched / "notes").mkdir(parents=True)
    (watched / "notes" / "a.md").write_text("# A\n")
    (watched / "b.md").write_text("# B\n")
    ns = await _section("4.", {"WATCHED": str(watched), "DESTINATION": str(dest)})
    src: DataSource = ns["src"]
    src.cursor = None
    await src.save_runtime()

    ns = await _section("11.", ns)

    assert [item.origin.key for item in ns["notes"]] == ["notes/a.md"]
    assert (await DataSource.get_one({"id": src.id})).cursor is None, "reset() forgets the position"


async def _folder_source(name: str, root: Path):
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.ingest.reflect import ReflectMode

    driver = await DataDriver.get("folder")
    src = driver.create_source(driver.create_config(root=str(root)), name=name, reflect=ReflectMode.NONE.value)
    await src.save()
    return src


async def test_12_read_two_sources_as_one(tmp_path):
    for tree in ("notes", "docs"):
        (tmp_path / tree / "2026").mkdir(parents=True)
        (tmp_path / tree / "2026" / "a.md").write_text("# a\n")
        (tmp_path / tree / "old.md").write_text("# old\n")
    ns = await _section("12.", {
        "notes": await _folder_source("notes", tmp_path / "notes"),
        "docs": await _folder_source("docs", tmp_path / "docs"),
    })
    assert [item.origin.key for item in ns["recent"]] == ["2026/a.md", "2026/a.md"], "narrowed on both sources"
    assert ns["owner"].name in {"notes", "docs"}
    assert set(ns["seen"]) <= {"notes", "docs"}


async def test_12_a_reply_goes_through_the_source_the_item_came_from():
    from tests.utils.fake_source import scripted_provider

    with scripted_provider("merge-support") as support, scripted_provider("merge-sales") as sales:
        support.push({"body": "help", "author": "a@example.com"})
        sales.push({"body": "quote?", "author": "b@example.com"})
        rows = {}
        for name, provider in (("support", "merge-support"), ("sales", "merge-sales")):
            rows[name] = DataSource(name=f"{name} box", provider=provider, account_key=f"acct-{name}")
            await rows[name].save()
        await _section("12.", dict(rows), nth=1)
    assert [s["text"] for s in support.sent] == ["on it"] and [s["text"] for s in sales.sent] == ["on it"]


async def _gcs_spec():
    """The `gcs` manifest as a row, minted once for this module.

    Built from the SHIPPED manifest rather than a hand-written one, so this also proves
    `bucket` is really marked choosable where it ships — a fence passing against a fixture
    the product does not use would pin nothing. Find-or-create because the suite shares one
    database and a second row would make the lookup ambiguous.
    """
    import json

    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.schema.data_spec.data_driver_spec import DataDriverSpec

    path = REPO / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/gcs/data_driver.json"
    manifest = DataDriverSpec.model_validate(json.loads(path.read_text()))
    assert manifest.config["bucket"].choices is True, "the shipped manifest is what the form reads"
    existing = await DataDriver.get_all({"name": manifest.name})
    if existing:
        return existing[0]
    row = DataDriver(name=manifest.name, title=manifest.title, config=manifest.config)
    await row.save()
    return row


async def test_9_ask_a_provider_what_you_can_pick(monkeypatch):
    """The picker, against a loopback Storage API.

    The spec row is built from the SHIPPED manifest rather than a hand-written one, so this
    also proves `bucket` is really marked choosable where it ships — a fence that passed
    against a fixture the product does not use would pin nothing.
    """
    import json

    from pydantic import SecretStr

    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.sources.credentials import AuthShape, Credentials

    await _gcs_spec()

    # The one thing a loopback server cannot supply: the credential comes from the
    # machine's connection store, not over the wire.
    async def _token(_row):
        return Credentials(shape=AuthShape.CONNECTOR, token=SecretStr("tok"))

    monkeypatch.setattr(DataDriver.loaded("gcs"), "credentials_for", _token)

    def storage(_path, _headers):
        body = {"items": [{"name": "acme-docs", "location": "US"}, {"name": "acme-logs", "location": "EU"}]}
        return 200, json.dumps(body).encode(), {"Content-Type": "application/json"}

    with local_http_server(storage) as base:
        point_driver_at(monkeypatch, "gcs", "GCS_API_BASE", base)
        ns = await _section("9.", {"PROJECT": "acme-prod"})

    assert [c.id for c in ns["picks"].items] == ["acme-docs", "acme-logs"]
    assert ns["picks"].detail == "", "a list is the whole answer"


async def test_9_a_refusal_is_a_sentence_not_an_exception():
    """The claim the section makes in prose, executed: no project, no exception."""
    await _gcs_spec()

    picks = await DataSource.choices_for("gcs", "bucket", {})
    assert picks.items == [] and "GCP project" in picks.detail

    assert await DataSource.choices_for("gcs", "cache_root") is None, (
        "a field the manifest never marked is a caller bug, not a refusal"
    )


async def test_10_a_source_behind_a_connection(tmp_path, monkeypatch):
    """The Drive fence, against the gdrive asset's own loopback Drive and a
    doubled `google` connection. Two runs pin the section's two sentences: with
    no connection `verify()` says so, parks the row and fetches nothing; with
    one, the first `sync()` lands the drive in `cache_root` and the mirror.
    """
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
    from flow_sdk.sources.credentials import Credentials

    drive = load_module(SHIPPED_ROOT / "gdrive" / "tests", "test_gdrive_source")
    cache, dest = tmp_path / "cache", tmp_path / "dest"

    def names(root):
        return sorted(p.name for p in root.rglob("*.txt"))

    with local_http_server(drive._Drive(drive.SEEDED)) as base:
        point_driver_at(monkeypatch, "gdrive", "DRIVE_API_BASE", base)
        env = {"CACHE_ROOT": str(cache), "DESTINATION": str(dest)}

        monkeypatch.setattr(DataDriver.loaded("gdrive"), "credentials_for", drive._credentials(Credentials()))
        ns = await _section("10.", dict(env))
        assert ns["verdict"]["ready"] is False
        assert "Google" in ns["verdict"]["detail"]
        assert ns["src"].status == "setup"
        assert names(cache) == [], "nothing is fetched without a connection"
        await ns["src"].delete()

        monkeypatch.setattr(DataDriver.loaded("gdrive"), "credentials_for", drive._credentials(drive.TOKEN))
        ns = await _section("10.", dict(env))
        assert ns["verdict"]["ready"] is True
        assert ns["src"].status == "active"
        assert names(cache) == names(dest) == ["one.txt", "three.txt", "two.txt"]
        assert ns["outcome"].created == 0, "the report counts records; a file source shows in the tree"
        await ns["src"].delete()


async def test_13_three_families():
    """The family each shipped driver declares, and that only a message source answers."""
    ns = await _section("13.")
    assert ns["families"] == ("object", "record", "message")
    assert ns["answers"] == (False, False, True)


async def test_14_write_your_own_driver():
    """The fence's driver pages, gets by key, and passes the SDK's own conformance kit."""
    from flow_sdk.sources.testing.conformance import Subject, run_all

    ns = await _section("14.", {})
    assert [i.data.text for i in ns["page"].items] == ["Simple is better than complex.", "Flat is better than nested."]
    assert ns["page"].next_cursor is not None
    fresh = lambda: ns["ZenSource"](ns["SourceBinding"](config={}, account_key="zen"))  # noqa: E731
    results = await run_all(Subject(source=fresh, seeded=tuple(fresh().origin(k) for k in ("q1", "q2", "q3"))))
    assert results and not {name: err for name, err in results.items() if err is not None}, results


async def test_8_reply_through_the_source():
    """§8 as written: answer an ingested message through its source, then wait for the other side's reply."""
    import asyncio
    import uuid

    from flow_sdk.ingest.sync import sync_source
    from tests.utils.fake_source import scripted_provider

    with scripted_provider("agentmail") as mail:
        mail.push({"name": "Invoice?", "body": "did it arrive?", "author": "alice@example.com", "thread_key": "t1"})
        src = DataSource(name=f"mail {uuid.uuid4().hex[:6]}", provider="agentmail",
                         config={"inbox": "reply-demo@agentmail.to"})
        await src.save()
        await sync_source(src)

        async def alice_answers():
            await mail.sent_event.wait()
            mail.push({"body": "Great, thanks!", "author": "alice@example.com", "thread_key": "t1",
                       "reply_to_external_id": mail.sent[-1]["external_id"]})

        answering = asyncio.create_task(alice_answers())
        ns = await _section("8.", {"SOURCE": src.name})
        await answering
    assert mail.sent[-1]["to"] == "alice@example.com" and ns["reply"].body == "Great, thanks!"
