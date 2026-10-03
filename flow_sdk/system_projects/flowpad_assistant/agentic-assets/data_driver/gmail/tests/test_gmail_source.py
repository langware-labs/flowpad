"""The ``gmail`` data source over a fake IMAP + SMTP mailbox: mapping, the UID cursor, outbound
MIME, reply routing and the targeted reply lookup — with the app password reaching the source only
as a credential."""
from __future__ import annotations

import imaplib
import json
import smtplib
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import asset_module, load_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.files import local_file
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import FileKind, MessageData

GmailSource = asset_module("gmail").GmailSource
smtp_message = asset_module("gmail").smtp_message
gmail_source = asset_module("gmail")

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ADDRESS = "Captain@Gmail.com"
PASSWORD = "app-pass"
ALL_MAIL = "[Gmail]/All Mail"


def _raw(*, message_id="<incoming@gmail.test>", in_reply_to="<question@gmail.test>", sender="Sailor <sailor@example.com>",
         to="captain@gmail.com", subject="Treasure", text="The treasure is under the mast.", files=()) -> bytes:
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = sender, to, subject
    message["Date"] = "Tue, 2 Sep 2025 12:00:00 +0000"
    if message_id:
        message["Message-ID"] = message_id
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
    message.set_content(text)
    for name, media_type, blob in files:
        maintype, _, subtype = media_type.partition("/")
        message.add_attachment(blob, maintype=maintype, subtype=subtype, filename=name)
    return message.as_bytes()


MAP = ("map.png", "image/png", b"\x89PNG\r\n\x1a\n" + bytes(range(256)))
LOG = ("log.pdf", "application/pdf", b"%PDF-1.4 the captain's log")


class _Gmail:
    """INBOX and All Mail over IMAP; SMTP files what it sends into All Mail only, the way Gmail does."""

    def __init__(self, validity="44"):
        self.validity, self.boxes, self.next_uid, self.sent, self.calls = validity, {"INBOX": [], ALL_MAIL: []}, 1, [], []

    def deliver(self, raw: bytes, thread: str, *, uid=None, sent=False) -> int:
        uid = uid or self.next_uid
        self.next_uid = max(self.next_uid, uid) + 1
        self.boxes[ALL_MAIL].append((uid, thread, raw))
        if not sent:
            self.boxes["INBOX"].append((uid, thread, raw))
        return uid

    def imap(self, _host, _port=None):
        return _Imap(self)

    def smtp(self, _host, _port=None):
        return _Smtp(self)


class _Imap:
    def __init__(self, gmail):
        self.g, self.box = gmail, None

    def login(self, _address, password):
        if password != PASSWORD:
            raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials")
        return "OK", []

    def select(self, box, readonly=True):
        # Gmail's own parser: a mailbox name with a space must arrive quoted.
        if " " in box and not (box.startswith('"') and box.endswith('"')):
            return "BAD", [b"Could not parse command"]
        self.box = box.strip('"')
        return "OK", []

    def response(self, name):
        return name, [self.g.validity.encode()]

    def uid(self, command, *args):
        self.g.calls.append((command, *args))
        entries = sorted(self.g.boxes[self.box])
        if command == "SEARCH":
            criteria = args[1:]
            if criteria[0] == "ALL" or criteria[0] == "SINCE":
                uids = [e[0] for e in entries]
            elif criteria[0].startswith("UID "):
                low = int(criteria[0][4:].split(":")[0])
                uids = [e[0] for e in entries if e[0] >= low] or ([entries[-1][0]] if entries else [])
            elif criteria[0] == "X-GM-THRID":
                uids = [e[0] for e in entries if e[1] == criteria[1]]
            else:
                uids = [e[0] for e in entries if f"Message-ID: {criteria[2]}".encode() in e[2]]
            return "OK", [" ".join(map(str, uids)).encode()]
        wanted, query = {int(u) for u in args[0].split(",")}, args[1]
        parts = []
        for uid, thread, raw in entries:
            if uid in wanted:
                body = raw if "RFC822" in query else raw.split(b"\n\n", 1)[0] + b"\r\n\r\n"
                parts.append((f"{uid} (UID {uid} X-GM-THRID {thread} BODY {{{len(body)}}}".encode(), body))
        return "OK", parts

    def logout(self):
        return "BYE", []


