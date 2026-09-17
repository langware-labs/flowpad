"""The ``slack`` source's case in the data source matrix, and the ``Double`` it is built on: a stateful
Slack over a loopback socket, read and posted to with a doubled connector token."""
from __future__ import annotations

import time
from contextlib import contextmanager

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, Credentials

from .test_slack_source import _FakeSlack

#: A channel id the manifest's own pattern accepts.
CHANNEL = "C0MATRIX1"
#: The workspace ``auth.test`` answers with, and so the row's account key.
TEAM = "T1"


class Double:
    """slack as a test double: a loopback Web API, an inbound you can inject, the outbound it saw."""

    provider = "slack"

    #: The stranger who writes in: a member id.
    sender = "U0ALICE01"

    def __init__(self, *, channel: str = CHANNEL):
        self.channel = channel
        self.slack = _FakeSlack()
        self.slack.channels = {channel: []}
        self.config: dict = {"channel": channel}
        self.fields: dict = {"account_key": TEAM}
        self.secrets: dict = {"token": "xoxb-test"}
        self._server = None

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.slack)
        self.config["base_url"] = self._server.__enter__()
        return self

    def __exit__(self, *exc) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.__exit__(*exc)

    async def credentials(self, _row) -> Credentials:
        """The in-process stand-in for ``DataDriver.credentials_for``: the connector token."""
        return Credentials(shape=AuthShape.CONNECTOR, token=SecretStr(self.secrets["token"]))

    def deliver(self, text: str, *, sender: str, thread: str | None = None) -> dict:
        """A message ``sender`` writes into the channel now (its ts is the wall clock, later than any
        ts handed out so far): the next ``conversations.history`` returns it."""
        message = self.slack.arrive(self.channel, text, user=sender, thread_ts=thread)
        return {"external_id": message["ts"], "thread": message.get("thread_ts") or message["ts"]}

    def sent(self) -> list[dict]:
        """Every ``chat.postMessage`` the double accepted, oldest first."""
        return list(self.slack.posts)


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", double.credentials)
        root = double.deliver("root", sender="U1")["external_id"]
        double.deliver("in thread", sender="U1", thread=root)
        double.deliver("later", sender="U1")
        yield {
            "config": double.config,
            "fields": double.fields,
            "min_items": 3,
            "send": {"to": CHANNEL, "text": "matrix send"},
            "double": double,
        }
