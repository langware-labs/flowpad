"""The ``gmail`` source's case in the data source matrix: IMAP and SMTP doubled in process, the app
password in the environment the manifest names, one message received just now."""
from __future__ import annotations

from contextlib import contextmanager
from email import policy
from email.parser import BytesParser
from email.utils import formatdate

from .test_gmail_source import ADDRESS, PASSWORD, _Gmail, _raw, gmail_source


def _received_now() -> bytes:
    message = BytesParser(policy=policy.default).parsebytes(_raw())
    del message["Date"]
    message["Date"] = formatdate(usegmt=True)
    return message.as_bytes()


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Gmail()
    monkeypatch.setattr(gmail_source.imaplib, "IMAP4_SSL", fake.imap)
    monkeypatch.setattr(gmail_source.smtplib, "SMTP_SSL", fake.smtp)
    monkeypatch.setenv("GMAIL_APP_PASSWORD", PASSWORD)
    fake.deliver(_received_now(), "9988")
    yield {
        "config": {"address": ADDRESS},
        "fields": {"account_key": ADDRESS},
        "min_items": 1,
        "send": {"to": "sailor@example.com", "text": "matrix send", "subject": "Matrix"},
    }
