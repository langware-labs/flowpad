"""The pure Gmail seams: mapping, UID resumption, and outbound MIME."""

from __future__ import annotations

import json
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.ingest.driver import SegmentCursorView, get_driver
from flow_sdk.ingest.drivers.gmail import (
    GmailDriver,
    _fetch_credentials,
    _fetch_messages,
    _FetchedMessage,
    _find_reply_inbox,
    _InboxSnapshot,
    _smtp_message,
)


def _source():
    return SimpleNamespace(id="gmail-source", config={"address": "Captain@Gmail.com"})


def _raw(*, message_id="<incoming@gmail.test>") -> bytes:
    message = EmailMessage()
    message["From"] = "Sailor <sailor@example.com>"
    message["To"] = "captain@gmail.com"
    message["Subject"] = "Treasure"
    message["Date"] = "Tue, 2 Sep 2025 12:00:00 +0000"
    if message_id:
        message["Message-ID"] = message_id
    message["In-Reply-To"] = "<question@gmail.test>"
    message.set_content("The treasure is under the mast.")
    return message.as_bytes()


def test_gmail_is_a_registered_message_source_with_env_only_auth():
    manifest = json.loads(
        (Path(__file__).parents[2] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_source/gmail/data_source.json").read_text()
    )

    driver = get_driver("gmail")
    assert (driver.kind, driver.record_kind, driver.sends, driver.identity_config_key) == (
        "datasource.api.gmail", "content.message.email", True, "address",
    )
    assert manifest["auth"]["env"] == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"]
    assert "app_password" not in manifest["config"]


def test_google_display_spacing_is_not_part_of_the_app_password(monkeypatch):
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop")

    assert _fetch_credentials(_source()) == ("Captain@Gmail.com", "abcdefghijklmnop")


def test_an_imap_message_maps_and_advances_the_uid_cursor():
    cursor = SegmentCursorView(segment_key="INBOX", state={"uid_validity": "44", "last_uid": 6})
    snapshot = _InboxSnapshot("44", (_FetchedMessage(7, "9988", _raw()),))

    result = GmailDriver()._result_from(_source(), "Captain@Gmail.com", cursor, snapshot)

    item = result.items[0]
    assert (item.external_id, item.thread_key, item.reply_to_external_id) == (
        "<incoming@gmail.test>", "captain@gmail.com:9988", "<question@gmail.test>",
    )
    assert (item.author_external_id, item.body.strip()) == ("sailor@example.com", "The treasure is under the mast.")
    assert result.next_state == {"uid_validity": "44", "last_uid": 7}


def test_changed_uid_validity_resets_the_cursor_and_supplies_stable_identity():
    cursor = SegmentCursorView(segment_key="INBOX", state={"uid_validity": "old", "last_uid": 900})
    snapshot = _InboxSnapshot("new", (_FetchedMessage(1, "7", _raw(message_id="")),))

    result = GmailDriver()._result_from(_source(), "captain@gmail.com", cursor, snapshot)

    assert result.items[0].external_id == "imap:new:1"
    assert result.next_state == {"uid_validity": "new", "last_uid": 1}


def test_smtp_message_has_cross_transport_reply_headers():
    message = _smtp_message(
        sender="captain@gmail.com",
        recipient="agent@example.com",
        subject="Re: Treasure",
        text="Arr, found it.",
        in_reply_to="<incoming@agent.test>",
    )

    assert str(message["Message-ID"]).endswith("@gmail.com>")
    assert message["In-Reply-To"] == "<incoming@agent.test>"
    assert message["References"] == "<incoming@agent.test>"
    assert message.get_content().strip() == "Arr, found it."


def test_imap_page_is_fetched_in_one_round_trip():
    class Client:
        calls = []

        def uid(self, *args):
            self.calls.append(args)
            return "OK", [
                (b"1 (UID 8 X-GM-THRID 22 RFC822 {1}", b"a"),
                (b"2 (UID 9 X-GM-THRID 23 RFC822 {1}", b"b"),
            ]

    client = Client()
    messages = _fetch_messages(client, [8, 9])

    assert client.calls == [("FETCH", "8,9", "(UID X-GM-THRID RFC822)")]
    assert [(message.uid, message.gmail_thread_id) for message in messages] == [(8, "22"), (9, "23")]


def test_reply_lookup_fetches_only_the_newest_matching_header(monkeypatch):
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

        def close(self):
            return "OK", []

        def logout(self):
            return "BYE", []

    client = Client()
    monkeypatch.setattr("flow_sdk.ingest.drivers.gmail.imaplib.IMAP4_SSL", lambda host: client)

    snapshot = _find_reply_inbox("captain@gmail.com", "password", "<sent@example.com>")

    assert snapshot.uid_validity == "44"
    assert [message.uid for message in snapshot.messages] == [8]
    assert client.calls == [
        ("SEARCH", None, "ALL"),
        (
            "FETCH",
            "7,8",
            "(UID X-GM-THRID BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO)])",
        ),
        ("FETCH", "8", "(UID X-GM-THRID RFC822)"),
    ]


@pytest.mark.asyncio
async def test_reply_wait_reuses_the_targeted_lookup(monkeypatch):
    source = _source()
    clients = iter((object(), object()))
    opens = []
    closes = []
    searches = [(), (_FetchedMessage(8, "22", _raw()),)]

    def open_inbox(address, password):
        client = next(clients)
        opens.append((address, password))
        return client, "44"

    monkeypatch.setenv("GMAIL_APP_PASSWORD", "password")
    monkeypatch.setattr("flow_sdk.ingest.drivers.gmail._open_inbox", open_inbox)
    monkeypatch.setattr(
        "flow_sdk.ingest.drivers.gmail._find_reply_messages",
        lambda active, external_id: searches.pop(0),
    )
    monkeypatch.setattr(
        "flow_sdk.ingest.drivers.gmail._close_inbox",
        lambda active: closes.append(active),
    )
    reply = await GmailDriver().wait_for_reply(source, "<question@gmail.test>")

    assert reply.external_id == "<incoming@gmail.test>"
    assert opens == [
        ("Captain@Gmail.com", "password"),
        ("Captain@Gmail.com", "password"),
    ]
    assert len(closes) == 2
