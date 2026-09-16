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

from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.source_registry import asset_module
from flow_sdk.ingest.sources import source_type
from flow_sdk.ingest.testing import position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

GmailSource = asset_module("gmail").GmailSource
smtp_message = asset_module("gmail").smtp_message
gmail_source = asset_module("gmail")

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ADDRESS = "Captain@Gmail.com"
PASSWORD = "app-pass"
ALL_MAIL = "[Gmail]/All Mail"


def _raw(*, message_id="<incoming@gmail.test>", in_reply_to="<question@gmail.test>", sender="Sailor <sailor@example.com>",
         to="captain@gmail.com", subject="Treasure", text="The treasure is under the mast.") -> bytes:
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = sender, to, subject
    message["Date"] = "Tue, 2 Sep 2025 12:00:00 +0000"
    if message_id:
        message["Message-ID"] = message_id
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
    message.set_content(text)
    return message.as_bytes()


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

    def imap(self, _host):
        return _Imap(self)

    def smtp(self, _host, _port):
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


def _view(state=None, window_start=None):
    return position(segment_key="INBOX", prior=state or {}, window_start=window_start)


@pytest.mark.parametrize("check", checks_for(GmailSource), ids=str)
async def test_conformance(check, gmail):
    for n in (1, 2, 3):
        gmail.deliver(_raw(message_id=f"<m{n}@x>", in_reply_to=""), "9988")
    binding = SourceBinding(config={"address": ADDRESS}, credentials=Credentials(shape=AuthShape.ENV, values={"GMAIL_APP_PASSWORD": SecretStr(PASSWORD)}))
    probe = GmailSource(binding)
    await check.run(Subject(
        source=lambda: GmailSource(binding),
        seeded=tuple(probe.origin(f"<m{n}@x>") for n in (1, 2, 3)),
        conversation=probe.thread_origin("9988"),
        recipient=UserProfile(origin=probe.origin("sailor@example.com"), address="sailor@example.com"),
    ))


def test_gmail_is_a_registered_message_source_with_env_only_auth():
    manifest = json.loads(
        (Path(__file__).parents[1] / "data_source.json").read_text()
    )
    driver = source_type("gmail")
    assert (driver.kind, driver.sends, driver.identity_config_key) == ("datasource.api.gmail", True, "address")
    assert manifest["auth"]["env"] == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"] and "app_password" not in manifest["config"]


async def test_the_password_is_a_credential_with_googles_display_spacing_dropped(monkeypatch):
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop")
    source = await source_type("gmail").open(_row())
    assert source._password() == "abcdefghijklmnop" and "GMAIL_APP_PASSWORD" not in source.config


async def test_the_address_falls_back_to_the_environment(monkeypatch):
    monkeypatch.setenv("GMAIL_ADDRESS", "env@gmail.com")
    source = await source_type("gmail").open(_row(address=""))
    assert source.address == "env@gmail.com"


async def test_an_imap_message_maps_and_advances_the_uid_cursor(gmail):
    gmail.deliver(_raw(), "9988", uid=7)
    result = await source_type("gmail").traverse(_row(), _view({"uid_validity": "44", "last_uid": 6}))
    (item,) = result.items
    assert (item.external_id, item.thread_key, item.reply_to_external_id) == ("<incoming@gmail.test>", "captain@gmail.com:9988", "<question@gmail.test>")
    assert (item.author_external_id, item.body.strip()) == ("sailor@example.com", "The treasure is under the mast.")
    assert ("SEARCH", None, "UID 7:*") in gmail.calls
    assert result.cursor == GmailSource.resume_at("44", 7)


async def test_changed_uid_validity_resets_the_cursor_and_supplies_stable_identity(gmail):
    gmail.validity = "45"
    gmail.deliver(_raw(message_id=""), "7", uid=1)
    result = await source_type("gmail").traverse(_row(), _view({"cursor": GmailSource.resume_at("44", 900)}))
    assert result.items[0].external_id == "imap:45:1" and result.cursor == GmailSource.resume_at("45", 1)


async def test_a_refused_login_needs_a_person(gmail, monkeypatch):
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "wrong")
    with pytest.raises(Exception) as caught:
        await source_type("gmail").traverse(_row(), _view())
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
    out = await source_type("gmail").send(_row(), thread_key="", to="sailor@example.com", text="Arr.", in_reply_to="<incoming@gmail.test>")
    (sent,) = gmail.sent
    assert (sent["To"], sent["In-Reply-To"], sent["Subject"]) == ("sailor@example.com", "<incoming@gmail.test>", "Re: Treasure")
    assert out.external_id == str(sent["Message-ID"]) and out.recorded is False


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
    monkeypatch.setattr(gmail_source.imaplib, "IMAP4_SSL", lambda host: client)
    snapshot = gmail_source.find_reply_inbox("captain@gmail.com", "password", "<sent@example.com>")
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

    def open_inbox(address, password, mailbox="INBOX"):
        opens.append((address, password))
        return next(clients), "44"

    monkeypatch.setenv("GMAIL_APP_PASSWORD", "password")
    monkeypatch.setattr(gmail_source, "open_inbox", open_inbox)
    monkeypatch.setattr(gmail_source, "_find_reply_messages", lambda active, external_id: searches.pop(0))
    monkeypatch.setattr(gmail_source, "close_inbox", lambda active: closes.append(active))

    reply = await source_type("gmail").wait_for_reply(_row(), "<question@gmail.test>")

    assert reply.external_id == "<incoming@gmail.test>"
    assert opens == [(ADDRESS, "password"), (ADDRESS, "password")] and len(closes) == 2