class _Smtp:
    def __init__(self, gmail):
        self.g = gmail

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def login(self, _address, password):
        if password != PASSWORD:
            raise smtplib.SMTPAuthenticationError(535, b"bad credentials")

    def send_message(self, message):
        parent = str(message.get("In-Reply-To") or "")
        thread = next((t for _, t, r in self.g.boxes[ALL_MAIL] if parent and f"Message-ID: {parent}".encode() in r), None)
        self.g.sent.append(message)
        self.g.deliver(message.as_bytes(), thread or str(9000 + self.g.next_uid), sent=True)


@pytest.fixture
def gmail(monkeypatch):
    fake = _Gmail()
    monkeypatch.setattr(gmail_source.imaplib, "IMAP4_SSL", fake.imap)
    monkeypatch.setattr(gmail_source.smtplib, "SMTP_SSL", fake.smtp)
    monkeypatch.setenv("GMAIL_APP_PASSWORD", PASSWORD)
    return fake


def _row(**config):
    return SimpleNamespace(id="gmail-source", provider="gmail", account_key="", account_identities=[], config={"address": ADDRESS, **config})


def _view(prior=None, *, cursor=None, window_start=None):
    return position(prior, cursor=cursor, window_start=window_start)


@pytest.mark.parametrize("check", checks_for(GmailSource), ids=str)
async def test_conformance(check, gmail):
    for n in (1, 2, 3):
        gmail.deliver(_raw(message_id=f"<m{n}@x>", in_reply_to=""), "9988")
    gmail.deliver(_raw(message_id="<files@x>", in_reply_to="", files=(LOG, MAP)), "9989", sent=True)
    probe = GmailSource(_binding())
    await check.run(Subject(
        source=lambda: GmailSource(_binding()),
        seeded=tuple(probe.origin(f"<m{n}@x>") for n in (1, 2, 3)),
        conversation=probe.thread_origin("9988"),
        recipient=UserProfile(origin=probe.origin("sailor@example.com"), address="sailor@example.com"),
        # Handed out by an earlier session: `open` finds the message again in All Mail.
        inbound_file=_attachment(probe, "<files@x>", 1),
        inbound_bytes=MAP[2],
    ))


def _binding():
    return SourceBinding(config={"address": ADDRESS}, credentials=ResolvedSecrets(shape=AuthShape.ENV, values={"GMAIL_APP_PASSWORD": SecretStr(PASSWORD)}))


def _attachment(source, message_key, index):
    from flow_sdk.sources.values.items import FileItem, MessageFileData

    return FileItem(origin=source.origin(f"{message_key}#{index}"), data=MessageFileData())


async def _read(source, file) -> bytes:
    async with source.open(file) as chunks:
        return b"".join([chunk async for chunk in chunks])


def test_gmail_is_a_registered_message_source_with_env_only_auth():
    manifest = json.loads(
        (Path(__file__).parents[1] / "data_driver.json").read_text()
    )
    driver = DataDriver.loaded("gmail")
    assert (driver.kind, driver.sends, driver.identity_config_key) == ("datasource.api.gmail", True, "address")
    assert manifest["auth"]["env"] == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"] and "app_password" not in manifest["config"]


async def test_the_password_is_a_credential_with_googles_display_spacing_dropped(monkeypatch):
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop")
    source = await DataDriver.loaded("gmail").open(_row())
    assert source._password() == "abcdefghijklmnop" and "GMAIL_APP_PASSWORD" not in source.config


async def test_the_address_falls_back_to_the_environment(monkeypatch):
    monkeypatch.setenv("GMAIL_ADDRESS", "env@gmail.com")
    source = await DataDriver.loaded("gmail").open(_row(address=""))
    assert source.address == "env@gmail.com"


async def test_an_imap_message_maps_and_advances_the_uid_cursor(gmail):
    gmail.deliver(_raw(), "9988", uid=7)
    result = await DataDriver.loaded("gmail").traverse(_row(), _view(cursor=GmailSource.resume_at("44", 6)))
    (item,) = result.items
    assert (item.external_id, item.thread_key, item.reply_to_external_id) == ("<incoming@gmail.test>", "captain@gmail.com:9988", "<question@gmail.test>")
    assert (item.author_external_id, item.body.strip()) == ("sailor@example.com", "The treasure is under the mast.")
    assert ("SEARCH", None, "UID 7:*") in gmail.calls
    assert result.cursor == GmailSource.resume_at("44", 7)


