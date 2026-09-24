"""The ``cloud_email`` source's case in the data source matrix, and its two doubles.

``Double`` is the in-process mailbox (``_Mailbox``) handed to the source through ``build``: what a
pytest uses. ``HubDouble`` is the same shape over the hub's own mailbox provider (a second, outsider
mailbox writes to the agent's address and reads its replies): what a doubles process serving a
RUNNING backend uses — a hub mailbox has no loopback server to fake, the hub IS the transport.
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from .test_cloud_email_source import ADDRESS, AGENT_ID, LIST_ITEM, CloudEmailSource, _Mailbox


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Double:
    """cloud_email as a test double: an in-process mailbox, an inbound you can inject, the replies it saw."""

    provider = "cloud_email"
    #: An agent's address by definition (``identity_config_key = agent_id``): no user-owned source.
    agent_only = True
    #: The stranger who writes in.
    sender = "alice@example.com"

    def __init__(self, *, agent_id: str = AGENT_ID, address: str = ADDRESS) -> None:
        self.mailbox = _Mailbox([])
        self.config = {"agent_id": agent_id, "address": address}
        self.fields = {"account_key": address}
        self.secrets: dict = {}  # provisioned by the hub: nothing to plant
        self._original_build = None
        self._delivered = 0

    def config_for(self, owner) -> dict:
        """The config of a source ``owner`` (an agent ``TypeId``) reads with: its own agent id."""
        return {**self.config, "agent_id": str(owner.id)}

    def __enter__(self) -> "Double":
        mailbox = self.mailbox
        self._original_build = CloudEmailSource.__dict__["build"]
        CloudEmailSource.build = classmethod(lambda cls, binding: cls(binding, mailbox=mailbox))  # type: ignore[method-assign]
        return self

    def __exit__(self, *exc) -> None:
        if self._original_build is not None:
            CloudEmailSource.build = self._original_build  # type: ignore[method-assign]

    async def credentials(self, _row):
        from flow_sdk.sources.credentials import Credentials  # noqa: PLC0415

        return Credentials()

    def deliver(self, text: str, *, sender: str, thread: str | None = None, subject: str = "Round trip") -> dict:
        self._delivered += 1
        message_id = f"<in-{self._delivered}-{uuid.uuid4().hex[:8]}@mail.example>"
        thread_id = thread or f"t-{uuid.uuid4().hex[:8]}"
        self.mailbox.messages.append({
            **LIST_ITEM, "message_id": message_id, "thread_id": thread_id, "inbox_id": self.config["address"],
            "sender": {"address": sender, "name": sender.split("@")[0].title()},
            "to": [{"address": self.config["address"], "name": None}],
            "subject": subject, "preview": text[:40], "text": text, "timestamp": _now(), "in_reply_to": None,
        })
        return {"external_id": message_id, "thread": thread_id}

    def sent(self) -> list[dict]:
        out = []
        for call in self.mailbox.calls:
            if call[0] == "send":
                body = call[2]
                out.append({"to": (body.get("to") or [None])[0], "text": body.get("text"), "thread": None, "external_id": None})
            elif call[0] == "reply":
                body = call[3]
                out.append({"to": None, "text": body.get("text"), "thread": call[2], "external_id": None})
        return out


class HubDouble:
    """The same shape over the hub's mailbox provider: an OUTSIDER mailbox writes to the agent's address
    and reads what the agent sent back. Needs a hub with the agent-mailbox capability on and an instance
    that is cloud-logged-in (``get_agent_mailbox_driver`` reads that login)."""

    provider = "cloud_email"
    agent_only = True

    def __init__(self, *, agent_id: str, address: str) -> None:
        self.config = {"agent_id": agent_id, "address": address}
        self.fields = {"account_key": address}
        self.outsider_id: str = ""
        self.outsider_address: str = ""

    @property
    def sender(self) -> str:
        return self.outsider_address

    async def open(self, backend_url: str) -> "HubDouble":
        """Allocate the outsider's mailbox through the INSTANCE (a local Agent of its own, provisioned
        on the hub by the backend's own login — never a second hub login, which would rotate the
        instance's token)."""
        import httpx  # noqa: PLC0415

        self._backend = backend_url.rstrip("/")
        self.outsider_id = str(uuid.uuid4())
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{self._backend}/api/v1/graph/agent",
                                  json={"id": self.outsider_id, "name": f"matrix outsider {self.outsider_id[:8]}", "worker_type": "claude"})
            r.raise_for_status()
            r = await client.post(f"{self._backend}/api/v1/graph/agent/{self.outsider_id}/allocate_mailbox", json={})
            r.raise_for_status()
            data = r.json().get("data") or {}
            if r.json().get("status") != "SUCCESS":
                raise RuntimeError(f"outsider mailbox: {r.json().get('message')}")
        self.outsider_address = str(((data.get("mailbox") or {}).get("address")) or "")
        return self

    async def close(self) -> None:
        import httpx  # noqa: PLC0415

        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        try:
            await get_agent_mailbox_driver().delete_mailbox(self.outsider_id)
        except Exception:  # noqa: BLE001 — a second DELETE answers 404
            pass
        async with httpx.AsyncClient(timeout=30) as client:
            await client.delete(f"{self._backend}/api/v1/graph/agent/{self.outsider_id}")

    async def deliver(self, text: str, *, sender: str = "", thread: str | None = None, subject: str = "Round trip") -> dict:
        """The outsider writes to the agent: a new email, or with ``thread`` (a delivery's own) a reply
        to the newest message of that thread in the outsider's mailbox — as a person continues one."""
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        driver = get_agent_mailbox_driver()
        if thread:
            page = await driver.list_messages(self.outsider_id)
            ours = sorted((m for m in (page or {}).get("messages") or [] if str(m.get("thread_id") or "") == thread),
                          key=lambda m: str(m.get("timestamp") or ""))
            if ours:
                out = await driver.reply(self.outsider_id, str(ours[-1].get("message_id")), {"text": text})
                return {"external_id": str(out.get("message_id") or ""), "thread": str(out.get("thread_id") or thread),
                        "sender": self.outsider_address}
        out = await driver.send(self.outsider_id, {"to": self.config["address"], "subject": subject, "text": text})
        return {"external_id": str(out.get("message_id") or ""), "thread": str(out.get("thread_id") or ""), "sender": self.outsider_address}

    async def sent(self) -> list[dict]:
        """Every message the agent's address sent to the outsider, oldest first."""
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        page = await get_agent_mailbox_driver().list_messages(self.outsider_id)
        wanted = self.config["address"].strip().lower()
        rows = [m for m in (page or {}).get("messages") or []
                if str((m.get("sender") or {}).get("address") or "").strip().lower() == wanted]
        rows.sort(key=lambda m: str(m.get("timestamp") or ""))
        return [{"to": self.outsider_address, "text": m.get("text") or m.get("preview") or "", "thread": m.get("thread_id"),
                 "external_id": m.get("message_id")} for m in rows]


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        double.deliver("Hello there, this is the truncated preview's full body, well past the cut.", sender="joe@example.com")
        yield {
            "config": dict(double.config),
            "fields": dict(double.fields),
            "min_items": 1,
            "send": {"to": "someone@example.com", "text": "matrix send", "subject": "Matrix"},
            "double": double,
        }
