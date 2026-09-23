"""The ``teams`` source's case in the data source matrix: a stateful Microsoft Graph over a loopback
socket, read and posted to with a doubled connector token, its roots minutes old."""
from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server

from .test_teams_source import CHANNEL, CONTAINER, TEAM, _FakeGraph, _message, _token, teams_source


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(DataDriver.loaded("teams"), "credentials_for", _token("graph-test-token"))
    now = datetime.now(timezone.utc)
    fake = _FakeGraph()
    fake.roots = [_message(str(n), f"root {n}", created=(now - timedelta(minutes=10 - n)).strftime("%Y-%m-%dT%H:%M:%SZ")) for n in (1, 2, 3)]
    with local_http_server(fake) as base:
        monkeypatch.setattr(teams_source, "GRAPH_API_BASE", base)
        yield {
            "config": {"channel": CONTAINER},
            "min_items": 3,
            "send": {"to": CONTAINER, "text": "matrix send"},
        }


class _Channel:
    """One Teams channel over loopback Graph: roots with their replies (``$expand=replies``), a new
    root or a reply posted into it, and ``/me`` — our own posts are ``ME``'s, as Graph reports them."""

    def __init__(self) -> None:
        self.roots: list[dict] = []
        self.replies: dict[str, list[dict]] = {}
        self.outbox: list[dict] = []

    def __call__(self, path, headers):
        route = unquote(path).partition("?")[0]
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        parts = route.strip("/").split("/")
        if parts == ["me"]:
            return self._ok({"id": "ME", "userPrincipalName": "me@x.test", "displayName": "The agent"})
        if parts[:4] != ["teams", TEAM, "channels", CHANNEL] or parts[4:5] != ["messages"]:
            return 404, json.dumps({"error": {"message": "NotFound"}}).encode(), {}
        rest = parts[5:]
        if body:  # a post: a new root, or a reply under one
            root = rest[0] if rest else None
            text = str((body.get("body") or {}).get("content") or "")
            message = _message(f"out{len(self.outbox) + 1}{uuid.uuid4().hex[:6]}", text, created=_created(), replyToId=root,
                               **{"from": {"user": {"id": "ME", "displayName": "The agent"}}})
            (self.replies.setdefault(root, []) if root else self.roots).append(message)
            self.outbox.append({"to": CONTAINER, "text": text, "thread": root, "external_id": message["id"]})
            return self._ok(message)
        if rest:
            found = next((m for m in self.roots + sum(self.replies.values(), []) if m["id"] == rest[0]), None)
            return self._ok(found) if found else (404, json.dumps({"error": {"message": "NotFound"}}).encode(), {})
        return self._ok({"value": [{**r, "replies": self.replies.get(r["id"], [])} for r in self.roots]})

    @staticmethod
    def _ok(payload):
        return 200, json.dumps(payload).encode(), {"Content-Type": "application/json"}


def _created() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Double:
    """teams as a test double: one channel on a loopback Graph, a message you can post into it as a
    person, and what the app posted. The token is the Microsoft connection's (``connector``)."""

    provider = "teams"

    #: The person who writes in: an Entra user id.
    sender = "U-matrix-person"

    def __init__(self):
        self.channel = _Channel()
        self.config: dict = {}
        self.fields: dict = {}
        self.secrets = {"token": "graph-test-token"}
        self._server = None

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.channel)
        self.config = {"channel": CONTAINER, "base_url": self._server.__enter__()}
        return self

    def __exit__(self, *exc):
        if self._server is not None:
            self._server.__exit__(*exc)
            self._server = None

    def deliver(self, text: str, *, sender: str, thread=None) -> dict:
        message = _message(f"in{uuid.uuid4().hex[:10]}", text, created=_created(),
                           **{"from": {"user": {"id": sender, "displayName": f"Person {sender}", "userIdentityType": "aadUser"}}})
        self.channel.roots.append(message)
        return {"external_id": message["id"], "thread": message["id"]}

    def sent(self) -> list[dict]:
        return list(self.channel.outbox)