async def test_changed_uid_validity_resets_the_cursor_and_supplies_stable_identity(gmail):
    gmail.validity = "45"
    gmail.deliver(_raw(message_id=""), "7", uid=1)
    result = await DataDriver.loaded("gmail").traverse(_row(), _view(cursor=GmailSource.resume_at("44", 900)))
    assert result.items[0].external_id == "imap:45:1" and result.cursor == GmailSource.resume_at("45", 1)


async def test_a_refused_login_needs_a_person(gmail, monkeypatch):
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "wrong")
    with pytest.raises(Exception) as caught:
        await DataDriver.loaded("gmail").traverse(_row(), _view())
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


def test_smtp_message_has_cross_transport_reply_headers():
    message = smtp_message(sender="captain@gmail.com", recipient="agent@example.com", subject="Re: Treasure", text="Arr, found it.", in_reply_to="<incoming@agent.test>")
    assert str(message["Message-ID"]).endswith("@gmail.com>")
    assert (message["In-Reply-To"], message["References"]) == ("<incoming@agent.test>", "<incoming@agent.test>")
    assert message.get_content().strip() == "Arr, found it."


def test_imap_page_is_fetched_in_one_round_trip():
    class Client:
        calls = []

        def uid(self, *args):
            self.calls.append(args)
            return "OK", [(b"1 (UID 8 X-GM-THRID 22 RFC822 {1}", b"a"), (b"2 (UID 9 X-GM-THRID 23 RFC822 {1}", b"b")]

    client = Client()
    messages = gmail_source._fetch_messages(client, [8, 9])
    assert client.calls == [("FETCH", "8,9", "(UID X-GM-THRID RFC822)")]
    assert [(m.uid, m.thread_id) for m in messages] == [(8, "22"), (9, "23")]


async def test_a_reply_routes_to_the_author_with_the_reply_headers(gmail):
    gmail.deliver(_raw(), "9988")
    out = await DataDriver.loaded("gmail").send(_row(), thread_key="", to="sailor@example.com", text="Arr.", in_reply_to="<incoming@gmail.test>")
    (sent,) = gmail.sent
    assert (sent["To"], sent["In-Reply-To"], sent["Subject"]) == ("sailor@example.com", "<incoming@gmail.test>", "Re: Treasure")
    assert out.external_id == str(sent["Message-ID"]) and out.recorded is True


async def test_reply_lookup_fetches_only_the_newest_matching_header(monkeypatch):
    class Client:
        calls = []

        def login(self, address, password):
            return "OK", []

        def select(self, mailbox, readonly):
            return "OK", []

        def response(self, name):
            return "UIDVALIDITY", [b"44"]

        def uid(self, *args):
            self.calls.append(args)
            if args[0] == "SEARCH":
                return "OK", [b"7 8"]
            if "HEADER.FIELDS" in args[2]:
                return "OK", [
                    (b"1 (UID 7 X-GM-THRID 21 BODY {1}", b"In-Reply-To: <other@example.com>\r\n\r\n"),
                    (b"2 (UID 8 X-GM-THRID 22 BODY {1}", b"In-Reply-To: <sent@example.com>\r\n\r\n"),
                ]
            return "OK", [(b"2 (UID 8 X-GM-THRID 22 RFC822 {1}", b"a")]

        def logout(self):
            return "BYE", []

    client = Client()
    monkeypatch.setattr(gmail_source.imaplib, "IMAP4_SSL", lambda host, port: client)
    snapshot = gmail_source.find_reply_inbox(gmail_source.Mailbox("captain@gmail.com", "password"), "<sent@example.com>")
    assert snapshot.uid_validity == "44" and [m.uid for m in snapshot.messages] == [8]
    assert client.calls == [
        ("SEARCH", None, "ALL"),
        ("FETCH", "7,8", "(UID X-GM-THRID BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO)])"),
        ("FETCH", "8", "(UID X-GM-THRID RFC822)"),
    ]


