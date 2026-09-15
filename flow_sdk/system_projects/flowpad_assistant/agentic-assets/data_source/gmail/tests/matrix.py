"""The ``gmail`` source's case in the data source matrix: IMAP and SMTP doubled in process, the app
password in the environment the manifest names."""
from __future__ import annotations

from contextlib import contextmanager

from .test_gmail_source import ADDRESS, PASSWORD, _Gmail, _raw, gmail_source


@contextmanager
def case(monkeypatch, tmp_path):
    fake = _Gmail()
    monkeypatch.setattr(gmail_source.imaplib, "IMAP4_SSL", fake.imap)
    monkeypatch.setattr(gmail_source.smtplib, "SMTP_SSL", fake.smtp)
    monkeypatch.setenv("GMAIL_APP_PASSWORD", PASSWORD)
    fake.deliver(_raw(), "9988")
    yield {
        "config": {"address": ADDRESS},
        # The double's message is dated 2025; the window reaches it.
        "fields": {"account_key": ADDRESS, "window_days": 36500},
        "min_items": 1,
        "send": {"to": "sailor@example.com", "text": "matrix send", "subject": "Matrix"},
    }
