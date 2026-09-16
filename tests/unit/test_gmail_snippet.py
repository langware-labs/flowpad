"""The Gmail source snippet, run as written.

The one property the page promises — the app password is never copied into the row — is the
one this pins. Environment is stubbed; nothing contacts Gmail.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.data_source import DataSource
from tests.utils.snippets import doc, fences, run_fence

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def test_the_gmail_snippet_runs_and_keeps_the_password_out_of_the_row(monkeypatch):
    monkeypatch.setenv("GMAIL_ADDRESS", "you@gmail.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcdefghijklmnop")

    (source,) = fences(doc("gmail-source.md"))
    ns = await run_fence(source, filename="gmail-source.md")

    gmail: DataSource = ns["gmail"]
    row = await DataSource.get_one({"id": gmail.id})
    assert row.provider == "gmail" and row.account_key == "you@gmail.com"
    assert row.account_identities == ["you@gmail.com"]
    assert "abcdefghijklmnop" not in row.model_dump_json(), "the app password must never reach the row"