async def test_reply_wait_reuses_the_targeted_lookup(monkeypatch):
    clients = iter((object(), object()))
    opens, closes = [], []
    searches = [(), (gmail_source.FetchedMessage(8, "22", _raw()),)]

    def open_inbox(account, mailbox="INBOX"):
        opens.append((account.address, account.password))
        return next(clients), "44"

    monkeypatch.setenv("GMAIL_APP_PASSWORD", "password")
    monkeypatch.setattr(gmail_source, "open_inbox", open_inbox)
    monkeypatch.setattr(gmail_source, "_find_reply_messages", lambda active, external_id: searches.pop(0))
    monkeypatch.setattr(gmail_source, "close_inbox", lambda active: closes.append(active))

    reply = await DataDriver.loaded("gmail").wait_for_reply(_row(), "<question@gmail.test>")

    assert reply.external_id == "<incoming@gmail.test>"
    assert opens == [(ADDRESS, "password"), (ADDRESS, "password")] and len(closes) == 2


async def test_an_expected_reply_is_stored_under_the_origin_it_returns(monkeypatch):
    """``expect_reply`` ingests the reply it found, and the returned envelope names the row.

    Gmail scopes every origin under its mailbox (``<account>/INBOX``), so the identity is the one
    the source stamped — ``reply.origin`` — not one re-derived from the row's account alone
    (``legacy_lift.origin_of`` gives ``<account>``, which no Gmail row is stored under)."""
    import uuid

    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.ingest.driver_runtime import SendOutcome

    monkeypatch.setenv("GMAIL_APP_PASSWORD", "password")
    monkeypatch.setattr(gmail_source, "open_inbox", lambda account, mailbox="INBOX": (object(), "44"))
    monkeypatch.setattr(gmail_source, "close_inbox", lambda active: None)
    monkeypatch.setattr(gmail_source, "_find_reply_messages", lambda active, external_id: (gmail_source.FetchedMessage(8, "22", _raw()),))
    driver = await DataDriver.get("gmail")
    address = ADDRESS.lower()
    source = driver.create_source(driver.create_config(address=address), name=f"gmail-{uuid.uuid4().hex[:8]}",
                                  account_key=address, account_identities=[address])
    await source.save()

    reply = await source.expect_reply(SendOutcome(external_id="<question@gmail.test>"))

    assert reply.origin is not None and reply.origin.namespace == f"{address}/INBOX"
    stored = await SourceItem.find_existing(str(source.id), reply.origin)
    assert stored is not None and stored.external_id == "<incoming@gmail.test>"


async def test_the_double_delivers_after_the_source_exists_and_records_the_reply(monkeypatch):
    Double = load_module(Path(__file__).parent, "matrix").Double  # as the matrix runner loads it
    driver = DataDriver.loaded("gmail")
    with Double() as double:
        monkeypatch.setattr(driver, "credentials_for", double.credentials)
        row = _row(**double.config)
        first = await driver.traverse(row, _view())
        assert not first.items

        delivered = double.deliver("Where is the treasure?", sender="sailor@example.com")
        second = await driver.traverse(row, _view(cursor=first.cursor))
        (item,) = second.items
        assert (item.external_id, item.author_external_id, item.body.strip()) == (delivered["external_id"], "sailor@example.com", "Where is the treasure?")
        assert item.thread_key == f"captain@gmail.com:{delivered['thread']}"

        out = await driver.send(row, thread_key="", to="sailor@example.com", text="Under the mast.", in_reply_to=delivered["external_id"])
        (sent,) = double.sent()
        assert sent == {"to": "sailor@example.com", "text": "Under the mast.", "thread": delivered["external_id"], "external_id": out.external_id}


