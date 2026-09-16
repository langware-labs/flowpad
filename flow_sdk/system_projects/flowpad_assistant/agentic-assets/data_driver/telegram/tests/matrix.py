"""The ``telegram`` source's case in the data source matrix: a Bot API over a loopback socket with one
queued update."""
from __future__ import annotations

import time
from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, Credentials

from .test_telegram_source import CHAT, TOKEN, _Bot, _update


@contextmanager
def case(monkeypatch, tmp_path):
    async def token(_row):  # the telegram credential, never config
        return Credentials(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})

    monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", token)
    bot = _Bot([_update(900001, date=int(time.time()))])
    with local_http_server(bot) as base:
        yield {
            "config": {"base_url": base},
            "fields": {"account_key": "@my_bot"},
            "min_items": 1,
            "send": {"to": CHAT, "text": "matrix send"},
        }
