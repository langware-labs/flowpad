"""A Gmail source signed in with Google logs in to IMAP and SMTP with XOAUTH2 as the account that signed in;
one with an app password logs in as before. Both ways stay valid."""

from __future__ import annotations

import base64

from pydantic import SecretStr

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

gmail = asset_module("gmail")
ADDRESS = "me@example.com"


class FakeImap:
    def __init__(self):
        self.calls: list[tuple] = []

    def authenticate(self, mechanism, respond):
        self.calls.append(("authenticate", mechanism, respond(b"")))

    def login(self, user, password):
        self.calls.append(("login", user, password))


class FakeSmtp:
    def __init__(self):
        self.calls: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        self.calls.append(("ehlo",))

    def docmd(self, cmd, arg):
        self.calls.append((cmd, arg))
        return 235, b"Accepted"

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, message):
        self.calls.append(("send",))


def _mailbox(credentials: ResolvedSecrets, config: dict | None = None):
    return gmail.GmailSource(SourceBinding(config=config or {}, credentials=credentials))._mailbox()


def test_a_google_sign_in_logs_in_with_xoauth2_as_the_account_that_signed_in(monkeypatch):
    mailbox = _mailbox(ResolvedSecrets(shape=AuthShape.SECRETS, token=SecretStr("tok"), identity=ADDRESS))
    assert mailbox.address == ADDRESS and mailbox.token == "tok"
    sasl = f"user={ADDRESS}\x01auth=Bearer tok\x01\x01".encode()

    imap = FakeImap()
    gmail.login(imap, mailbox)
    assert imap.calls == [("authenticate", "XOAUTH2", sasl)]

    smtp = FakeSmtp()
    monkeypatch.setattr(gmail, "smtp_client", lambda host="": smtp)
    gmail.send_smtp(mailbox, object())
    assert ("AUTH", "XOAUTH2 " + base64.b64encode(sasl).decode()) in smtp.calls and ("send",) in smtp.calls


def test_an_app_password_still_logs_in_as_before(monkeypatch):
    values = {"GMAIL_ADDRESS": SecretStr(ADDRESS), "GMAIL_APP_PASSWORD": SecretStr("abcd efgh ijkl mnop")}
    mailbox = _mailbox(ResolvedSecrets(shape=AuthShape.SECRETS, values=values))
    assert not mailbox.token

    imap = FakeImap()
    gmail.login(imap, mailbox)
    assert imap.calls == [("login", ADDRESS, "abcdefghijklmnop")]

    smtp = FakeSmtp()
    monkeypatch.setattr(gmail, "smtp_client", lambda host="": smtp)
    gmail.send_smtp(mailbox, object())
    assert ("login", ADDRESS, "abcdefghijklmnop") in smtp.calls