async def test_inbound_attachments_map_in_order_and_open_from_the_session(gmail):
    gmail.deliver(_raw(files=(LOG, MAP)), "9988", uid=7)
    async with GmailSource(_binding()) as source:
        (item,) = (await source.fetch()).items
        log, chart = item.data.attachments
        assert [(f.origin.key, f.data.name, f.data.media_type, f.data.size, f.data.as_) for f in (log, chart)] == [
            ("<incoming@gmail.test>#0", "log.pdf", "application/pdf", len(LOG[2]), FileKind.DOCUMENT),
            ("<incoming@gmail.test>#1", "map.png", "image/png", len(MAP[2]), FileKind.IMAGE),
        ]
        assert chart.origin.namespace == item.origin.namespace and item.data.text.strip() == "The treasure is under the mast."
        assert item.data.sender.name == "Sailor"  # the sender's name, never an attachment's file name
        fetches = len(gmail.calls)
        assert (await _read(source, chart), await _read(source, log)) == (MAP[2], LOG[2])
        assert len(gmail.calls) == fetches  # served from this session's copy, no round trip


async def test_an_attachment_of_mail_without_a_message_id_reopens_by_its_uid(gmail):
    gmail.deliver(_raw(message_id="", files=(MAP,)), "9988", uid=3)
    async with GmailSource(_binding()) as source:
        assert await _read(source, _attachment(source, "imap:44:3", 0)) == MAP[2]
        with pytest.raises(Exception, match="no attachment 4"):
            await _read(source, _attachment(source, "imap:44:3", 4))


async def test_files_go_out_as_mime_attachments_on_the_threaded_reply(gmail, tmp_path):
    gmail.deliver(_raw(), "9988")
    paths = []
    for name, _media_type, blob in (LOG, MAP):
        (path := tmp_path / name).write_bytes(blob)
        paths.append(local_file(path))
    out = await DataDriver.loaded("gmail").send(
        _row(), thread_key="", to="sailor@example.com", text="The log and the map.", in_reply_to="<incoming@gmail.test>", files=tuple(paths)
    )
    (sent,) = gmail.sent  # one email carries the body and every file
    assert (sent["In-Reply-To"], sent["References"], sent["Subject"]) == ("<incoming@gmail.test>", "<incoming@gmail.test>", "Re: Treasure")
    assert gmail_source.message_body(sent).strip() == "The log and the map."
    assert gmail_source.message_attachments(sent) == [LOG, MAP]
    assert out.parts == (str(sent["Message-ID"]),)


async def test_a_file_without_text_sends_an_empty_body(gmail, tmp_path):
    (path := tmp_path / "map.png").write_bytes(MAP[2])
    async with GmailSource(_binding()) as source:
        recipient = UserProfile(origin=source.origin("sailor@example.com"), address="sailor@example.com")
        sent = await source.send(MessageData(recipients=(recipient,), attachments=(local_file(path),)))
    (mail,) = gmail.sent
    assert gmail_source.message_attachments(mail) == [MAP] and not gmail_source.message_body(mail).strip()
    assert sent.data.text is None and [f.data.name for f in sent.data.attachments] == ["map.png"]


async def test_a_file_that_is_not_local_is_refused_before_any_io(gmail):
    async with GmailSource(_binding()) as source:
        recipient = UserProfile(origin=source.origin("sailor@example.com"), address="sailor@example.com")
        with pytest.raises(ValueError, match="local file"):
            await source.send(MessageData(text="hi", recipients=(recipient,), attachments=(_attachment(source, "<m@x>", 0),)))
    assert not gmail.sent and not gmail.calls


async def test_the_double_carries_files_both_ways(monkeypatch, tmp_path):
    Double = load_module(Path(__file__).parent, "matrix").Double
    driver = DataDriver.loaded("gmail")
    with Double() as double:
        monkeypatch.setattr(driver, "credentials_for", double.credentials)
        delivered = double.deliver("The map.", sender="sailor@example.com", files=[{"name": MAP[0], "media_type": MAP[1], "bytes": MAP[2]}])
        async with await driver.open(_row(**double.config)) as source:
            (item,) = (await source.fetch()).items
            (chart,) = item.data.attachments
            assert chart.origin.key == f"{delivered['external_id']}#0" and await _read(source, chart) == MAP[2]
        (path := tmp_path / LOG[0]).write_bytes(LOG[2])
        await driver.send(_row(**double.config), thread_key="", to="sailor@example.com", text="The log.", in_reply_to=delivered["external_id"], files=(local_file(path),))
        (sent,) = double.sent()
        assert sent["thread"] == delivered["external_id"] and sent["files"] == [{"name": LOG[0], "media_type": LOG[1], "bytes": LOG[2]}]
