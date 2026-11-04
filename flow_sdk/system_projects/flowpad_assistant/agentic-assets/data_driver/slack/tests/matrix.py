"""The ``slack`` source's case in the data source matrix, and the ``Double`` it is built on: a stateful
Slack over a loopback socket, read and posted to with a doubled connector token."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

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

    def __init__(self, *, channel: str = CHANNEL, everything: bool = False):
        """One channel read as a bot, or — ``everything`` — every conversation the person is in through
        their own app (a user token; the row names no channel)."""
        self.channel = channel
        self.slack = _FakeSlack()
        self.slack.channels = {channel: []}
        self.config: dict = {"team_id": TEAM, "user_id": _FakeSlack.me} if everything else {"channel": channel}
        self.fields: dict = {"account_key": TEAM}
        # Keyed as the manifest's `auth.vars` (the `slack_channel` credential): what a planted
        # credential carries, and what the driver reads as the token it acts with.
        self.secrets: dict = (
            {"SLACK_USER_TOKEN": "xoxp-test"} if everything else {"SLACK_BOT_TOKEN": "xoxb-test"}
        )
        self._server = None

    def __enter__(self) -> "Double":
        self._server = local_http_server(self.slack)
        self.config["base_url"] = self._server.__enter__()
        return self

    def __exit__(self, *exc) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.__exit__(*exc)

    async def credentials(self, _row) -> ResolvedSecrets:
        """The in-process stand-in for ``DataDriver.credentials_for``: the bot token, as the credential holds it."""
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def deliver(self, text: str, *, sender: str, thread: str | None = None, files=(), reactions: dict | None = None, channel: str = "") -> dict:
        """A message ``sender`` writes into the channel now (its ts is the wall clock, later than any
        ts handed out so far): the next ``conversations.history`` returns it. ``files`` are paths or
        ``(name, bytes)`` pairs it carries; ``reactions`` is ``{slack name: [user, ...]}`` already on it.
        ``channel`` is another conversation of the person's (a DM ``D…``, a group ``G…``) — everything mode."""
        pairs = tuple((Path(f).name, Path(f).read_bytes()) if isinstance(f, (str, Path)) else tuple(f) for f in files)
        self.slack.channels.setdefault(channel or self.channel, [])
        message = self.slack.arrive(channel or self.channel, text, user=sender, thread_ts=thread, files=pairs, reactions=reactions)
        return {
            "external_id": message["ts"],
            "thread": message.get("thread_ts") or message["ts"],
            "files": [f["id"] for f in message.get("files") or ()],
        }

    def react(self, external_id: str, name: str, *, sender: str) -> None:
        """``sender`` puts reaction ``name`` (Slack's name, ``thumbsup``) on a message. Polling reports it
        only while that message is still unread — deliver, react, then traverse."""
        message = self.slack.message(self.channel, external_id)
        reactions = message.setdefault("reactions", [])
        entry = next((r for r in reactions if r["name"] == name), None)
        if entry is None:
            reactions.append(entry := {"name": name, "users": [], "count": 0})
        if sender not in entry["users"]:
            entry["users"].append(sender)
        entry["count"] = len(entry["users"])

    def reactions(self, external_id: str) -> dict[str, list[str]]:
        """``{slack name: [user, ...]}`` on a message now — ours are the bot's (``_FakeSlack.me``)."""
        return {r["name"]: list(r["users"]) for r in self.slack.message(self.channel, external_id).get("reactions") or ()}

    def push(self, external_id: str, *, channel: str = "") -> dict:
        """What the hub hands this row for a message Slack posted to the person's app: ``{"team_id", "event"}``,
        the event as Slack sends it (``channel_type`` by the conversation's kind)."""
        where = channel or self.channel
        message = self.slack.message(where, external_id)
        kind = {"D": "im", "G": "mpim"}.get(where[0], "channel")
        return {"team_id": TEAM, "event": {**message, "channel": where, "channel_type": kind}}

    def sent(self) -> list[dict]:
        """Every ``chat.postMessage`` and completed upload the double accepted, oldest first; an
        upload's entry carries ``files``: its ``(name, bytes)`` pairs."""
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
