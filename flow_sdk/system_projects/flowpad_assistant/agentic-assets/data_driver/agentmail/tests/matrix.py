"""The ``agentmail`` source's case in the data source matrix: an inbox over a loopback AgentMail API."""
from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote

from flow_sdk.ingest.testing import local_http_server

from .test_agentmail_source import INBOX, MSG, _AgentMail


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: "am_test")  # the key is a machine secret, never config
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    fake = _AgentMail([{**MSG, "timestamp": now}])
    with local_http_server(fake) as base:
        yield {
            "config": {"inbox": INBOX, "base_url": base},
            "fields": {"account_key": INBOX},
            "min_items": 1,
            "send": {"to": "someone@example.com", "text": "matrix send", "subject": "Matrix"},
        }


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class _Inbox:
    """One AgentMail inbox over loopback: listed by page token, written to by send and reply, with
    what WE sent kept in the listing as ours (``from`` is the inbox), as AgentMail does."""

    def __init__(self, inbox: str, key: str) -> None:
        self.inbox, self.key, self.messages, self.outbox = inbox, key, [], []

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        if headers.get("Authorization") != f"Bearer {self.key}":
            return self._json(401, {"error": "bad key"})
        if route.endswith("/messages/send") or route.endswith("/reply"):
            answered = unquote(route.split("/messages/")[1][: -len("/reply")]) if route.endswith("/reply") else ""
            parent = next((m for m in self.messages if m["message_id"] == answered), None)
            if answered and parent is None:
                return self._json(404, {"error": "no such message"})
            thread = parent["thread_id"] if parent else f"t-{uuid.uuid4().hex[:8]}"
            sent = {"message_id": f"<out-{uuid.uuid4().hex[:8]}@agentmail.to>", "thread_id": thread, "timestamp": _now(),
                    "from": self.inbox, "to": list(body.get("to") or ([parent["from"]] if parent else [])),
                    "subject": body.get("subject") or (parent or {}).get("subject") or "", "preview": body.get("text") or ""}
            self.messages.append(sent)
            self.outbox.append({"to": ",".join(sent["to"]), "text": body.get("text"), "thread": thread,
                                "external_id": sent["message_id"]})
            return self._json(200, {"message_id": sent["message_id"], "thread_id": thread})
        # Newest first, as AgentMail lists an inbox: a pass reads the first page down to what it has
        # seen, so an oldest-first listing hid every new message once the inbox outgrew one page.
        start, limit = int(params.get("page_token") or 0), int(params.get("limit") or 25)
        page = sorted(self.messages, key=lambda m: m["timestamp"], reverse=True)[start:start + limit]
        more = start + limit < len(self.messages)
        return self._json(200, {"messages": page, **({"next_page_token": str(start + limit)} if more else {})})

    @staticmethod
    def _json(status: int, reply: dict):
        return status, json.dumps(reply).encode(), {"Content-Type": "application/json"}


class Double:
    """agentmail as a test double: a loopback inbox you can write into, and what was sent from it.
    The key is a machine secret (``ingest_api.agentmail``) — never config."""

    provider = "agentmail"

    #: The outsider who writes in.
    sender = "outsider@example.com"

    def __init__(self):
        self.inbox_address = f"matrix-{uuid.uuid4().hex[:8]}@agentmail.to"
        self.secrets = {"api_key": "am_test"}
        self.inbox = _Inbox(self.inbox_address, self.secrets["api_key"])
        self.config: dict = {}
        self.fields = {"account_key": self.inbox_address}
        self._server = None

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.inbox)
        self.config = {"inbox": self.inbox_address, "base_url": self._server.__enter__()}
        return self

    def __exit__(self, *exc):
        if self._server is not None:
            self._server.__exit__(*exc)
            self._server = None

    def deliver(self, text: str, *, sender: str, thread=None) -> dict:
        message_id = f"<in-{uuid.uuid4().hex[:8]}@example.com>"
        thread_id = thread or f"t-{uuid.uuid4().hex[:8]}"
        self.inbox.messages.append({"message_id": message_id, "thread_id": thread_id, "timestamp": _now(), "from": sender,
                                    "to": [self.inbox_address], "subject": "Hello", "preview": text})
        return {"external_id": message_id, "thread": thread_id}

    def sent(self) -> list[dict]:
        return list(self.inbox.outbox)
